// A cross-process lock built on mkdir (atomic on every filesystem we target).
// Hooks for parallel tool calls run at the same time and must not overwrite each
// other's session state.
//
// The holder writes its pid into the lock, so a lock whose holder died is taken
// over within seconds (ABANDONED_STALE_MS); a lock whose holder is alive is taken over only after STALE_MS,
// which is longer than anything a hook does while holding it (the pause
// snapshot's git work is budgeted at 15 s). A waiter gives up after WAIT_MS and
// goes on unlocked (fail open — a hook must answer within the agent's timeout,
// 10–15 s for the after-tool / stop / session-start hooks); the release function
// then reports `acquired: false` so the caller merges instead of overwriting
// (hook/state.mjs saveSessionUnlocked, which locks again just for that write).
import fs from 'node:fs';
import path from 'node:path';

const STALE_MS = 60_000;
// Two waits fit in the agents' 10–15 s hook timeouts: the hook's own (WAIT_MS), and,
// when it ran unlocked, one more for its short merge-and-save (SAVE_WAIT_MS).
const WAIT_MS = 6_000;
export const SAVE_WAIT_MS = 3_000;
const OWNER = 'owner.json';

// On Windows, mkdir on a directory another process is deleting right now fails with
// EPERM / EACCES / EBUSY instead of EEXIST. That is contention, not a broken disk: wait and retry.
const isContention = (error) => error.code === 'EEXIST'
	|| (process.platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes(error.code));

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function pidAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return true; // unknown: let the age decide
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code === 'EPERM';
	}
}

/** The lock's owner, or null when it has none. A momentarily unreadable owner file (Windows) is read again. */
function readOwner(dir) {
	for (let attempt = 0; ; attempt += 1) {
		try {
			return JSON.parse(fs.readFileSync(path.join(dir, OWNER), 'utf8'));
		} catch (error) {
			if (process.platform !== 'win32' || !TRANSIENT.has(error.code) || attempt >= 20) return null;
			pauseSync(2);
		}
	}
}

function writeOwner(dir) {
	for (let attempt = 0; ; attempt += 1) {
		try {
			fs.writeFileSync(path.join(dir, OWNER), JSON.stringify({ pid: process.pid, at: Date.now() }));
			return true;
		} catch (error) {
			if (process.platform !== 'win32' || !TRANSIENT.has(error.code) || attempt >= 20) return false;
			pauseSync(2);
		}
	}
}

// A lock whose owner is gone (or that has no owner file) is broken only after this
// grace. On Windows a released lock lingers for a moment — a deleted file or folder
// another process still has open is only marked for deletion — still naming its
// owner, whose process may have exited already. Breaking such a lock at once let two
// hooks hold the lock together; a genuinely abandoned one simply waits 2 s longer.
const ABANDONED_STALE_MS = 2_000;
// The guard that serializes breaking a stale lock is held for milliseconds.
const GUARD_STALE_MS = 5_000;
const REMOVE_RETRY_MS = 1_000;
const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']);
const pauseSync = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/** Whether the lock at `dir` belongs to nobody any more. Throws when it is gone (released meanwhile). */
function isStale(dir, staleMs, now) {
	const age = now - fs.statSync(dir).mtimeMs;
	const owner = readOwner(dir);
	const abandoned = !owner || (owner.pid !== process.pid && !pidAlive(owner.pid));
	if (abandoned) return age > Math.min(ABANDONED_STALE_MS, staleMs);
	return age > staleMs;
}

/**
 * Removes a lock directory. On Windows a file or directory another process has
 * open is only marked for deletion, so the removal is retried briefly.
 */
function removeLockDir(dir) {
	const deadline = Date.now() + REMOVE_RETRY_MS;
	let delay = 2;
	for (;;) {
		try {
			fs.rmSync(path.join(dir, OWNER), { force: true });
			fs.rmdirSync(dir);
			return true;
		} catch (error) {
			if (error.code === 'ENOENT') return true;
			if (process.platform !== 'win32' || !TRANSIENT.has(error.code) || Date.now() > deadline) return false;
			pauseSync(delay);
			delay = Math.min(delay * 2, 50);
		}
	}
}

/**
 * Breaks a stale lock — under a guard, re-checking that it is still stale, so
 * two waiters that both judged it stale cannot both break it: the second would
 * otherwise remove the fresh lock the first had just taken, and both would hold it.
 */
function breakLock(dir, staleMs) {
	const guard = `${dir}.break`;
	try {
		fs.mkdirSync(guard);
	} catch {
		// Another waiter is breaking it; clear a guard whose breaker died.
		try { if (Date.now() - fs.statSync(guard).mtimeMs > GUARD_STALE_MS) removeLockDir(guard); } catch { /* gone */ }
		return;
	}
	try {
		if (isStale(dir, staleMs, Date.now())) removeLockDir(dir);
	} catch {
		// Released meanwhile: nothing to break.
	} finally {
		removeLockDir(guard);
	}
}

const unlocked = () => {
	const release = () => {};
	release.acquired = false;
	return release;
};

/**
 * Resolves to a release function (`release.acquired` says whether the lock was
 * really taken); after `waitMs` it resolves unlocked rather than hang the hook.
 */
export async function acquireLock(file, { waitMs = WAIT_MS, staleMs = STALE_MS } = {}) {
	const dir = `${file}.lock`;
	fs.mkdirSync(path.dirname(dir), { recursive: true });
	const deadline = Date.now() + waitMs;
	let delay = 5;
	for (;;) {
		try {
			fs.mkdirSync(dir);
			if (!writeOwner(dir)) {
				// A lock without an owner reads as stale within seconds: do not hold one.
				removeLockDir(dir);
				return unlocked();
			}
			let released = false;
			const release = () => {
				if (released) return;
				released = true;
				// Never remove a lock someone else took over after judging ours stale.
				const owner = readOwner(dir);
				if (owner && owner.pid !== process.pid) return;
				removeLockDir(dir);
			};
			release.acquired = true;
			return release;
		} catch (error) {
			if (!isContention(error)) return unlocked();
			try {
				if (isStale(dir, staleMs, Date.now())) {
					breakLock(dir, staleMs);
					await sleep(1 + Math.floor(Math.random() * 5));
					continue;
				}
			} catch {
				// The holder just released it (or it is mid-delete): try again after a short pause.
				if (Date.now() > deadline) return unlocked();
				await sleep(delay);
				continue;
			}
			if (Date.now() > deadline) return unlocked();
			await sleep(delay + Math.floor(Math.random() * delay)); // jitter: waiters do not retry in lockstep
			delay = Math.min(delay * 2, 50);
		}
	}
}
