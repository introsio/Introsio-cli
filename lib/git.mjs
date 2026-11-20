// Thin git runner. Every call is synchronous, short, and never throws — a hook
// must answer quickly and a missing repository simply means "no git checks".
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// The snapshot commit's identity: the user's own may be unset, and it must never look like their work.
const SNAPSHOT_IDENTITY = {
	GIT_AUTHOR_NAME: 'Introsio pause', GIT_AUTHOR_EMAIL: 'pause@introsio.invalid',
	GIT_COMMITTER_NAME: 'Introsio pause', GIT_COMMITTER_EMAIL: 'pause@introsio.invalid',
};

export function createGit(cwd) {
	const run = (args, { maxBuffer = 16 * 1024 * 1024, env = null, timeout = 15000 } = {}) => {
		const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer, timeout, ...(env ? { env: { ...process.env, ...env } } : {}) });
		return { ok: result.status === 0, out: (result.stdout ?? '').trimEnd(), err: (result.stderr ?? '').trim(), timedOut: result.error?.code === 'ETIMEDOUT' };
	};
	const value = (args) => {
		const result = run(args);
		return result.ok ? result.out : null;
	};
	const api = {
		cwd,
		run,
		root: () => value(['rev-parse', '--show-toplevel']),
		/**
		 * The main working tree of this repository: the same as root() in an ordinary
		 * checkout, the original checkout inside a linked worktree (`git worktree add`),
		 * so every worktree of one repository shares its settings. Null for a bare repository.
		 */
		mainRoot: () => {
			const common = value(['rev-parse', '--path-format=absolute', '--git-common-dir'])
				?? (() => {
					const relative = value(['rev-parse', '--git-common-dir']);
					return relative === null ? null : path.resolve(cwd, relative);
				})();
			if (!common) return null;
			return path.basename(common) === '.git' ? path.dirname(common) : value(['rev-parse', '--show-toplevel']);
		},
		/** Linked and main worktrees as { path, branch, head }, main first (`git worktree list --porcelain`). */
		worktrees: () => {
			const text = value(['worktree', 'list', '--porcelain']);
			if (text === null) return [];
			return text.split(/\n\n+/).map((block) => {
				const entry = {};
				for (const line of block.split('\n')) {
					const [key, ...rest] = line.split(' ');
					if (key === 'worktree') entry.path = rest.join(' ');
					else if (key === 'HEAD') entry.head = rest[0];
					else if (key === 'branch') entry.branch = rest.join(' ').replace(/^refs\/heads\//, '');
					else if (key === 'detached') entry.branch = null;
					else if (key === 'bare') entry.bare = true;
				}
				return entry;
			}).filter((entry) => entry.path);
		},
		gitDir: () => value(['rev-parse', '--absolute-git-dir']),
		head: () => value(['rev-parse', '--verify', '--quiet', 'HEAD']),
		shortHead: () => value(['rev-parse', '--short', 'HEAD']),
		branch: () => value(['rev-parse', '--abbrev-ref', 'HEAD']),
		/** Porcelain status lines, ignoring the kit's own folder. */
		dirty: () => (value(['status', '--porcelain']) ?? '').split('\n').filter((line) => line.trim() && !line.includes('.introsio/')),
		/** The paths `dirty()` names (the new name of a rename). */
		dirtyPaths: () => api.dirty().map((line) => line.slice(3).split(' -> ').pop().replace(/^"|"$/g, '')).filter(Boolean),
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
		originUrl: () => value(['remote', 'get-url', 'origin']),
		/** The commit id a ref or name points at, or null. */
		resolve: (name) => value(['rev-parse', '--verify', '--quiet', `${name}^{commit}`]),
		treeOf: (commit) => value(['rev-parse', '--verify', '--quiet', `${commit}^{tree}`]),
		hasCommit: (sha) => run(['cat-file', '-e', `${sha}^{commit}`]).ok,
		isAncestor: (ancestor, descendant) => run(['merge-base', '--is-ancestor', ancestor, descendant]).ok,
		localBranchExists: (name) => run(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]).ok,
		remoteBranchExists: (name) => run(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${name}`]).ok,
		/** Commits in `range` as { sha, author, subject }, newest first (at most `max`). */
		commits: (range, max = 20) => (value(['log', `-n${max}`, '--format=%h%x09%an%x09%s', range]) ?? '')
			.split('\n').filter(Boolean).map((line) => {
				const [sha, author, ...subject] = line.split('\t');
				return { sha, author, subject: subject.join('\t') };
			}),
		/** `git diff --name-status` between two trees/commits as { status, path }. */
		changedBetween: (a, b) => {
			const out = value(['diff', '--name-status', '--no-renames', a, b]);
			if (out === null) return null;
			return out.split('\n').filter(Boolean).map((line) => {
				const [status, ...rest] = line.split('\t');
				return { status: status[0], path: rest.join('\t') };
			});
		},
		updateRef: (ref, sha) => run(['update-ref', ref, sha]).ok,
		deleteRef: (ref) => run(['update-ref', '-d', ref]).ok,
		/** A git operation left half way (merge, rebase …), or null. */
		inProgressOp: () => {
			const dir = api.gitDir();
			if (!dir) return null;
			const has = (name) => fs.existsSync(path.join(dir, name));
			if (has('rebase-merge') || has('rebase-apply')) return 'rebase';
			if (has('MERGE_HEAD')) return 'merge';
			if (has('CHERRY_PICK_HEAD')) return 'cherry-pick';
			if (has('REVERT_HEAD')) return 'revert';
			if (has('BISECT_LOG')) return 'bisect';
			return null;
		},
		/**
		 * The whole working tree as a commit, without touching it, the index or any
		 * branch: tracked changes and untracked files (.gitignore respected), staged
		 * or not. Built in a throwaway index seeded from the real one, so only
		 * changed files are hashed. Returns { commit, tree } or { error }.
		 */
		snapshot: ({ budgetMs = 15000, message = 'introsio pause snapshot' } = {}) => {
			const dir = api.gitDir();
			if (!dir) return { error: 'not a git repository' };
			const started = Date.now();
			const left = () => Math.max(1000, budgetMs - (Date.now() - started));
			const tmpIndex = path.join(os.tmpdir(), `introsio-index-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
			try {
				try { fs.copyFileSync(path.join(dir, 'index'), tmpIndex); } catch { /* a fresh repository has no index yet */ }
				const env = { GIT_INDEX_FILE: tmpIndex, ...SNAPSHOT_IDENTITY };
				const added = run(['add', '-A', '--', ':/'], { env, timeout: left() });
				if (!added.ok) return { error: added.timedOut ? `took longer than ${Math.round(budgetMs / 1000)} s` : (added.err || 'git add failed').slice(0, 200) };
				const tree = run(['write-tree'], { env, timeout: left() });
				if (!tree.ok) return { error: (tree.err || 'git write-tree failed').slice(0, 200) };
				const head = api.head();
				const commit = run(['commit-tree', tree.out, ...(head ? ['-p', head] : []), '-m', message], { env, timeout: left() });
				if (!commit.ok) return { error: (commit.err || 'git commit-tree failed').slice(0, 200) };
				return { commit: commit.out, tree: tree.out };
			} finally {
				try { fs.rmSync(tmpIndex, { force: true }); } catch { /* best effort */ }
			}
		},
	};
	return api;
}
