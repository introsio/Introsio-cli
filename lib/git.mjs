// Thin git runner. Every call is synchronous, short, and never throws — a hook
// must answer quickly and a missing repository simply means "no git checks".
import { spawnSync } from 'node:child_process';

export function createGit(cwd) {
	const run = (args, { maxBuffer = 16 * 1024 * 1024 } = {}) => {
		const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer, timeout: 15000 });
		return { ok: result.status === 0, out: (result.stdout ?? '').trimEnd(), err: (result.stderr ?? '').trim() };
	};
	const value = (args) => {
		const result = run(args);
		return result.ok ? result.out : null;
	};
	return {
		cwd,
		run,
		root: () => value(['rev-parse', '--show-toplevel']),
		head: () => value(['rev-parse', 'HEAD']),
		shortHead: () => value(['rev-parse', '--short', 'HEAD']),
		branch: () => value(['rev-parse', '--abbrev-ref', 'HEAD']),
		/** Porcelain status lines, ignoring the kit's own folder. */
		dirty: () => (value(['status', '--porcelain']) ?? '').split('\n').filter((line) => line.trim() && !line.includes('.introsio/')),
		upstream: () => value(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']),
		/** Where a bare `git push` sends the current branch ("origin/main"), honouring push.default. */
		pushTarget: () => value(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{push}']),
		aheadOfUpstream: () => {
			const count = value(['rev-list', '--count', '@{u}..HEAD']);
			return count === null ? null : Number(count);
		},
		defaultBranch: () => {
			const ref = value(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
			if (ref) return ref.replace(/^refs\/remotes\/origin\//, '');
			for (const name of ['main', 'master']) if (value(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])) return name;
			return null;
		},
		/** A diff, or null when it cannot be read whole (callers must not treat that as "no changes"). */
		diff: (args) => {
			const result = run(['diff', '--no-color', '--no-ext-diff', ...args], { maxBuffer: 128 * 1024 * 1024 });
			return result.ok ? result.out : null;
		},
	};
}
