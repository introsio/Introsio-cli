// Features `test-gate` and `shipped-gate`: what must be true on disk before a claimed task can be completed.
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const tail = (text, lines = 40) => String(text ?? '').trimEnd().split('\n').slice(-lines).join('\n');

/** The repo mode: configured, else github when the claim named a repository, else local. */
export function resolveMode(settings, claim) {
	return settings.mode ?? (claim?.repository ? 'github' : 'local');
}

/**
 * `shipped-gate`: in local mode the work must be committed; in github mode it
 * must also be pushed, off the default branch, with the branch recorded.
 */
export function shippedDecision({ git, settings, claim, args }) {
	const mode = resolveMode(settings, claim);
	if (mode === 'off' || !git.root()) return { type: 'none' };
	const dirty = git.dirty();
	if (dirty.length > 0) {
		const list = dirty.slice(0, 6).map((line) => `  ${line.trim()}`).join('\n');
		return {
			type: 'deny',
			message: `Introsio (${mode} mode): commit your work before completing "${claim.title}" — uncommitted changes:\n${list}${dirty.length > 6 ? `\n  …and ${dirty.length - 6} more` : ''}`,
		};
	}
	if (mode === 'local') return { type: 'none' };

	const branch = git.branch();
	const defaultBranch = claim.repository?.defaultBranch ?? git.defaultBranch();
	if (branch && defaultBranch && branch === defaultBranch) {
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

/** What the gate's verdict depends on: the commit plus every uncommitted change. */
export function workTreeKey(git, command) {
	const hash = crypto.createHash('sha1');
	hash.update(command);
	hash.update(git.head() ?? 'no-head');
	hash.update(git.diff(['HEAD']));
	hash.update(git.run(['ls-files', '--others', '--exclude-standard']).out);
	return hash.digest('hex');
}

export function runGateCommand(command, cwd, timeoutSec) {
	const started = Date.now();
	const result = spawnSync(command, { cwd, shell: true, encoding: 'utf8', timeout: timeoutSec * 1000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, CI: process.env.CI ?? '1' } });
	return {
		ok: result.status === 0,
		code: result.status,
		timedOut: result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGTERM',
		output: tail(`${result.stdout ?? ''}\n${result.stderr ?? ''}`),
		ms: Date.now() - started,
	};
}

/** `test-gate`: the repo's check command must pass on exactly this work tree. Passes are cached by key. */
export function testGateDecision({ git, settings, claim, cache, runGate = runGateCommand, now }) {
	if (!settings.gate) return { type: 'none' };
	const root = git.root();
	if (!root) return { type: 'none' };
	const key = workTreeKey(git, settings.gate);
	if (cache.get(root)?.key === key) return { type: 'none', cached: true };
	const run = runGate(settings.gate, root, settings.gateTimeoutSec);
	if (run.ok) {
		cache.set(root, { key, passedAt: now, ms: run.ms });
		return { type: 'none', ran: true };
	}
	return {
		type: 'deny',
		message: run.timedOut
			? `Introsio: the check "${settings.gate}" did not finish in ${settings.gateTimeoutSec}s, so "${claim.title}" cannot be completed yet. Make it faster or raise the limit (introsio gate set "<cmd>" --timeout <sec>).`
			: `Introsio: "${settings.gate}" failed (exit ${run.code}), so "${claim.title}" cannot be completed. Fix it, then complete again. Last lines:\n${run.output}`,
	};
}
