// One table of cases per feature — pure decisions with fake git / clocks.
import assert from 'node:assert/strict';
import { pushDecision, scanDiff, scanText, gitInvocations } from '../hook/features/git.mjs';
import { shippedDecision, planTestGate, runTestGate, resolveMode, porcelainPaths } from '../hook/features/gates.mjs';
import { workerIdDecision, makeWorkerId } from '../hook/features/workerId.mjs';
import { rereadDecision, leaseNote, recoveryNote, scopeNote } from '../hook/features/notes.mjs';
import { applyIntrosioResult, extractPaths } from '../hook/features/claims.mjs';
import { emptySession } from '../hook/state.mjs';
import { parseToolResult, normalize, bareToolName, isIntrosioTool, patchFiles } from '../hook/normalize.mjs';
import { respond } from '../hook/respond.mjs';
import { summarize } from '../hook/features/log.mjs';
import { claimPacket } from './helpers.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const NOW = Date.parse('2026-10-29T12:00:00Z');

const fakeGit = (over = {}) => ({
	root: () => '/repo', branch: () => 'feature/x', defaultBranch: () => 'main', dirty: () => [], upstream: () => 'origin/feature/x',
	aheadOfUpstream: () => 0, head: () => 'abc', diff: () => '', run: () => ({ ok: true, out: '' }), ...over,
});
const session = () => {
	const s = emptySession('s', 'claude', NOW);
	applyIntrosioResult(s, { name: 'claimTask', args: { projectId: 'proj-1' }, result: { ok: true, data: claimPacket({ leaseExpiresAt: new Date(NOW + 30 * 60_000).toISOString() }) } }, NOW);
	return s;
};

// ── push guard ───────────────────────────────────────────────────────────────
for (const [command, mode, expect] of [
	['git push', 'github', 'none'],
	['git push origin feature/x', 'github', 'none'],
	['git push -u origin feature/x', 'github', 'none'],
	['git push origin main', 'github', 'deny'],
	['git push origin HEAD:main', 'github', 'deny'],
	['git push origin +feature/x', 'github', 'deny'],
	['git push --force origin feature/x', 'github', 'deny'],
	['git push -f', 'github', 'deny'],
	['git push --force-with-lease origin feature/x', 'github', 'none'],
	['git push --mirror', 'github', 'deny'],
	['git push origin --delete main', 'github', 'deny'],
	['npm test && git push origin main', 'github', 'deny'],
	['git -C sub push origin main', 'github', 'deny'],
	['git push origin feature/x', 'local', 'deny'],
	['git push origin main', 'off', 'none'],
	['git status', 'local', 'none'],
	['echo "git push origin main" > notes.txt', 'github', 'none'],
	['git commit -m "fix; git push origin main"', 'github', 'none'],
]) {
	test(`push guard [${mode}] ${command} → ${expect}`, () => {
		assert.equal(pushDecision({ command, mode, git: fakeGit() }).type, expect);
	});
}
test('push guard: on the default branch, a bare push is refused', () => {
	assert.equal(pushDecision({ command: 'git push', mode: 'github', git: fakeGit({ branch: () => 'main' }) }).type, 'deny');
});

// ── secrets ──────────────────────────────────────────────────────────────────
// Fake secrets are assembled at run time so this file never contains one.
const AWS = `AKIA${'Q'.repeat(16)}`;
const GH = `ghp_${'a1'.repeat(18)}`;
const PEM = ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' ');
test('secrets: added lines are found with file and line, never the value', () => {
	const diff = `diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1,2 +1,3 @@\n const a = 1;\n+const key = "${AWS}";\n const b = 2;\n@@ -10,0 +11,1 @@\n+// ${GH}\n`;
	const findings = scanDiff(diff);
	assert.deepEqual(findings.map((f) => `${f.file}:${f.line}:${f.kind}`), ['src/a.js:2:AWS access key', 'src/a.js:11:GitHub token']);
	assert.ok(!JSON.stringify(findings).includes(AWS));
});
test('secrets: removed lines and context lines are ignored', () => {
	assert.equal(scanDiff(`+++ b/x.js\n@@ -1,1 +1,1 @@\n-const key = "${AWS}";\n const ok = 1;\n`).length, 0);
});
test("secrets: vendors' documented examples and allow comments are not findings", () => {
	assert.equal(scanDiff('+++ b/t.js\n@@ -0,0 +1 @@\n+const k = "AKIAIOSFODNN7EXAMPLE";\n').length, 0);
	assert.equal(scanDiff(`+++ b/t.js\n@@ -0,0 +1 @@\n+const k = "${AWS}"; // int:allow-secret\n`).length, 0);
	assert.equal(scanDiff(`+++ b/t.js\n@@ -0,0 +1 @@\n+const k = "${AWS}";\n`).length, 1);
});
test('secrets: .env is a secret file, .env.example is not', () => {
	assert.equal(scanDiff('+++ b/.env\n@@ -0,0 +1 @@\n+A=1\n')[0].kind, 'secret file');
	assert.equal(scanDiff('+++ b/config/.env.example\n@@ -0,0 +1 @@\n+A=1\n').length, 0);
	assert.equal(scanText('deploy/key.pem', `${PEM}\nabc`).length, 2);
});
test('gitInvocations finds subcommands past global options', () => {
	assert.deepEqual(gitInvocations('cd x && git -c a=b --no-pager commit -m "msg; git push"').map((c) => c.sub), ['commit']);
	assert.deepEqual(gitInvocations('git add . && git commit -m x; git push origin main').map((c) => c.sub), ['add', 'commit', 'push']);
});

