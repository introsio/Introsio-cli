// Feature `pause`: /introsio-pause and /introsio-resume, made exact (docs/adr/0011-pause-and-resume.md).
//
//   pause  — before pauseTask runs, the working tree is snapshotted as a commit kept under
//            refs/introsio/paused/<taskId> (never pushed, nothing on any branch changes) and the
//            git position the agent reports is checked against the real one; after it succeeds
//            the claim is dropped and ~/.introsio/pauses/<taskId>.json records where the code is.
//   resume — whenever an Introsio answer carries a pause (getTaskById, claimTask's resumedPause),
//            the repository is compared with it here, in code, and the agent gets a verdict:
//            exact | drift | blocked, with the precise differences and the commands that fix them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { introsioDir, repoKey } from '../../lib/paths.mjs';
import { readJsonSafe, writeJson } from '../../lib/jsonFile.mjs';
import { sessionIsLive } from './workerId.mjs';

export const pauseRef = (taskId) => `refs/introsio/paused/${String(taskId).replace(/[^A-Za-z0-9._-]/g, '_')}`;
export const pausesDir = (env) => path.join(introsioDir(env), 'pauses');
const pauseFile = (taskId, env) => path.join(pausesDir(env), `${String(taskId).replace(/[^A-Za-z0-9._-]/g, '_')}.json`);

export const readLocalPause = (taskId, env) => readJsonSafe(pauseFile(taskId, env), null);

export function listLocalPauses(env) {
	let names = [];
	try { names = fs.readdirSync(pausesDir(env)).filter((name) => name.endsWith('.json') && !name.includes('.tmp')); } catch { return []; }
	return names.map((name) => readJsonSafe(path.join(pausesDir(env), name), null)).filter(Boolean);
}

export function removeLocalPause(taskId, env) {
	try { fs.rmSync(pauseFile(taskId, env), { force: true }); } catch { /* best effort */ }
}

const short = (sha) => (sha ? String(sha).slice(0, 10) : '?');
const MAX_LISTED = 12;
const list = (items) => (items.length > MAX_LISTED ? [...items.slice(0, MAX_LISTED), `… and ${items.length - MAX_LISTED} more`] : items);

/** Where the repository stands right now, or null outside a repository. */
export function gitFacts(git) {
	const root = git.root();
	if (!root) return null;
	const branch = git.branch();
	return {
		root,
		branch: branch && branch !== 'HEAD' ? branch : null,
		head: git.head(),
		dirtyFiles: git.dirtyPaths(),
		inProgressOp: git.inProgressOp(),
	};
}

/**
 * Before pauseTask: take the snapshot and check what the agent says about git.
 * The snapshot is kept in the session until the pause succeeds (a refused pause
 * leaves no ref behind). A wrong or missing git position is refused ONCE with
 * the exact values to send — models guess commit ids — and goes through after.
 */
export function pauseDecision({ git, args = {}, session, now, budgetMs }) {
	const taskId = String(args.taskId ?? '');
	if (!taskId) return { type: 'none' };
	const facts = gitFacts(git);
	if (!facts) return { type: 'none' };
	const snap = git.snapshot({ budgetMs });
	session.pendingPause = session.pendingPause ?? {};
	// The same tree as the snapshot already named (to the agent, or in what it sends): keep that commit,
	// so the server's copy and the local ref name one snapshot (a new commit differs only by its time).
	const named = [args.handoff?.git?.snapshot, session.pendingPause[taskId]?.snapshot].filter(Boolean);
	for (const candidate of named) {
		if (snap.tree && git.treeOf(candidate) === snap.tree) { snap.commit = git.resolve(candidate); break; }
	}
	session.pendingPause[taskId] = {
		at: now, root: facts.root, branch: facts.branch, head: facts.head, dirtyFiles: facts.dirtyFiles.slice(0, 200),
		inProgressOp: facts.inProgressOp, snapshot: snap.commit ?? null, tree: snap.tree ?? null, snapshotError: snap.error ?? null,
	};

	const claim = session.claims?.[taskId];
	const taskFiles = new Set([...(session.editedFiles ?? []), ...(claim?.files ?? [])]);
	if (args.release === true) {
		const unsaved = facts.dirtyFiles.filter((file) => taskFiles.size === 0 || taskFiles.has(file));
		if (unsaved.length > 0) {
			return {
				type: 'deny',
				message: `Introsio: release: true hands this task to any worker, but its work is not committed:\n${list(unsaved).map((file) => `  - ${file}`).join('\n')}\n` +
					'Commit it on the task branch (and push it, in github mode) and record outcome.branch, then pause again — or pause without release so it waits for your resume.',
			};
		}
	}

	const sent = args.handoff?.git ?? null;
	const wrong = [];
	if (!sent) wrong.push('handoff.git is missing');
	else {
		if ((sent.branch || null) !== facts.branch && !(sent.branch === 'HEAD' && !facts.branch)) wrong.push(`branch is "${facts.branch ?? '(detached HEAD)'}", not "${sent.branch ?? ''}"`);
		if (facts.head && (!sent.head || !facts.head.startsWith(String(sent.head).toLowerCase()))) wrong.push(`HEAD is ${facts.head}, not ${sent.head ?? '(missing)'}`);
	}
	const key = `${taskId}:${facts.branch}:${facts.head}`;
	if (wrong.length > 0 && session.pauseCorrected !== key) {
		session.pauseCorrected = key;
		const exact = {
			...(facts.branch ? { branch: facts.branch } : {}),
			...(facts.head ? { head: facts.head } : {}),
			...(snap.commit ? { snapshot: snap.commit } : {}),
			dirtyFiles: facts.dirtyFiles.slice(0, 200),
			...(facts.dirtyFiles.length > 200 ? { truncated: true } : {}),
			...(facts.inProgressOp ? { inProgressOp: facts.inProgressOp } : {}),
		};
		return {
			type: 'deny',
			message: `Introsio: the pause would record the wrong git position (${wrong.join('; ')}). Call pauseTask again with handoff.git exactly:\n${JSON.stringify(exact)}`,
		};
	}
	return { type: 'none' };
}

