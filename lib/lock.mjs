// A cross-process lock built on mkdir (atomic on every filesystem we target).
// Hooks for parallel tool calls run at the same time and must not overwrite each
// other's session state. A lock older than STALE_MS belongs to a hook that died
// and is taken over.
import fs from 'node:fs';
import path from 'node:path';

const STALE_MS = 10_000;
const WAIT_MS = 4_000;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Resolves to a release function; resolves to a no-op after WAIT_MS (fail open — a hook must answer). */
export async function acquireLock(file, { waitMs = WAIT_MS, staleMs = STALE_MS } = {}) {
	const dir = `${file}.lock`;
	fs.mkdirSync(path.dirname(dir), { recursive: true });
	const deadline = Date.now() + waitMs;
	let delay = 5;
	for (;;) {
		try {
			fs.mkdirSync(dir);
			let released = false;
			return () => {
				if (released) return;
				released = true;
				try { fs.rmdirSync(dir); } catch { /* already gone */ }
			};
		} catch (error) {
			if (error.code !== 'EEXIST') return () => {};
			try {
				if (Date.now() - fs.statSync(dir).mtimeMs > staleMs) {
					fs.rmdirSync(dir);
					continue;
				}
			} catch { continue; }
			if (Date.now() > deadline) return () => {};
			await sleep(delay);
			delay = Math.min(delay * 2, 50);
		}
	}
}