// ── shipped gate ─────────────────────────────────────────────────────────────
const claimFor = (repository) => ({ taskId: 't', title: 'T', repository, branch: null });
test('mode: github when the claim names a repository, local otherwise, config wins', () => {
	assert.equal(resolveMode({ mode: null }, claimFor({ fullName: 'a/b' })), 'github');
	assert.equal(resolveMode({ mode: null }, claimFor(null)), 'local');
	assert.equal(resolveMode({ mode: 'local' }, claimFor({ fullName: 'a/b' })), 'local');
});
for (const [label, mode, gitOver, args, expect] of [
	['local: clean → ok', 'local', {}, {}, 'none'],
	['local: dirty → deny', 'local', { dirty: () => [' M src/a.js'] }, {}, 'deny'],
	['local: unpushed is fine', 'local', { upstream: () => null }, {}, 'none'],
	['github: dirty → deny', 'github', { dirty: () => ['?? new.js'] }, { outcome: { branch: 'feature/x' } }, 'deny'],
	['github: on main → deny', 'github', { branch: () => 'main' }, { outcome: { branch: 'main' } }, 'deny'],
	['github: no upstream → deny', 'github', { upstream: () => null }, { outcome: { branch: 'feature/x' } }, 'deny'],
	['github: ahead → deny', 'github', { aheadOfUpstream: () => 2 }, { outcome: { branch: 'feature/x' } }, 'deny'],
	['github: no branch recorded → deny', 'github', {}, {}, 'deny'],
	['github: all good → ok', 'github', {}, { outcome: { branch: 'feature/x' } }, 'none'],
	['github: detached HEAD → deny', 'github', { branch: () => 'HEAD' }, { outcome: { branch: 'x' } }, 'deny'],
	["local: only the task's files count — someone else's WIP is ignored", 'local', { dirty: () => ['?? my-notes.txt'] }, { outcome: { files: ['src/api.js'] } }, 'none'],
	["local: the task's own uncommitted file → deny", 'local', { dirty: () => ['?? my-notes.txt', ' M src/api.js'] }, { outcome: { files: ['src/api.js'] } }, 'deny'],
	['local: a listed folder covers its files', 'local', { dirty: () => [' M src/routes/index.js'] }, { outcome: { files: ['src/routes/'] } }, 'deny'],
	['off → ok even when dirty', 'off', { dirty: () => [' M a'] }, {}, 'none'],
	['not a git repo → ok', 'local', { root: () => null, dirty: () => [' M a'] }, {}, 'none'],
]) {
	test(`shipped gate ${label}`, () => {
		const answer = shippedDecision({ git: fakeGit(gitOver), settings: { mode }, claim: claimFor(mode === 'github' ? { fullName: 'a/b', defaultBranch: 'main' } : null), args, session: emptySession('s', 'claude', NOW) });
		assert.equal(answer.type, expect, answer.message);
	});
}