/** After a successful pauseTask: keep the snapshot under its ref and write the local record. */
export function recordPause({ git, session, args = {}, data = {}, now, env, gatePassed = null }) {
	const taskId = String(args.taskId ?? data.task?.id ?? '');
	if (!taskId) return null;
	const pending = session.pendingPause?.[taskId] ?? null;
	if (session.pendingPause) delete session.pendingPause[taskId];
	const claim = session.claims?.[taskId];
	let snapshotKept = false;
	if (pending?.snapshot && git) snapshotKept = git.updateRef(pauseRef(taskId), pending.snapshot);
	const record = {
		taskId,
		title: data.task?.title ?? claim?.title ?? taskId,
		projectId: claim?.projectId ?? null,
		workerId: args.workerId ?? claim?.workerId ?? session.workerId ?? null,
		agent: session.agent ?? null,
		sessionId: session.sessionId,
		host: os.hostname(),
		at: new Date(now).toISOString(),
		release: args.release === true,
		note: typeof args.handoff?.note === 'string' ? args.handoff.note.slice(0, 600) : null,
		...(pending ? {
			root: pending.root,
			repoKey: repoKey(pending.root),
			origin: git?.originUrl() ?? null,
			branch: pending.branch,
			head: pending.head,
			dirtyFiles: pending.dirtyFiles,
			inProgressOp: pending.inProgressOp,
			snapshot: snapshotKept ? pending.snapshot : null,
			tree: snapshotKept ? pending.tree : null,
			ref: snapshotKept ? pauseRef(taskId) : null,
			snapshotError: pending.snapshotError ?? (pending.snapshot && !snapshotKept ? 'could not write the snapshot ref' : null),
			gatePassed,
		} : {}),
	};
	writeJson(pauseFile(taskId, env), record);
	session.paused = { ...(session.paused ?? {}), [taskId]: { at: now, title: record.title } };
	return record;
}

/** After a task is finished: its snapshot and local record have done their job. */
export function forgetPause({ git, taskId, env }) {
	const local = readLocalPause(taskId, env);
	if (local?.ref && git) git.deleteRef(local.ref);
	else if (git) git.deleteRef(pauseRef(taskId));
	removeLocalPause(taskId, env);
}

/** The task id an Introsio answer is about, and the pause it carries (if it carries one). */
export function pauseInAnswer(name, data) {
	if (!data || typeof data !== 'object') return null;
	if (name === 'getTaskById' && data.pause && data.id) return { taskId: String(data.id), pause: data.pause, resumed: false };
	if (name === 'claimTask' && data.claimed === true && data.resumedPause && data.task?.id) {
		return { taskId: String(data.task.id), pause: data.resumedPause, resumed: true, changed: data.taskChangedSincePause === true };
	}
	return null;
}

/**
 * The resume check — every comparison between where the work was paused and
 * the repository now, decided here and not by the model.
 *
 * @returns {{ verdict: 'exact'|'drift'|'blocked', lines: string[], restore: string|null }}
 */
