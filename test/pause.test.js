// /introsio-pause and /introsio-resume (docs/adr/0011-pause-and-resume.md): the snapshot, the git
// position check, and the resume check — through the real hook script on real git repositories.
// P-numbers match the table in README.md ("Pause and resume").
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { scratch, makeRepo, git, fire, mcpResult, claimPacket, KIT } from './helpers.js';
import { createGit } from '../lib/git.mjs';
import { resumeReport, pauseRef, localMatchesPause } from '../hook/features/pause.mjs';
import { pushDecision } from '../hook/features/git.mjs';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const TASK = 'task-1';
const post = (home, sid, cwd, name, input, data, isError = false) => fire(home, 'claude', 'PostToolUse', {
	session_id: sid, cwd, tool_name: `mcp__introsio__${name}`, tool_input: input, tool_response: mcpResult(data, isError),
});
const pre = (home, sid, cwd, name, input) => fire(home, 'claude', 'PreToolUse', { session_id: sid, cwd, tool_name: `mcp__introsio__${name}`, tool_input: input });
const contextOf = (answer) => answer.json?.hookSpecificOutput?.additionalContext ?? '';
const denial = (answer) => (answer.json?.hookSpecificOutput?.permissionDecision === 'deny' ? answer.json.hookSpecificOutput.permissionDecisionReason : null);
const session = (home, sid) => JSON.parse(fs.readFileSync(path.join(home, 'sessions', `${sid}.json`), 'utf8'));

/** A repository on branch feat/x with one committed file, one edited and one new untracked file, and a claim on TASK. */
function pausedSetup() {
	const home = scratch();
	const repo = makeRepo();
	git(repo, 'switch', '-q', '-c', 'feat/x');
	fs.writeFileSync(path.join(repo, 'api.js'), 'export const v = 1;\n');
	git(repo, 'add', '.');
	git(repo, 'commit', '-q', '-m', 'api');
	post(home, 's1', repo, 'claimTask', { projectId: 'proj-1' }, claimPacket({ workerId: 'w1', task: { id: TASK, title: 'Build the API', subtaskWaves: [[{ id: 's1' }]] } }));
	fs.writeFileSync(path.join(repo, 'api.js'), 'export const v = 2; // half done\n');
	fs.writeFileSync(path.join(repo, 'new.js'), 'export const added = true;\n');
	return { home, repo, head: git(repo, 'rev-parse', 'HEAD') };
}

/** Pause the way an agent does: the hook corrects a wrong git position once, then the pause lands. */
function pause(home, repo, extra = {}) {
	const args = { taskId: TASK, workerId: 'w1', handoff: { note: 'Half way through api.js', git: { branch: 'feat/x', head: 'deadbeef' } }, ...extra };
	const first = denial(pre(home, 's1', repo, 'pauseTask', args));
	assert.ok(first, 'a wrong head is refused once');
	const exact = JSON.parse(first.slice(first.indexOf('{')));
	args.handoff.git = exact;
	assert.equal(denial(pre(home, 's1', repo, 'pauseTask', args)), null, 'the exact values go through');
	const done = post(home, 's1', repo, 'pauseTask', args, { success: true, task: { id: TASK, title: 'Build the API', paused: true }, portable: false });
	return { exact, done, args };
}

const serverPause = (exact, extra = {}) => ({ at: '2026-11-02T10:00:00.000Z', workerId: 'w1', host: 'laptop', note: 'Half way', git: exact, portable: false, ...extra });
const resumeCheck = (home, sid, repo, pause) => contextOf(post(home, sid, repo, 'getTaskById', { taskId: TASK }, { id: TASK, title: 'Build the API', pause }));