// ── test gate ────────────────────────────────────────────────────────────────
const memoryCache = () => {
	const store = new Map();
	return { get: (k) => store.get(k), set: (k, v) => store.set(k, v) };
};
test('test gate: fail refuses with the output tail, a pass is cached for the same tree', async () => {
	const cache = memoryCache();
	let runs = 0;
	const settings = { gate: 'npm test', gateTimeoutSec: 60 };
	const git = fakeGit({ run: (args) => ({ ok: true, out: args[0] === 'status' ? '' : '' }) });
	const failRun = async () => { runs += 1; return { ok: false, code: 1, output: 'FAIL api.test.js\n1 failing', ms: 5 }; };
	const okRun = async () => { runs += 1; return { ok: true, code: 0, output: '', ms: 5 }; };
	const denied = await runTestGate(planTestGate({ git, settings, cache }), { claim: claimFor(null), cache, runGate: failRun, now: NOW });
	assert.equal(denied.type, 'deny');
	assert.match(denied.message, /1 failing/);
	assert.equal((await runTestGate(planTestGate({ git, settings, cache }), { claim: claimFor(null), cache, runGate: okRun, now: NOW })).type, 'none');
	assert.equal(planTestGate({ git, settings, cache }), null, 'same tree → cached, nothing to run');
	assert.equal(runs, 2);
	const changed = fakeGit({ head: () => 'def', run: () => ({ ok: true, out: '' }) });
	assert.ok(planTestGate({ git: changed, settings, cache }), 'another commit → runs again');
});
test('test gate: timeout says so; no gate set → nothing runs; an unreadable tree is never cached', async () => {
	const cache = memoryCache();
	const plan = planTestGate({ git: fakeGit(), settings: { gate: 'x', gateTimeoutSec: 1 }, cache });
	const answer = await runTestGate(plan, { claim: claimFor(null), cache, runGate: async () => ({ ok: false, timedOut: true }), now: NOW });
	assert.match(answer.message, /did not finish in 1s/);
	assert.equal(planTestGate({ git: fakeGit(), settings: { gate: null }, cache }), null);
	const broken = fakeGit({ run: () => ({ ok: false, out: '' }) });
	const brokenPlan = planTestGate({ git: broken, settings: { gate: 'x', gateTimeoutSec: 5 }, cache });
	assert.equal(brokenPlan.key, null);
	await runTestGate(brokenPlan, { claim: claimFor(null), cache, runGate: async () => ({ ok: true }), now: NOW });
	assert.ok(planTestGate({ git: broken, settings: { gate: 'x', gateTimeoutSec: 5 }, cache }), 'still runs next time');
});
test('test gate: the timeout is capped below the agents\' hook timeout', () => {
	assert.equal(planTestGate({ git: fakeGit(), settings: { gate: 'x', gateTimeoutSec: 5000 }, cache: memoryCache() }).timeoutSec, 840);
});
test('porcelain paths: plain, renamed and quoted', () => {
	assert.deepEqual(porcelainPaths(' M src/a.js'), ['src/a.js']);
	assert.deepEqual(porcelainPaths('R  old.js -> new.js'), ['old.js', 'new.js']);
	assert.deepEqual(porcelainPaths('?? "with space.js"'), ['with space.js']);
});

// ── worker id ────────────────────────────────────────────────────────────────
test('worker id: generated ids are valid and per session', () => {
	const id = makeWorkerId('claude', '1234abcd-ef00-0000', 'My Laptop.local');
	assert.match(id, /^[A-Za-z0-9._:-]{1,64}$/);
	assert.notEqual(id, makeWorkerId('claude', 'ffff0000-ef00-0000', 'My Laptop.local'));
});
test('worker id: a live session using the same workerId blocks the claim', () => {
	const mine = emptySession('me', 'codex', NOW);
	mine.workerId = 'codex-host-me';
	const other = { ...emptySession('other', 'claude', NOW), workerId: 'agent-1', agentPid: 4242, claims: { t: { taskId: 't', workerId: 'agent-1', expiresAt: NOW + 60_000 } } };
	const alive = (pid) => pid === 4242;
	const answer = workerIdDecision(mine, [other], { name: 'claimTask', args: { projectId: 'p', workerId: 'agent-1' } }, NOW, alive);
	assert.equal(answer.type, 'deny');
	assert.match(answer.message, /codex-host-me/);
	const expired = { ...other, claims: { t: { taskId: 't', workerId: 'agent-1', expiresAt: NOW - 1 } } };
	assert.equal(workerIdDecision(mine, [expired], { name: 'claimTask', args: { workerId: 'agent-1' } }, NOW, alive).type, 'none');
	// The other agent crashed: its process is gone, so its workerId is free to resume with.
	assert.equal(workerIdDecision(mine, [other], { name: 'claimTask', args: { workerId: 'agent-1' } }, NOW, () => false).type, 'none');
	// No pid known: live only while heard from in the last 10 minutes.
	const noPid = { ...other, agentPid: null, lastSeenAt: NOW - 11 * 60_000 };
	assert.equal(workerIdDecision(mine, [noPid], { name: 'claimTask', args: { workerId: 'agent-1' } }, NOW, alive).type, 'none');
	assert.equal(workerIdDecision(mine, [{ ...noPid, lastSeenAt: NOW - 60_000 }], { name: 'claimTask', args: { workerId: 'agent-1' } }, NOW, alive).type, 'deny');
});
test('worker id: a second claim without workerId while holding a task is refused', () => {
	const s = session();
	assert.equal(workerIdDecision(s, [], { name: 'claimTask', args: { projectId: 'p' } }, NOW).type, 'deny');
	assert.equal(workerIdDecision(emptySession('x', 'claude', NOW), [], { name: 'claimTask', args: { projectId: 'p' } }, NOW).type, 'none');
});

