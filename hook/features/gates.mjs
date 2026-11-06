// Features `test-gate` and `shipped-gate`: what must be true on disk before a claimed task can be completed.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runCommand } from '../../lib/processTree.mjs';
import { relativeInside } from '../../lib/paths.mjs';

/** Agents kill a hook after 900 s (the timeout setup writes); the gate must finish well before. */
export const MAX_GATE_TIMEOUT_SEC = 840;

/** The repo mode: configured, else github when the claim named a repository, else local. */
export function resolveMode(settings, claim) {
	return settings.mode ?? (claim?.repository ? 'github' : 'local');
}

/** Paths from `git status --porcelain` lines ("XY path", "R  old -> new", quoted when unusual). */
export function porcelainPaths(line) {
	const body = line.slice(3);
	const unquote = (value) => (value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1).replace(/\\(.)/g, '$1') : value);
	return body.includes(' -> ') ? body.split(' -> ').map(unquote) : [unquote(body)];
}

/**
 * The files this task is about: what the agent edited in this session plus what
 * it lists in outcome.files. Uncommitted changes elsewhere — the person's own
 * work in progress — are none of the gate's business.
 */
export function taskFiles({ session, args, root }) {
	const files = new Set();
	for (const file of session?.editedFiles ?? []) files.add(file);
	for (const file of args?.outcome?.files ?? []) if (typeof file === 'string' && file.trim()) { const rel = relativeInside(root, file.trim()); if (rel) files.add(rel); }
	return [...files].filter(Boolean);
}

const touches = (dirtyPath, files) => files.some((file) => dirtyPath === file || dirtyPath.startsWith(`${file.replace(/\/$/, '')}/`) || file.startsWith(`${dirtyPath.replace(/\/$/, '')}/`));

/**
 * `shipped-gate`: in local mode the task's work must be committed; in github mode
 * it must also be pushed, off the default branch, with the branch recorded.
 */
export function shippedDecision({ git, settings, claim, args, session }) {
	const mode = resolveMode(settings, claim);
	const root = git.root();
	if (mode === 'off' || !root) return { type: 'none' };
	const dirty = git.dirty();
	const files = taskFiles({ session, args, root });
	const relevant = files.length ? dirty.filter((line) => porcelainPaths(line).some((p) => touches(p, files))) : dirty;
	if (relevant.length > 0) {
		const list = relevant.slice(0, 6).map((line) => `  ${line.trim()}`).join('\n');
		return {
			type: 'deny',
			message: `Introsio (${mode} mode): commit your work before completing "${claim.title}" — uncommitted changes:\n${list}${relevant.length > 6 ? `\n  …and ${relevant.length - 6} more` : ''}` +
				(files.length ? '' : '\nIf some of these are not yours, list exactly the files you changed in outcome.files and only those are checked.'),
		};
	}
	if (mode === 'local') return { type: 'none' };

	const branch = git.branch();
	if (!branch || branch === 'HEAD') {
		return { type: 'deny', message: 'Introsio (github mode): you are on a detached HEAD. Create a branch for the work (git switch -c <name>), push it, then complete.' };
	}
	const defaultBranch = claim.repository?.defaultBranch ?? git.defaultBranch();
	if (defaultBranch && branch === defaultBranch) {
		return { type: 'deny', message: `Introsio (github mode): the work is on the default branch "${branch}". Move it to a branch of its own (git switch -c <name>), push that, then complete.` };
	}
	if (!git.upstream()) {
		return { type: 'deny', message: `Introsio (github mode): branch "${branch}" is not pushed. Run git push -u origin ${branch}, then complete with outcome.branch "${branch}".` };
	}
	const ahead = git.aheadOfUpstream();
	if (ahead && ahead > 0) {
		return { type: 'deny', message: `Introsio (github mode): ${ahead} commit(s) on "${branch}" are not pushed. Push them, then complete.` };
	}
	if (!args.outcome?.branch && !claim.branch) {
		return { type: 'deny', message: `Introsio (github mode): add outcome.branch "${branch}" to the completion so the app can show its pull request.` };
	}
	return { type: 'none' };
}

/**
 * What the gate's verdict depends on: the command, the commit, every tracked
 * change (`git stash create` snapshots them as one object id, whatever their
 * size) and every untracked file (path, size, mtime). Null when any part cannot
 * be read — then nothing is cached and the gate always runs.
 */
export function workTreeKey(git, command) {
	const head = git.head();
	const dirty = git.run(['status', '--porcelain', '--untracked-files=no']);
	// A stash commit carries a timestamp; its tree id is what is deterministic.
	const stash = dirty.ok && dirty.out.trim() ? git.run(['stash', 'create']) : { ok: true, out: '' };
	const snapshot = stash.ok && stash.out.trim() ? git.run(['rev-parse', `${stash.out.trim()}^{tree}`]) : stash;
	const untracked = git.run(['ls-files', '--others', '--exclude-standard', '-z'], { maxBuffer: 64 * 1024 * 1024 });
	if (!dirty.ok || !snapshot.ok || !untracked.ok) return null;
	const root = git.root();
	const hash = crypto.createHash('sha1');
	hash.update(`${command}\0${head ?? 'no-head'}\0${snapshot.out}\0`);
	for (const file of untracked.out.split('\0').filter(Boolean)) {
		let stat = null;
		try { stat = fs.statSync(path.join(root, file)); } catch { /* removed meanwhile */ }
		hash.update(`${file}\0${stat?.size ?? -1}\0${stat?.mtimeMs ?? -1}\0`);
	}
	return hash.digest('hex');
}

export function runGateCommand(command, cwd, timeoutSec) {
	return runCommand(command, { cwd, timeoutSec: Math.min(timeoutSec, MAX_GATE_TIMEOUT_SEC), env: { ...process.env, CI: process.env.CI ?? '1' } });
}

/**
 * `test-gate`, step 1 (cheap, under the session lock): nothing to do, a cached
 * pass, or a plan to run the command.
 */
export function planTestGate({ git, settings, cache }) {
	if (!settings.gate) return null;
	const root = git.root();
	if (!root) return null;
	const key = workTreeKey(git, settings.gate);
	if (key && cache.get(root)?.key === key) return null;
	return { root, key, command: settings.gate, timeoutSec: Math.min(settings.gateTimeoutSec, MAX_GATE_TIMEOUT_SEC) };
}

/** `test-gate`, step 2 (outside the lock — it can take minutes): run it and decide. */
export async function runTestGate(plan, { claim, cache, runGate = runGateCommand, now }) {
	const run = await runGate(plan.command, plan.root, plan.timeoutSec);
	if (run.ok) {
		if (plan.key) cache.set(plan.root, { key: plan.key, passedAt: now, ms: run.ms });
		return { type: 'none', ran: true };
	}
	return {
		type: 'deny',
		message: run.timedOut
			? `Introsio: the check "${plan.command}" did not finish in ${plan.timeoutSec}s, so "${claim.title}" cannot be completed yet. Make it faster or change the limit (int gate set "<cmd>" --timeout <sec>, at most ${MAX_GATE_TIMEOUT_SEC}).`
			: `Introsio: "${plan.command}" failed (exit ${run.code}), so "${claim.title}" cannot be completed. Fix it, then complete again. Last lines:\n${run.output}`,
	};
}
