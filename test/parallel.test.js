// Several agents on one project: one folder each (`shared-tree`, `int worktree`), the code a
// task builds on (`inputs`), and waiting instead of quitting while others finish (`wait`).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { scratch, makeRepo, git, fire, mcpResult, claimPacket, KIT } from './helpers.js';
import { sharedTreeDecision, inputsNote, trackWaiting, waitStopDecision, treeKey, MAX_WAIT_MS } from '../hook/features/parallel.mjs';
import { emptySession } from '../hook/state.mjs';
import { createGit } from '../lib/git.mjs';
import { loadConfig, repoSettings } from '../lib/config.mjs';
import { canonicalPath, repoKey } from '../lib/paths.mjs';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const NOW = Date.parse('2026-11-20T12:00:00Z');
const alive = () => true;

function cli(home, args, cwd) {
	const result = spawnSync(process.execPath, [path.join(KIT, 'cli.mjs'), ...args], {
		cwd, encoding: 'utf8', env: { ...process.env, INTROSIO_TEST_HOME: home, INTROSIO_HOME: path.join(home, '.introsio'), XDG_CONFIG_HOME: '' },
	});
	return { out: result.stdout + result.stderr, status: result.status };
}

const other = (over = {}) => ({
	sessionId: 'other', agent: 'codex', workerId: 'codex-1', root: treeKey('/work/repo'), agentPid: 1, lastSeenAt: NOW,
	claims: { t1: { taskId: 't1', title: 'Build the API', workerId: 'codex-1', expiresAt: NOW + 20 * 60_000 } },
	...over,
});
const me = () => ({ ...emptySession('me', 'claude', NOW), workerId: 'claude-1' });
const claimCall = { name: 'claimTask', args: { projectId: 'p', workerId: 'claude-1' } };

// ── shared-tree ──────────────────────────────────────────────────────────────

test('shared-tree: a claim in a folder another live agent works in is refused once, naming int worktree; the second goes through', () => {
	const session = me();
	const first = sharedTreeDecision(session, [other()], claimCall, { root: '/work/repo', now: NOW, alive });
	assert.equal(first.type, 'deny');
	assert.match(first.message, /codex session \(workerId codex-1\) is working on "Build the API" in this same folder/);
	assert.match(first.message, /int worktree add <name>/);
	assert.equal(sharedTreeDecision(session, [other()], claimCall, { root: '/work/repo', now: NOW, alive }).type, 'none', 'the person chose to share the folder');
});

test('shared-tree: nothing to say for another folder, a finished or expired claim, a dead session, the same worker, or a task already held', () => {
	const decide = (others, call = claimCall, session = me()) => sharedTreeDecision(session, others, call, { root: '/work/repo', now: NOW, alive }).type;
	assert.equal(decide([other({ root: treeKey('/work/repo-w2') })]), 'none', 'its own worktree');
	assert.equal(decide([other({ claims: {} })]), 'none', 'holds nothing');
	assert.equal(decide([other({ claims: { t1: { taskId: 't1', title: 'x', expiresAt: NOW - 1 } } })]), 'none', 'lease over');
	assert.equal(sharedTreeDecision(me(), [other()], claimCall, { root: '/work/repo', now: NOW, alive: () => false }).type, 'none', 'its agent is gone');
	assert.equal(decide([other({ workerId: 'claude-1' })]), 'none', 'that is this worker');
	const holding = me();
	holding.claims.t9 = { taskId: 't9', title: 'Mine' };
	assert.equal(decide([other()], { name: 'claimTask', args: { taskId: 't9', workerId: 'claude-1' } }, holding), 'none', 'taking back its own task');
	assert.equal(decide([other()], { name: 'getProjectState', args: {} }), 'none', 'not a start');
	assert.equal(sharedTreeDecision(me(), [other()], claimCall, { root: null, now: NOW, alive }).type, 'none', 'not a repository');
});