test('pause: the working tree is snapshotted under a local ref and left exactly as it was', () => {
	const { home, repo, head } = pausedSetup();
	const statusBefore = git(repo, 'status', '--porcelain');
	const { exact, done } = pause(home, repo);
	assert.equal(exact.head, head);
	assert.equal(exact.branch, 'feat/x');
	assert.deepEqual(exact.dirtyFiles.sort(), ['api.js', 'new.js']);
	assert.match(contextOf(done), /refs\/introsio\/paused\/task-1/);
	// Nothing changed for the person: same branch, same HEAD, same unfinished files, nothing staged.
	assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
	assert.equal(git(repo, 'status', '--porcelain'), statusBefore);
	assert.equal(git(repo, 'diff', '--cached', '--name-only'), '');
	// The snapshot holds the unfinished work, untracked file included.
	const ref = git(repo, 'rev-parse', pauseRef(TASK));
	assert.equal(ref, exact.snapshot);
	assert.equal(git(repo, 'show', `${ref}:api.js`), 'export const v = 2; // half done');
	assert.equal(git(repo, 'show', `${ref}:new.js`), 'export const added = true;');
	assert.equal(git(repo, 'branch', '--list', '--format=%(refname:short)').split('\n').sort().join(','), 'feat/x,main', 'no branch was added');
	// The session no longer holds the task, so the stop guard lets the agent stop.
	assert.deepEqual(session(home, 's1').claims, {});
	assert.equal(fire(home, 'claude', 'Stop', { session_id: 's1', cwd: repo }).json?.decision, undefined);
	const record = JSON.parse(fs.readFileSync(path.join(home, 'pauses', `${TASK}.json`), 'utf8'));
	assert.equal(record.snapshot, exact.snapshot);
	assert.equal(record.workerId, 'w1');
});

test('pause: a refused pause leaves no ref behind', () => {
	const { home, repo } = pausedSetup();
	const args = { taskId: TASK, workerId: 'w1', handoff: { git: { branch: 'feat/x', head: git(repo, 'rev-parse', 'HEAD') } } };
	pre(home, 's1', repo, 'pauseTask', args);
	post(home, 's1', repo, 'pauseTask', args, { success: false, error: 'You do not hold task', status: 409 }, true);
	assert.equal(createGit(repo).resolve(pauseRef(TASK)), null);
	assert.ok(session(home, 's1').claims[TASK], 'a refused pause keeps the claim');
});

test('pause --release with uncommitted task files is refused; committed, it goes through', () => {
	const { home, repo } = pausedSetup();
	post(home, 's1', repo, 'updateTask', { taskId: TASK }, { success: true, task: { id: TASK } });
	fire(home, 'claude', 'PostToolUse', { session_id: 's1', cwd: repo, tool_name: 'Edit', tool_input: { file_path: path.join(repo, 'api.js') }, tool_response: {} });
	const head = git(repo, 'rev-parse', 'HEAD');
	const args = { taskId: TASK, workerId: 'w1', release: true, handoff: { git: { branch: 'feat/x', head } } };
	assert.match(denial(pre(home, 's1', repo, 'pauseTask', args)) ?? '', /not committed:\n {2}- api\.js/);
	git(repo, 'add', '.');
	git(repo, 'commit', '-q', '-m', 'wip');
	args.handoff.git.head = git(repo, 'rev-parse', 'HEAD');
	assert.equal(denial(pre(home, 's1', repo, 'pauseTask', args)), null);
});