export function resumeReport({ git, taskId, pause = {}, local = null, others = [], now = Date.now(), alive, taskChanged = false, gatePassedNow = null }) {
	const blocked = [];
	const drift = [];
	const ok = [];
	let restore = null;
	const pausedGit = { ...(pause.git ?? {}) };
	// The local record is exact (it was read from git by the hook); the server's copy was typed by the agent.
	for (const field of ['branch', 'head', 'snapshot', 'dirtyFiles']) if (local?.[field] !== undefined && local[field] !== null) pausedGit[field] = local[field];
	const facts = git ? gitFacts(git) : null;

	// 7. Another live session on this computer holds or is working this task.
	const holder = others.find((other) => other.claims?.[taskId] && sessionIsLive(other, now, alive));
	if (holder) blocked.push(`another ${holder.agent ?? 'agent'} session on this computer (workerId ${holder.workerId ?? '?'}) is working this task right now — resume there, or stop that session first.`);

	if (!facts) {
		if (pausedGit.branch || pausedGit.head) drift.push('this folder is not a git repository, but the task was paused in one — open the repository it was paused in.');
	} else {
		// 1. Same repository.
		if (local?.repoKey && repoKey(facts.root) !== local.repoKey) {
			const sameOrigin = local.origin && git.originUrl() === local.origin;
			(sameOrigin ? drift : blocked).push(`the task was paused in ${local.root}, and this is ${facts.root}${sameOrigin ? ' (another clone of the same repository)' : ''}.`);
		}
		// 6. A git operation left half way.
		if (facts.inProgressOp) blocked.push(`a git ${facts.inProgressOp} is in progress — finish or abort it (git ${facts.inProgressOp === 'bisect' ? 'bisect reset' : `${facts.inProgressOp} --abort`}) before resuming.`);

		// 2. Branch.
		if (pausedGit.branch && facts.branch !== pausedGit.branch) {
			if (git.localBranchExists(pausedGit.branch)) drift.push(`you are on ${facts.branch ?? 'a detached HEAD'}; the work is on ${pausedGit.branch} → git switch ${pausedGit.branch}`);
			else if (git.remoteBranchExists(pausedGit.branch)) drift.push(`branch ${pausedGit.branch} exists only on origin → git switch --track origin/${pausedGit.branch}`);
			else blocked.push(`branch ${pausedGit.branch} no longer exists here or on origin (git fetch first if it was pushed elsewhere).`);
		} else if (pausedGit.branch) ok.push(`branch ${pausedGit.branch}`);

		// 3. HEAD.
		if (pausedGit.head && facts.head && facts.branch === (pausedGit.branch ?? facts.branch)) {
			if (!git.hasCommit(pausedGit.head)) drift.push(`commit ${short(pausedGit.head)} (HEAD when paused) is not in this repository → git fetch, or resume on the computer it was paused on${pause.host ? ` (${pause.host})` : ''}.`);
			else if (facts.head === pausedGit.head || facts.head.startsWith(pausedGit.head)) ok.push(`HEAD ${short(facts.head)} unchanged`);
			else if (git.isAncestor(pausedGit.head, facts.head)) {
				const added = git.commits(`${pausedGit.head}..${facts.head}`);
				drift.push(`${added.length} commit(s) were added since the pause — read them before continuing:\n${list(added.map((c) => `    ${c.sha} ${c.author}: ${c.subject}`)).join('\n')}`);
			} else if (git.isAncestor(facts.head, pausedGit.head)) {
				drift.push(`the branch moved back: HEAD is ${short(facts.head)}, behind ${short(pausedGit.head)} (reset?). The paused commit still exists: git reset --keep ${short(pausedGit.head)} if that was not intended.`);
			} else {
				drift.push(`history was rewritten since the pause (rebase or force push): ${short(pausedGit.head)} is no longer on this branch. Check git log before continuing.`);
			}
		}

		// 4. The working tree against the snapshot.
		const snapshot = pausedGit.snapshot && git.hasCommit(pausedGit.snapshot) ? pausedGit.snapshot : (local?.ref ? git.resolve(local.ref) : null);
		const pausedDirty = Array.isArray(pausedGit.dirtyFiles) ? pausedGit.dirtyFiles : [];
		if (snapshot) {
			const current = git.snapshot({ message: 'introsio resume check' });
			if (current.error) drift.push(`the working tree could not be compared with the pause (${current.error}).`);
			else if (current.tree === git.treeOf(snapshot)) ok.push(pausedDirty.length ? `working tree identical to the pause (${pausedDirty.length} unfinished file(s) in place)` : 'working tree identical to the pause');
			else {
				const changes = git.changedBetween(snapshot, current.commit) ?? [];
				const missing = pausedDirty.filter((file) => changes.some((change) => change.path === file));
				const lost = missing.length > 0 && changes.every((change) => pausedDirty.includes(change.path))
					&& facts.head === pausedGit.head && facts.dirtyFiles.length === 0;
				if (lost) {
					restore = `git restore --source=${snapshot} --worktree -- ${missing.map((file) => JSON.stringify(file)).join(' ')}`;
					drift.push(`the unfinished work is gone from the working tree (reset, stash or clean?): ${list(missing).join(', ')}.\n    It is saved in the pause snapshot — after the user agrees: ${restore}`);
				} else {
					drift.push(`${changes.length} file(s) differ from the pause:\n${list(changes.map((change) => `    ${{ A: 'added', D: 'deleted', M: 'changed' }[change.status] ?? change.status} ${change.path}`)).join('\n')}\n` +
						`    Compare: git diff ${short(snapshot)} -- <file>. The paused state is saved in ${local?.ref ?? short(snapshot)}.`);
				}
			}
		} else if (pausedDirty.length > 0) {
			const here = new Set(facts.dirtyFiles);
			const absent = pausedDirty.filter((file) => !here.has(file));
			if (pause.portable === true) ok.push('the work was released (committed / pushed)');
			else if (absent.length === pausedDirty.length) {
				blocked.push(`the unfinished work (${list(pausedDirty).join(', ')}) is not here and there is no snapshot of it on this computer — it was paused${pause.host ? ` on ${pause.host}` : ' elsewhere'}. Resume there, or confirm with the user that it is lost and start the task over.`);
			} else if (absent.length > 0) drift.push(`some unfinished files are not modified here: ${list(absent).join(', ')}.`);
			else ok.push('the unfinished files are in place (no snapshot to compare contents)');
		}

		// 10. Tests.
		if (snapshot && ok.some((line) => line.startsWith('working tree identical'))) {
			if (gatePassedNow === true) ok.push('the test gate passed on exactly this tree — no need to run it again');
			else if (local?.gatePassed === true) ok.push('the test gate passed when it was paused');
		}
	}

	// 8 / 9. The task or its context changed while it was paused.
	if (taskChanged) drift.push('the task itself was edited while it was paused (spec, subtasks or links) — re-read it before continuing.');

	const verdict = blocked.length ? 'blocked' : drift.length ? 'drift' : 'exact';
	const lines = [
		...blocked.map((line) => `✗ ${line}`),
		...drift.map((line) => `! ${line}`),
		...ok.map((line) => `✓ ${line}`),
	];
	return { verdict, lines, restore };
}