test('shared-tree through the real hook: a second agent in the same checkout is refused once; one in its own worktree is not', () => {
	const home = scratch();
	const repo = makeRepo();
	const worktree = path.join(scratch('introsio-wt-'), 'w2');
	git(repo, 'worktree', 'add', '-q', '-b', 'agent/w2', worktree);
	fire(home, 'claude', 'PostToolUse', { session_id: 'a', cwd: repo, tool_name: 'mcp__introsio__claimTask', tool_input: { projectId: 'p' }, tool_response: mcpResult(claimPacket()) });
	const ask = (sid, cwd) => fire(home, 'claude', 'PreToolUse', { session_id: sid, cwd, tool_name: 'mcp__introsio__claimTask', tool_input: { projectId: 'p', workerId: `${sid}-worker` } }).json;
	const refused = ask('b', repo);
	assert.equal(refused?.hookSpecificOutput?.permissionDecision, 'deny');
	assert.match(refused.hookSpecificOutput.permissionDecisionReason, /same folder/);
	assert.equal(ask('b', repo), null, 'asked again: it goes through');
	assert.equal(ask('c', worktree), null, 'its own worktree: nothing to say');
});

// ── inputs ───────────────────────────────────────────────────────────────────

function commitOn(repo, branch, file, from = 'main') {
	git(repo, 'switch', '-q', '-c', branch, from);
	fs.writeFileSync(path.join(repo, file), `${branch}\n`);
	git(repo, 'add', file);
	git(repo, 'commit', '-q', '-m', `${branch} work`);
	git(repo, 'switch', '-q', 'main');
}
const packet = (inputs, over = {}) => claimPacket({ inputs, ...over });

test('inputs (local mode): names each dependency branch not in HEAD with its merge command, and nothing once merged', () => {
	const repo = makeRepo();
	commitOn(repo, 'agent/api', 'api.js');
	commitOn(repo, 'agent/db', 'db.js');
	const g = createGit(repo);
	const inputs = [
		{ taskId: 'a', title: 'API', outcome: { summary: 's', branch: 'agent/api' } },
		{ taskId: 'b', title: 'DB', outcome: { summary: 's', branch: 'agent/db' } },
		{ taskId: 'c', title: 'Docs', outcome: { summary: 'no branch recorded' } },
		{ taskId: 'd', title: 'Gone', outcome: { summary: 's', branch: 'agent/elsewhere' } },
	];
	const note = inputsNote({ git: g, data: packet(inputs), mode: 'local' });
	assert.match(note, /"Build the API" builds on work that is not in your branch "main" yet/);
	assert.match(note, /"API": git merge --no-edit agent\/api/);
	assert.match(note, /"DB": git merge --no-edit agent\/db/);
	assert.match(note, /"Gone": branch agent\/elsewhere is not in this repository/);
	assert.doesNotMatch(note, /Docs/);
	git(repo, 'merge', '-q', '--no-edit', 'agent/api');
	git(repo, 'merge', '-q', '--no-edit', 'agent/db');
	assert.equal(inputsNote({ git: g, data: packet(inputs.slice(0, 3)), mode: 'local' }), null, 'everything it builds on is in');
	assert.equal(inputsNote({ git: g, data: packet([]), mode: 'local' }), null, 'no inputs');
});

test('inputs (github mode): compared with the pushed default branch a new task starts from; a task taken up again with HEAD', () => {
	const remote = scratch('introsio-remote-');
	git(remote, 'init', '-q', '--bare', '-b', 'main');
	const repo = makeRepo();
	git(repo, 'remote', 'add', 'origin', remote);
	git(repo, 'push', '-q', '-u', 'origin', 'main');
	commitOn(repo, 'task/api', 'api.js');
	git(repo, 'push', '-q', 'origin', 'task/api');
	// The agent sits on a branch that already has the API (its previous task) — a NEW task still branches off main.
	git(repo, 'switch', '-q', '-c', 'task/old', 'task/api');
	const g = createGit(repo);
	const inputs = [{ taskId: 'a', title: 'API', outcome: { summary: 's', branch: 'task/api' } }, { taskId: 'b', title: 'Auth', outcome: { summary: 's', branch: 'task/auth' } }];
	const repository = { fullName: 'me/app', defaultBranch: 'main' };
	const fresh = inputsNote({ git: g, data: packet(inputs, { repository }), mode: 'github' });
	assert.match(fresh, /not in the default branch "main" yet/);
	assert.match(fresh, /"API": git merge --no-edit origin\/task\/api/);
	assert.match(fresh, /"Auth": branch task\/auth is not on this computer yet — git fetch origin task\/auth/);
	assert.match(fresh, /branch off main for this task/);
	const continuing = inputsNote({ git: g, data: packet(inputs.slice(0, 1), { repository, alreadyHeld: true }), mode: 'github' });
	assert.equal(continuing, null, 'its branch (HEAD) already has the API');
});

// ── wait ─────────────────────────────────────────────────────────────────────