test('resume: EXACT when nothing moved, shown once per pause', () => {
	const { home, repo } = pausedSetup();
	const { exact } = pause(home, repo);
	const report = resumeCheck(home, 's2', repo, serverPause(exact));
	assert.match(report, /: EXACT/);
	assert.match(report, /branch feat\/x/);
	assert.match(report, /working tree identical to the pause \(2 unfinished file/);
	assert.match(report, /claimTask \{ taskId, workerId, resume: true \}/);
	// Shown once per pause, not on every read.
	assert.equal(resumeCheck(home, 's2', repo, serverPause(exact)), '');
});

test('P11 resume: work wiped by reset/clean → DRIFT with the exact restore command, which brings it back', () => {
	const { home, repo } = pausedSetup();
	const { exact } = pause(home, repo);
	git(repo, 'checkout', '--', '.');
	git(repo, 'clean', '-fdq');
	const report = resumeCheck(home, 's2', repo, serverPause(exact));
	assert.match(report, /: DRIFT/);
	assert.match(report, /unfinished work is gone/);
	const command = report.match(/git restore [^\n]+/)[0];
	spawnSync(command, { cwd: repo, shell: true });
	assert.equal(fs.readFileSync(path.join(repo, 'api.js'), 'utf8'), 'export const v = 2; // half done\n');
	assert.equal(fs.readFileSync(path.join(repo, 'new.js'), 'utf8'), 'export const added = true;\n');
});

test('P10 resume: another branch → DRIFT naming the switch', () => {
	const { home, repo } = pausedSetup();
	const { exact } = pause(home, repo);
	git(repo, 'stash', '-u', '-q');
	git(repo, 'switch', '-q', 'main');
	const report = resumeCheck(home, 's2', repo, serverPause(exact));
	assert.match(report, /: DRIFT/);
	assert.match(report, /you are on main; the work is on feat\/x → git switch feat\/x/);
});

test('P10 resume: commits added since the pause are listed with their author', () => {
	const { home, repo } = pausedSetup();
	const { exact } = pause(home, repo);
	git(repo, 'add', '.');
	git(repo, 'commit', '-q', '-m', 'person finished it');
	const report = resumeCheck(home, 's2', repo, serverPause(exact));
	assert.match(report, /1 commit\(s\) were added since the pause/);
	assert.match(report, /Test: person finished it/);
	assert.match(report, /working tree identical to the pause/, 'the work itself is the same, now committed');
});

test('P10 resume: rewritten history (rebase / force push) is called out', () => {
	const { home, repo } = pausedSetup();
	const { exact } = pause(home, repo);
	git(repo, 'stash', '-u', '-q');
	git(repo, 'reset', '-q', '--hard', 'main');
	fs.writeFileSync(path.join(repo, 'other.js'), 'x\n');
	git(repo, 'add', '.');
	git(repo, 'commit', '-q', '-m', 'different');
	const report = resumeCheck(home, 's2', repo, serverPause(exact));
	assert.match(report, /history was rewritten since the pause/);
});

test('P13 resume: a merge left half way blocks it', () => {
	const { home, repo } = pausedSetup();
	const { exact } = pause(home, repo);
	fs.writeFileSync(path.join(repo, '.git', 'MERGE_HEAD'), `${exact.head}\n`);
	const report = resumeCheck(home, 's2', repo, serverPause(exact));
	assert.match(report, /: BLOCKED/);
	assert.match(report, /git merge is in progress — finish or abort it \(git merge --abort\)/);
});

test('P5 resume elsewhere: unfinished code only on another computer → BLOCKED, naming it', () => {
	const home = scratch();
	const repo = makeRepo();
	const head = git(repo, 'rev-parse', 'HEAD');
	const report = resumeCheck(home, 's9', repo, serverPause({ branch: 'main', head, dirtyFiles: ['src/half.js'] }, { host: 'office-desktop' }));
	assert.match(report, /: BLOCKED/);
	assert.match(report, /paused on office-desktop/);
});

test('P7 resume: another live session on this computer working the task → BLOCKED', () => {
	const repo = makeRepo();
	const report = resumeReport({
		git: createGit(repo), taskId: TASK, pause: { git: {} }, local: null,
		others: [{ agent: 'codex', workerId: 'w9', agentPid: 1234, claims: { [TASK]: { taskId: TASK } } }], alive: () => true,
	});
	assert.equal(report.verdict, 'blocked');
	assert.match(report.lines[0], /another codex session on this computer \(workerId w9\)/);
});

test('P16 resume: a task edited while paused says to re-read it', () => {
	const { home, repo } = pausedSetup();
	const { exact } = pause(home, repo);
	const answer = post(home, 's2', repo, 'claimTask', { taskId: TASK, resume: true }, claimPacket({
		workerId: 'w2', task: { id: TASK, title: 'Build the API' }, resumedPause: serverPause(exact), taskChangedSincePause: true,
	}));
	const report = contextOf(answer);
	assert.match(report, /: DRIFT/);
	assert.match(report, /edited while it was paused/);
	assert.match(report, /You already hold the task/);
});

test('P1 interrupted without a pause: a dead local session holding the task is named, with its workerId', () => {
	const home = scratch();
	const repo = makeRepo();
	post(home, 'dead', repo, 'claimTask', { projectId: 'proj-1' }, claimPacket({ workerId: 'w-dead', task: { id: TASK, title: 'Build the API' } }));
	const file = path.join(home, 'sessions', 'dead.json');
	const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
	stored.agentPid = 2 ** 22 + 12345; // no such process
	stored.editedFiles = ['src/api.js'];
	fs.writeFileSync(file, JSON.stringify(stored));
	const answer = post(home, 'fresh', repo, 'getTaskById', { taskId: TASK }, { id: TASK, title: 'Build the API', claim: { workerId: 'w-dead', expiresAt: new Date(Date.now() + 600_000).toISOString() } });
	const note = contextOf(answer);
	assert.match(note, /interrupted without a pause/);
	assert.match(note, /claimTask \{ taskId: "task-1", workerId: "w-dead" \}/);
	assert.match(note, /src\/api\.js/);
	// The claim with the dead session's workerId is allowed (R9: its process is gone).
	assert.equal(denial(pre(home, 'fresh', repo, 'claimTask', { taskId: TASK, workerId: 'w-dead' })), null);
});

test('P17 pausing one of two held tasks: the other still holds the stop', () => {
	const { home, repo } = pausedSetup();
	post(home, 's1', repo, 'claimTask', { projectId: 'proj-1' }, claimPacket({ workerId: 'w1', task: { id: 'task-2', title: 'Second' } }));
	pause(home, repo);
	assert.deepEqual(Object.keys(session(home, 's1').claims), ['task-2']);
	assert.equal(fire(home, 'claude', 'Stop', { session_id: 's1', cwd: repo }).json?.decision, 'block');
});

test('P20 completing the task removes its snapshot ref and local record', () => {
	const { home, repo } = pausedSetup();
	const { exact } = pause(home, repo);
	post(home, 's2', repo, 'claimTask', { taskId: TASK, resume: true }, claimPacket({ workerId: 'w2', task: { id: TASK, title: 'Build the API' }, resumedPause: serverPause(exact) }));
	post(home, 's2', repo, 'completeTask', { taskId: TASK, workerId: 'w2' }, { success: true, task: { id: TASK, completed: true }, nowReady: [] });
	assert.equal(createGit(repo).resolve(pauseRef(TASK)), null);
	assert.equal(fs.existsSync(path.join(home, 'pauses', `${TASK}.json`)), false);
});

test('P15 a pause snapshot is never pushed, whatever the mode', () => {
	const repo = makeRepo();
	for (const command of ['git push origin refs/introsio/paused/t1', 'git push origin "refs/introsio/*:refs/introsio/*"', 'git push origin +refs/introsio/paused/t1:refs/heads/x']) {
		assert.equal(pushDecision({ command, mode: 'off', git: createGit(repo) }).type, 'deny', command);
	}
	assert.equal(pushDecision({ command: 'git push origin feat/x', mode: 'off', git: createGit(repo) }).type, 'none');
});

test('P13 outside a git repository a pause goes through with no snapshot', () => {
	const home = scratch();
	const dir = scratch();
	post(home, 's1', dir, 'claimTask', { projectId: 'proj-1' }, claimPacket({ workerId: 'w1', task: { id: TASK, title: 'T' } }));
	assert.equal(denial(pre(home, 's1', dir, 'pauseTask', { taskId: TASK, workerId: 'w1', handoff: { note: 'n' } })), null);
	const done = post(home, 's1', dir, 'pauseTask', { taskId: TASK, workerId: 'w1' }, { success: true, task: { id: TASK, title: 'T' } });
	assert.match(contextOf(done), /paused "T"/);
});

test('int paused lists pauses and interrupted work with the line to resume them, offline', () => {
	const { home, repo } = pausedSetup();
	pause(home, repo);
	const result = spawnSync(process.execPath, [path.join(KIT, 'cli.mjs'), 'paused'], { encoding: 'utf8', env: { ...process.env, INTROSIO_HOME: home } });
	assert.match(result.stdout, /"Build the API" \(taskId task-1\)/);
	assert.match(result.stdout, /feat\/x @ [0-9a-f]{10} · 2 unfinished file\(s\), working tree saved/);
	assert.match(result.stdout, /resume: \/introsio-resume task-1/);
	const pruned = spawnSync(process.execPath, [path.join(KIT, 'cli.mjs'), 'paused', '--prune', '--days', '0'], { encoding: 'utf8', env: { ...process.env, INTROSIO_HOME: home } });
	assert.match(pruned.stdout, /Removed 1 pause record/);
	assert.equal(createGit(repo).resolve(pauseRef(TASK)), null);
});

test('the pause can be switched off like every feature', () => {
	const { home, repo } = pausedSetup();
	fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ features: { pause: false } }));
	const args = { taskId: TASK, workerId: 'w1', handoff: { git: { head: 'deadbeef' } } };
	assert.equal(denial(pre(home, 's1', repo, 'pauseTask', args)), null);
});

