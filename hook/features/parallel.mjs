// Features `shared-tree`, `inputs` and `wait`: several agents on one project.
//
// The server makes sure two workers never hold one task (an atomic claim). What it
// cannot see is the computer: two agents in ONE folder share one branch and one set
// of files, a task's dependencies may sit on branches its worker has not merged, and
// a worker that finds every ready task taken would simply stop. These three close that.
import { repoKey } from '../../lib/paths.mjs';
import { isAlive } from '../../lib/processTree.mjs';
import { sessionIsLive } from './workerId.mjs';

const NONE = Object.freeze({ type: 'none' });

/** How long `int wait` waits at most per call: under the shell-tool time limits agents use. */
export const WAIT_STEP_SEC = 240;
/** After this long waiting on other workers, the agent is told to report to the user instead. */
export const MAX_WAIT_MS = 60 * 60_000;
/** A no-work answer older than this no longer makes a stop worth questioning. */
const WAIT_FRESH_MS = 15 * 60_000;
/** The claimTask answers that mean "work exists, but other workers hold what can start now". */
const WAIT_REASONS = new Set(['all_claimed', 'awaiting_completion']);

const STARTS_WORK = (name, args) => name === 'claimTask' || (name === 'updateTask' && args?.statusState === 'in_progress');

const liveClaims = (session, now) => Object.values(session.claims ?? {}).filter((claim) => !claim.expiresAt || claim.expiresAt > now);

/** The working tree a session works in, as one comparable key (null outside a repository). */
export const treeKey = (root) => (root ? repoKey(root) : null);

/**
 * `shared-tree`, before a claim: another live session holds a task in this same
 * working tree. Two agents in one folder share one HEAD, index and set of files —
 * a `git switch` by one moves the other's next commit, `git add -A` takes the
 * other's half-done files, and each test run sees the other's unfinished code. Refused
 * once, naming the fix (a worktree per agent); a second claim goes through, so a
 * person who chose to share the folder is never stuck.
 */
export function sharedTreeDecision(session, others, { name, args = {} }, { root, now, alive = isAlive }) {
	if (!STARTS_WORK(name, args)) return NONE;
	const here = treeKey(root);
	if (!here) return NONE;
	// Taking back a task this session already holds is not a second worker in the folder.
	if (args.taskId && session.claims?.[String(args.taskId)]) return NONE;
	const other = others.find((candidate) => candidate.root === here
		&& candidate.workerId !== session.workerId
		&& liveClaims(candidate, now).length > 0
		&& sessionIsLive(candidate, now, alive));
	if (!other) return NONE;
	session.sharedTreeAllowed = session.sharedTreeAllowed ?? {};
	const key = `${other.sessionId}:${here}`;
	if (session.sharedTreeAllowed[key]) return NONE;
	session.sharedTreeAllowed[key] = now;
	const held = liveClaims(other, now)[0];
	return {
		type: 'deny',
		message:
			`Introsio: another live ${other.agent ?? 'agent'} session (workerId ${other.workerId ?? held.workerId ?? '?'}) is working on "${held.title}" in this same folder (${root}). ` +
			'Two agents in one working tree share one branch and one set of files: commits land on each other\'s branches, `git add` takes the other\'s half-done files, and each test run sees the other\'s unfinished code.\n' +
			'Stop and ask the user to give this agent its own worktree — in a terminal: `int worktree add <name>` — and to start it in the folder that prints. ' +
			'If the user already chose to share this folder, call claimTask again and it goes through.',
	};
}

/**
 * `inputs`, after a claim: the branches of the tasks this one builds on
 * (`inputs[].outcome.branch`) that are not in the branch the work starts from yet,
 * with the command that brings each in. Without it a dependent task starts from the
 * default branch and simply does not have the code it builds on. github mode compares
 * with the default branch (each task branches off it); local mode with HEAD.
 */