// ── re-read guard ────────────────────────────────────────────────────────────
test('re-read: context already read at this revision is refused once, then allowed', () => {
	const s = session();
	applyIntrosioResult(s, { name: 'getProjectContext', args: { projectId: 'proj-1' }, result: { ok: true, data: { revision: 4 } } }, NOW);
	const call = { name: 'getProjectContext', args: { projectId: 'proj-1' } };
	assert.equal(rereadDecision(s, call).type, 'deny');
	assert.equal(rereadDecision(s, call).type, 'none');
});
test('re-read: a moved revision or a compaction allows the read', () => {
	const s = session();
	applyIntrosioResult(s, { name: 'getProjectContext', args: { projectId: 'proj-1' }, result: { ok: true, data: { revision: 4 } } }, NOW);
	s.contextRevision['proj-1'] = 5;
	assert.equal(rereadDecision(s, { name: 'getProjectContext', args: { projectId: 'proj-1' } }).type, 'none');
	s.contextRevision['proj-1'] = 4;
	s.contextLost = true;
	assert.equal(rereadDecision(s, { name: 'getProjectContext', args: { projectId: 'proj-1' } }).type, 'none');
});
test('re-read: the schedule right after a completion that named nowReady is refused once', () => {
	const s = session();
	applyIntrosioResult(s, { name: 'completeTask', args: { taskId: 'task-1' }, result: { ok: true, data: { success: true, task: { id: 'task-1', completed: true }, nowReady: [{ id: 'task-2' }] } } }, NOW);
	const answer = rereadDecision(s, { name: 'getExecutionWaves', args: { projectId: 'proj-1' } });
	assert.equal(answer.type, 'deny');
	assert.match(answer.message, /task-2/);
	assert.equal(rereadDecision(s, { name: 'getExecutionWaves', args: { projectId: 'proj-1' } }).type, 'none');
});

// ── lease, recovery, scope ───────────────────────────────────────────────────
test('lease: quiet before 60%, one nudge after, again only after the next write', () => {
	const s = session();
	assert.equal(leaseNote(s, NOW + 10 * 60_000), null);
	assert.match(leaseNote(s, NOW + 19 * 60_000), /expires at 12:30 UTC/);
	assert.equal(leaseNote(s, NOW + 20 * 60_000), null);
	applyIntrosioResult(s, { name: 'updateSubtask', args: { taskId: 'task-1' }, result: { ok: true, data: { success: true, task: { id: 'task-1', claim: { expiresAt: new Date(NOW + 51 * 60_000).toISOString() }, subtasks: { total: 2, open: 1 } } } } }, NOW + 21 * 60_000);
	assert.equal(leaseNote(s, NOW + 25 * 60_000), null);
	assert.match(leaseNote(s, NOW + 52 * 60_000), /expired/);
});
test('recovery: names the task, workerId, progress and context revision', () => {
	const s = session();
	s.claims['task-1'].subtasks = { total: 2, done: 1 };
	const note = recoveryNote(s);
	assert.match(note, /agent-1/);
	assert.match(note, /Build the API/);
	assert.match(note, /subtasks 1\/2 done/);
	assert.match(note, /context revision 4/);
	assert.equal(recoveryNote(emptySession('x', 'claude', NOW)), null);
});
test('scope: named files and folders pass, others warn once', () => {
	const s = session();
	assert.equal(scopeNote(s, ['/repo/src/api.js', '/repo/src/routes/index.js'], '/repo'), null);
	assert.match(scopeNote(s, ['/repo/src/other.js'], '/repo'), /src\/other\.js/);
	assert.equal(scopeNote(s, ['/repo/src/other.js'], '/repo'), null);
	assert.equal(scopeNote(s, ['/repo/package-lock.json'], '/repo'), null);
});
test('extractPaths reads backticked and bare paths, not URLs', () => {
	assert.deepEqual(extractPaths('Edit `src/a.ts`, src/b/c.js and see https://x.y/z.html. Also `README.md`.').sort(), ['README.md', 'src/a.ts', 'src/b/c.js']);
});