test('resume: a local record from an earlier pause never replaces the current pause (re-paused on another computer)', () => {
	const { home, repo } = pausedSetup();
	const { exact } = pause(home, repo);
	// Resumed and paused again on another computer: a new pause, no snapshot here, different unfinished files.
	const current = serverPause({ branch: 'feat/x', head: exact.head, dirtyFiles: ['src/other.js'] }, { at: '2026-11-03T09:00:00.000Z', workerId: 'w9', host: 'office-desktop' });
	const report = resumeCheck(home, 's2', repo, current);
	assert.match(report, /: BLOCKED/, report);
	assert.match(report, /paused on office-desktop/);
	assert.match(report, /older pause record of this task on this computer was ignored/);
	// The local record's own pause still checks EXACT against it.
	assert.match(resumeCheck(home, 's3', repo, serverPause(exact)), /: EXACT/);
});

test('resume: the record is tied to its pause by the server\'s time stamp, else by snapshot, else worker + HEAD', () => {
	const at = '2026-11-02T10:00:00.000Z';
	assert.equal(localMatchesPause({ pausedAt: at, snapshot: 'a'.repeat(40) }, { at, git: { snapshot: 'b'.repeat(40) } }), true, 'the time stamp decides');
	assert.equal(localMatchesPause({ pausedAt: at }, { at: '2026-11-02T10:00:01.000Z' }), false);
	assert.equal(localMatchesPause({ snapshot: 'abcdef1234' }, { git: { snapshot: 'abcdef1234567' } }), true);
	assert.equal(localMatchesPause({ snapshot: 'abcdef1234' }, { git: { snapshot: '1234567abc' } }), false);
	assert.equal(localMatchesPause({ workerId: 'w1', head: 'c'.repeat(40) }, { workerId: 'w1', git: { head: 'c'.repeat(12) } }), true);
	assert.equal(localMatchesPause({ workerId: 'w1', head: 'c'.repeat(40) }, { workerId: 'w2', git: { head: 'c'.repeat(40) } }), false);
	assert.equal(localMatchesPause(null, { at }), false);
	assert.equal(localMatchesPause({}, {}), false);
});