export function inputsNote({ git, data, mode }) {
	const inputs = (Array.isArray(data?.inputs) ? data.inputs : [])
		.filter((input) => typeof input?.outcome?.branch === 'string' && input.outcome.branch.trim());
	if (inputs.length === 0 || !git.root()) return null;
	const github = mode === 'github';
	const defaultBranch = data.repository?.defaultBranch ?? git.defaultBranch();
	// A task being taken up again already has its branch checked out (or recorded): compare with HEAD.
	const continuing = data.alreadyHeld === true || !!data.resumedFrom || !!data.resumedPause || !!data.task?.outcome?.branch;
	let base = null;
	let label = null;
	if (github && defaultBranch && !continuing) {
		base = git.resolve(`refs/remotes/origin/${defaultBranch}`) ?? git.resolve(`refs/heads/${defaultBranch}`);
		label = `the default branch "${defaultBranch}"`;
	}
	if (!base) {
		base = git.head();
		const branch = git.branch();
		label = branch && branch !== 'HEAD' ? `your branch "${branch}"` : 'your HEAD';
	}
	if (!base) return null;
	const lines = [];
	const seen = new Set();
	for (const input of inputs) {
		const branch = input.outcome.branch.trim();
		if (seen.has(branch)) continue;
		seen.add(branch);
		const title = input.title ?? input.taskId ?? branch;
		const local = git.resolve(`refs/heads/${branch}`);
		const remote = git.resolve(`refs/remotes/origin/${branch}`);
		// github mode trusts what was pushed; local mode the branch in this repository (every worktree shares it).
		const [sha, ref] = github ? (remote ? [remote, `origin/${branch}`] : [local, branch]) : (local ? [local, branch] : [remote, `origin/${branch}`]);
		if (!sha) {
			lines.push(github
				? `  - "${title}": branch ${branch} is not on this computer yet — git fetch origin ${branch}, then git merge --no-edit origin/${branch}`
				: `  - "${title}": branch ${branch} is not in this repository (another clone?) — ask the user, or build from its outcome`);
			continue;
		}
		if (git.isAncestor(sha, base)) continue;
		lines.push(`  - "${title}": git merge --no-edit ${ref}`);
	}
	if (lines.length === 0) return null;
	const start = github && !continuing ? `Run git fetch origin, branch off ${defaultBranch ?? 'the default branch'} for this task, then merge these into it before you start` : 'Merge these before you start';
	return `Introsio: "${data.task?.title ?? 'this task'}" builds on work that is not in ${label} yet:\n${lines.join('\n')}\n` +
		`${start}. Resolve any conflict; if you cannot, mark the task blocked and say why.`;
}

const clock = (ms) => new Date(ms).toISOString().slice(11, 16) + ' UTC';
const waitCommand = (waiting) => `int wait ${waiting.retryAfter ? new Date(waiting.retryAfter).toISOString() : '120'}`;

/**
 * `wait`, after claimTask: remember that this worker found no task only because
 * other workers hold the ready work (`all_claimed`), or because tasks report their
 * phase done without being completed (`awaiting_completion`). The first such answer
 * of a wait says what to do; a claim, or any other answer, ends the wait.
 */
export function trackWaiting(session, { name, args = {}, result }, now) {
	if (name !== 'claimTask' || !result?.ok || !result.data) return null;
	const data = result.data;
	if (data.claimed === true || !WAIT_REASONS.has(data.reason) || args.taskId) {
		session.waiting = null;
		return null;
	}
	const projectId = data.project?.id ?? args.projectId ?? null;
	const previous = session.waiting?.projectId === projectId ? session.waiting : null;
	const retryAfter = Date.parse(data.retryAfter ?? '');
	session.waiting = {
		projectId,
		since: previous?.since ?? now,
		at: now,
		retryAfter: Number.isFinite(retryAfter) ? retryAfter : null,
		reason: data.reason,
		reminded: previous?.reminded ?? false,
		overdueNoted: previous?.overdueNoted ?? false,
	};
	const waiting = session.waiting;
	if (now - waiting.since > MAX_WAIT_MS) {
		if (waiting.overdueNoted) return null;
		waiting.overdueNoted = true;
		return `Introsio: you have waited ${Math.round((now - waiting.since) / 60_000)} min for other workers. Tell the user which tasks are still held (claimedTasks) and stop — you may claim again later.`;
	}
	if (previous) return null;
	const done = data.reason === 'awaiting_completion'
		? 'Some tasks report their phase completed but are not completed — if you hold one, completeTask it now. Otherwise their workers will. '
		: '';
	return `Introsio: other workers hold the ready work of this project${waiting.retryAfter ? ` (the first lease ends ${clock(waiting.retryAfter)})` : ''}; each task they finish unlocks more. ${done}` +
		`Don't stop: run \`${waitCommand(waiting)}\` (it returns after at most ${WAIT_STEP_SEC / 60} minutes), then claimTask { projectId, workerId } again, and repeat. ` +
		'Stop only when claimTask answers "complete", "blocked" or "paused", or the user asked you to.';
}

/**
 * `wait`, at stop: no task held, but the last claim found work that other workers
 * are finishing. Sent back once per wait — the user's instruction comes first, and
 * stopping again is taken as a decision.
 */
export function waitStopDecision(session, now) {
	const waiting = session.waiting;
	if (!waiting || waiting.reminded) return NONE;
	if (Object.keys(session.claims ?? {}).length > 0) return NONE;
	if (now - waiting.at > WAIT_FRESH_MS || now - waiting.since > MAX_WAIT_MS) return NONE;
	waiting.reminded = true;
	return {
		type: 'block',
		message:
			'Introsio: other workers are still running tasks of this project, and what they finish unlocks the rest. ' +
			`Unless the user asked you to stop (or to do only part of the project): run \`${waitCommand(waiting)}\`, then claimTask { projectId, workerId } again — ` +
			'stop when it answers "complete", "blocked" or "paused". To stop anyway, just stop again; you will not be asked twice.',
	};
}