// ── normalize / respond ──────────────────────────────────────────────────────
test('tool names: every agent spelling of an Introsio tool is recognised', () => {
	for (const raw of ['mcp__introsio__claimTask', 'mcp__Introsio__updateTask', 'mcp_introsio_getTasks', 'introsio_completeTask', 'claimTask', 'mcp__myserver__getExecutionWaves']) {
		assert.ok(isIntrosioTool(raw, 'claude'), raw);
	}
	assert.equal(isIntrosioTool('mcp__linear__updateTask', 'claude'), false);
	assert.equal(bareToolName('mcp__introsio__claimTask'), 'claimTask');
});
test('results: content blocks, wrapped, Gemini parts, strings and errors', () => {
	const data = { success: true, task: { id: 't' } };
	assert.equal(parseToolResult([{ type: 'text', text: JSON.stringify(data) }]).data.task.id, 't');
	assert.equal(parseToolResult({ content: [{ type: 'text', text: JSON.stringify(data) }] }).ok, true);
	assert.equal(parseToolResult({ llmContent: [{ text: JSON.stringify(data) }] }).ok, true);
	assert.equal(parseToolResult(JSON.stringify(data)).ok, true);
	assert.equal(parseToolResult({ isError: true, content: [{ type: 'text', text: '{"success":false,"error":"x"}' }] }).ok, false);
	assert.equal(parseToolResult(JSON.stringify({ claimed: false, reason: 'complete' })).ok, true);
});
test('apply_patch and shell argv are understood', () => {
	assert.deepEqual(patchFiles('*** Begin Patch\n*** Update File: src/a.js\n@@\n*** Add File: b.js\n*** End Patch'), ['src/a.js', 'b.js']);
	const evt = normalize('codex', 'PreToolUse', { session_id: 's', tool_name: 'shell', tool_input: { command: ['bash', '-lc', 'git push origin main'] } });
	assert.equal(evt.tool.kind, 'shell');
	assert.equal(evt.tool.command, 'git push origin main');
});
test('respond: each agent gets its own format', () => {
	const pre = { event: 'before-tool', hookEvent: 'PreToolUse' };
	assert.equal(respond('claude', pre, { type: 'deny', message: 'no' }).hookSpecificOutput.permissionDecision, 'deny');
	assert.deepEqual(respond('gemini', { event: 'before-tool', hookEvent: 'BeforeTool' }, { type: 'deny', message: 'no' }), { decision: 'deny', reason: 'no' });
	assert.equal(respond('cursor', { event: 'before-tool' }, { type: 'deny', message: 'no' }).permission, 'deny');
	assert.deepEqual(respond('cursor', { event: 'stop' }, { type: 'block', message: 'go on' }), { followup_message: 'go on' });
	assert.deepEqual(respond('claude', { event: 'stop', hookEvent: 'Stop' }, { type: 'block', message: 'go on' }), { decision: 'block', reason: 'go on' });
	assert.equal(respond('claude', { event: 'after-tool', hookEvent: 'PostToolUse' }, { type: 'context', message: 'n' }).hookSpecificOutput.additionalContext, 'n');
	assert.equal(respond('codex', { event: 'session-start', hookEvent: 'PostCompact' }, { type: 'context', message: 'n' }).hookSpecificOutput.hookEventName, 'SessionStart');
	assert.equal(respond('claude', pre, { type: 'none' }), null);
});

// ── stats ────────────────────────────────────────────────────────────────────
test('stats: refusals, averages and retry loops', () => {
	const row = (tool, ok, extra = {}) => ({ at: '2026-10-29T12:00:00Z', session: 's', tool, ok, taskId: 't1', ...extra });
	const summary = summarize([
		row('claimTask', true, { ms: 100 }),
		row('completeTask', false, { error: 'Outcome needs a verification.', ms: 50 }),
		row('completeTask', false, { error: 'Outcome needs a verification.' }),
		row('completeTask', false, { error: 'Outcome needs a verification.' }),
		row('completeTask', true, { at: '2026-10-29T12:30:00Z' }),
	]);
	assert.equal(summary.calls, 5);
	assert.equal(summary.refused, 3);
	assert.equal(summary.topErrors[0].count, 3);
	assert.equal(summary.retryLoops.length, 1);
	assert.equal(summary.tasks[0].completed, true);
	assert.equal(summary.tasks[0].minutes, 30);
	assert.equal(summary.tools.find((t) => t.tool === 'claimTask').avgMs, 100);
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