test('pause: the local record keeps the server\'s pausedAt', () => {
	const { home, repo } = pausedSetup();
	const args = { taskId: TASK, workerId: 'w1', handoff: { note: 'n', git: { branch: 'feat/x', head: 'deadbeef' } } };
	const exact = JSON.parse(denial(pre(home, 's1', repo, 'pauseTask', args)).replace(/^[^{]*/, ''));
	args.handoff.git = exact;
	pre(home, 's1', repo, 'pauseTask', args);
	post(home, 's1', repo, 'pauseTask', args, { success: true, task: { id: TASK, title: 'Build the API', paused: true }, pausedAt: '2026-11-02T10:00:00.000Z' });
	const record = JSON.parse(fs.readFileSync(path.join(home, 'pauses', `${TASK}.json`), 'utf8'));
	assert.equal(record.pausedAt, '2026-11-02T10:00:00.000Z');
});

test('resume: its own worker starting a paused task with updateTask gets the resume check too', () => {
	const { home, repo } = pausedSetup();
	const { exact } = pause(home, repo);
	const answer = post(home, 's1', repo, 'updateTask', { taskId: TASK, workerId: 'w1', statusState: 'in_progress' }, {
		success: true, workerId: 'w1', task: { id: TASK, title: 'Build the API', statusState: 'in_progress' }, resumedPause: serverPause(exact), taskChangedSincePause: false,
	});
	assert.match(contextOf(answer), /resume check for "Build the API": EXACT/);
	assert.match(contextOf(answer), /You hold the task again/);
});

let failed = 0;
for (const { name, fn } of tests) {
	try {
		await fn();
		console.log(`  ✓ ${name}`);
	} catch (error) {
		failed += 1;
		console.log(`  ✗ ${name}\n    ${error.stack}`);
	}
}
if (failed) process.exitCode = 1;