const noWork = (reason, over = {}) => ({ name: 'claimTask', args: { projectId: 'p', workerId: 'w' }, result: { ok: true, data: { claimed: false, reason, retryAfter: new Date(NOW + 10 * 60_000).toISOString(), project: { id: 'p' }, ...over } } });

test('wait: "all_claimed" says to wait with int wait and claim again — once per wait; a stop is sent back once', () => {
	const session = me();
	const note = trackWaiting(session, noWork('all_claimed'), NOW);
	assert.match(note, /other workers hold the ready work/);
	assert.match(note, /int wait 2026-11-20T12:10:00\.000Z/);
	assert.equal(trackWaiting(session, noWork('all_claimed'), NOW + 240_000), null, 'the same wait: said already');
	const stop = waitStopDecision(session, NOW + 241_000);
	assert.equal(stop.type, 'block');
	assert.match(stop.message, /Unless the user asked you to stop/);
	assert.equal(waitStopDecision(session, NOW + 242_000).type, 'none', 'stopping again is a decision');
});

test('wait: a claim, or an answer that means "stop", ends the wait; after an hour the agent reports instead of waiting', () => {
	const session = me();
	trackWaiting(session, noWork('awaiting_completion'), NOW);
	assert.match(trackWaiting(me(), noWork('awaiting_completion'), NOW), /completeTask it now/);
	trackWaiting(session, { name: 'claimTask', args: {}, result: { ok: true, data: claimPacket() } }, NOW + 60_000);
	assert.equal(session.waiting, null, 'it got a task');
	for (const reason of ['complete', 'blocked', 'paused']) {
		const s = me();
		trackWaiting(s, noWork('all_claimed'), NOW);
		trackWaiting(s, noWork(reason), NOW + 1000);
		assert.equal(waitStopDecision(s, NOW + 2000).type, 'none', reason);
	}
	const long = me();
	trackWaiting(long, noWork('all_claimed'), NOW);
	assert.match(trackWaiting(long, noWork('all_claimed'), NOW + MAX_WAIT_MS + 1), /Tell the user which tasks are still held/);
	assert.equal(waitStopDecision(long, NOW + MAX_WAIT_MS + 2).type, 'none', 'an hour is enough');
	const stale = me();
	trackWaiting(stale, noWork('all_claimed'), NOW);
	assert.equal(waitStopDecision(stale, NOW + 16 * 60_000).type, 'none', 'a no-work answer long ago does not hold a stop');
	const holding = me();
	trackWaiting(holding, noWork('all_claimed'), NOW);
	holding.claims.t = { taskId: 't' };
	assert.equal(waitStopDecision(holding, NOW + 1000).type, 'none', 'the stop guard speaks for held tasks');
});

test('wait through the real hook: the note after claimTask, one stop sent back, then let go', () => {
	const home = scratch();
	const after = fire(home, 'claude', 'PostToolUse', {
		session_id: 'w', cwd: home, tool_name: 'mcp__introsio__claimTask', tool_input: { projectId: 'p', workerId: 'w-1' },
		tool_response: mcpResult({ claimed: false, reason: 'all_claimed', retryAfter: new Date(Date.now() + 600_000).toISOString(), project: { id: 'p' } }),
	}).json;
	assert.match(after.hookSpecificOutput.additionalContext, /int wait /);
	assert.equal(fire(home, 'claude', 'Stop', { session_id: 'w', cwd: home }).json?.decision, 'block');
	assert.equal(fire(home, 'claude', 'Stop', { session_id: 'w', cwd: home, stop_hook_active: true }).json?.decision, undefined);
});

// ── worktrees: settings, int worktree, int wait ─────────────────────────────

test('a linked worktree uses the repository\'s int mode / int gate, unless it has its own', () => {
	const home = scratch();
	const repo = makeRepo();
	const worktree = path.join(scratch('introsio-wt-'), 'w1');
	git(repo, 'worktree', 'add', '-q', '-b', 'agent/w1', worktree);
	const g = createGit(worktree);
	assert.equal(canonicalPath(g.mainRoot()), canonicalPath(repo));
	assert.equal(canonicalPath(createGit(repo).mainRoot()), canonicalPath(repo), 'the main checkout is its own main root');
	assert.equal(cli(home, ['mode', 'github'], worktree).status, 0, 'set from inside the worktree…');
	assert.equal(cli(home, ['gate', 'set', 'npm test'], repo).status, 0);
	const config = loadConfig({ INTROSIO_HOME: path.join(home, '.introsio') });
	const settings = repoSettings(config, g.root(), g.mainRoot());
	assert.equal(settings.mode, 'github', '…it is the repository\'s');
	assert.equal(settings.gate, 'npm test');
	assert.match(cli(home, ['status'], worktree).out, /mode github · test gate "npm test"/);
	const own = { repos: { [repoKey(worktree)]: { mode: 'local' }, [repoKey(repo)]: { mode: 'github', gate: 'npm test' } } };
	assert.equal(repoSettings(own, g.root(), g.mainRoot()).mode, 'local', 'a worktree\'s own settings win');
	assert.equal(repoSettings(own, g.root(), g.mainRoot()).gate, null, 'whole, not mixed with the repository\'s');
});