const NEXT = {
	exact: 'EXACT — the repository is where the work stopped. Take it back with claimTask { taskId, workerId, resume: true } and continue from the note and nextSteps.',
	drift: 'DRIFT — show the user these differences and ask how to go on (restore the snapshot / continue as it is / leave it paused) BEFORE claiming. Leaving it paused changes nothing.',
	blocked: 'BLOCKED — do not resume. Tell the user what is wrong; the pause stays as it is.',
};

export function formatReport(title, report, { resumed = false } = {}) {
	const head = `Introsio resume check for "${title}": ${report.verdict.toUpperCase()}`;
	const next = resumed
		? (report.verdict === 'exact'
			? 'You hold the task again. Continue from the note and nextSteps.'
			: 'You already hold the task: settle these with the user before changing any code (updateTask statusState "pending" gives it back if you should not continue).')
		: NEXT[report.verdict];
	return [head, ...report.lines.map((line) => `  ${line}`), next].join('\n');
}

/** A task held by a session on this computer whose agent is no longer running: interrupted without a pause. */
export function interruptedNote({ taskId, claimWorkerId, others, now, alive }) {
	if (!claimWorkerId) return null;
	const dead = others.find((other) => (other.workerId === claimWorkerId || other.claims?.[taskId]?.workerId === claimWorkerId)
		&& !sessionIsLive(other, now, alive));
	if (!dead) return null;
	const edited = (dead.editedFiles ?? []).slice(0, MAX_LISTED);
	return `Introsio: this task was interrupted without a pause — worker "${claimWorkerId}" was a ${dead.agent ?? 'agent'} session on this computer that is no longer running` +
		`${dead.cwd ? ` (in ${dead.cwd})` : ''}. To take it over at once, claim it with that same workerId: claimTask { taskId: "${taskId}", workerId: "${claimWorkerId}" }.` +
		`${edited.length ? ` It had edited: ${edited.join(', ')} — check git status/diff for that work before continuing.` : ''}`;
}

export function pausedNote(session) {
	const paused = Object.entries(session.paused ?? {});
	if (!paused.length) return null;
	return `Paused in this session: ${paused.map(([id, item]) => `"${item.title}" (${id})`).join(', ')} — /introsio-resume takes them back.`;
}