test('int worktree add / list / remove', () => {
	const home = scratch();
	const parent = scratch('introsio-parent-');
	const repo = path.join(parent, 'app');
	fs.renameSync(makeRepo(), repo);
	const added = cli(home, ['worktree', 'add', 'w1'], repo);
	assert.equal(added.status, 0, added.out);
	const dir = path.join(parent, 'app-w1');
	assert.ok(fs.existsSync(path.join(dir, 'README.md')));
	assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'agent/w1');
	assert.match(added.out, /Untracked files are not copied/);
	assert.notEqual(cli(home, ['worktree', 'add', 'w1'], repo).status, 0, 'the folder exists already');
	assert.notEqual(cli(home, ['worktree', 'add', '../evil'], repo).status, 0, 'names are plain');
	assert.equal(cli(home, ['worktree', 'add', 'w2', '--base', 'main', '--branch', 'feat/x'], repo).status, 0);
	const listed = cli(home, ['worktree', 'list'], repo).out;
	assert.match(listed, /app-w1 {2}agent\/w1/);
	assert.match(listed, /app-w2 {2}feat\/x/);
	// A live agent holding a task there keeps it from being removed.
	fs.mkdirSync(path.join(home, '.introsio', 'sessions'), { recursive: true });
	fs.writeFileSync(path.join(home, '.introsio', 'sessions', 'busy.json'), JSON.stringify({
		sessionId: 'busy', agent: 'codex', workerId: 'codex-9', root: treeKey(dir), agentPid: process.pid, lastSeenAt: Date.now(),
		claims: { t: { taskId: 't', title: 'Busy task', expiresAt: Date.now() + 600_000 } },
	}));
	assert.match(cli(home, ['worktree', 'list'], repo).out, /codex \(workerId codex-9\) on "Busy task"/);
	const refused = cli(home, ['worktree', 'remove', 'w1'], repo);
	assert.notEqual(refused.status, 0);
	assert.match(refused.out, /still holds a task/);
	fs.rmSync(path.join(home, '.introsio', 'sessions', 'busy.json'));
	fs.writeFileSync(path.join(dir, 'half-done.js'), 'x');
	assert.notEqual(cli(home, ['worktree', 'remove', 'w1'], repo).status, 0, 'uncommitted work is never thrown away without --force');
	fs.rmSync(path.join(dir, 'half-done.js'));
	const removed = cli(home, ['worktree', 'remove', 'w1'], repo);
	assert.equal(removed.status, 0, removed.out);
	assert.match(removed.out, /Branch agent\/w1 is kept/);
	assert.ok(!fs.existsSync(dir));
	assert.equal(git(repo, 'rev-parse', '--verify', '--quiet', 'refs/heads/agent/w1').length > 0, true);
	assert.notEqual(cli(home, ['worktree', 'remove', 'app'], repo).status, 0, 'the main checkout is never removed');
});

test('int wait waits until the time given, at most --max, and says to claim again', () => {
	const home = scratch();
	const started = Date.now();
	const done = cli(home, ['wait', new Date(Date.now() + 60 * 60_000).toISOString(), '--max', '1'], home);
	assert.equal(done.status, 0);
	assert.ok(Date.now() - started >= 900 && Date.now() - started < 10_000, 'capped by --max');
	assert.match(done.out, /Waited 1s\. Now call claimTask/);
	assert.match(cli(home, ['wait', new Date(Date.now() - 1000).toISOString()], home).out, /Waited 0s/, 'already past: back at once');
	assert.notEqual(cli(home, ['wait', 'soon'], home).status, 0);
	assert.notEqual(cli(home, ['wait', '5', '--max', '9999'], home).status, 0);
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
