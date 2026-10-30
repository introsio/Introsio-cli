// Production edge cases, each reproduced first against the earlier kit and kept here
// as a regression test. R-numbers match the research notes in README.md ("Edge cases").
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { scratch, makeRepo, git, fire, mcpResult, claimPacket, HOOK, KIT } from './helpers.js';
import { runCommand } from '../lib/processTree.mjs';
import { workTreeKey } from '../hook/features/gates.mjs';
import { createGit } from '../lib/git.mjs';
import { scanDiff } from '../hook/features/git.mjs';
import { hookCommand } from '../agents/common.mjs';
import { capMessage } from '../hook/respond.mjs';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const claim = (home, sid, cwd = home, packet = claimPacket(), agent = 'claude') => fire(home, agent, 'PostToolUse', {
	session_id: sid, cwd, tool_name: 'mcp__introsio__claimTask', tool_input: { projectId: 'proj-1' }, tool_response: mcpResult(packet),
});
const stop = (home, sid, extra = {}) => fire(home, 'claude', 'Stop', { session_id: sid, cwd: home, ...extra }).json;
const isAliveCheck = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('R1 hooks of parallel tool calls never lose a claim (session lock)', async () => {
	const home = scratch();
	claim(home, 'p', home, claimPacket({ task: { id: 'seed', title: 'seed' } }));
	await Promise.all(Array.from({ length: 16 }, (_, i) => new Promise((resolve) => {
		const child = spawn(process.execPath, [HOOK, 'claude', 'PostToolUse'], { env: { ...process.env, INTROSIO_HOME: home } });
		child.stdin.end(JSON.stringify({ session_id: 'p', cwd: home, tool_name: 'mcp__introsio__claimTask', tool_input: {}, tool_response: mcpResult(claimPacket({ workerId: `w${i}`, task: { id: `t${i}`, title: `T${i}` } })) }));
		child.on('close', resolve);
	})));
	const claims = JSON.parse(fs.readFileSync(path.join(home, 'sessions', 'p.json'), 'utf8')).claims;
	assert.equal(Object.keys(claims).length, 17);
	assert.equal(fs.readdirSync(path.join(home, 'sessions')).some((name) => name.endsWith('.lock')), false, 'lock released');
});

test('R2 a timed-out gate kills everything it started', async () => {
	// A unique duration makes the processes findable: `sleep 41.<n>`.
	const marker = `sleep 41.${process.pid % 997}${Date.now() % 1000}`;
	const started = Date.now();
	const result = await runCommand(`sh -c '${marker}; true' & ${marker}`, { cwd: scratch(), timeoutSec: 1 });
	assert.equal(result.timedOut, true);
	assert.ok(Date.now() - started < 5000);
	await new Promise((resolve) => { setTimeout(resolve, 300); });
	const left = spawnSync('pgrep', ['-f', marker], { encoding: 'utf8' }).stdout.trim();
	assert.equal(left, '', `orphans still running: ${left}`);
});

test('R3 the gate cache tells large trees apart', () => {
	const repo = makeRepo();
	fs.writeFileSync(path.join(repo, 'big.txt'), 'a\n'.repeat(9_000_000));
	git(repo, 'add', '.');
	git(repo, 'commit', '-q', '-m', 'big');
	fs.writeFileSync(path.join(repo, 'big.txt'), 'b\n'.repeat(9_000_000));
	const first = workTreeKey(createGit(repo), 'npm test');
	assert.equal(workTreeKey(createGit(repo), 'npm test'), first, 'deterministic for the same tree');
	fs.writeFileSync(path.join(repo, 'big.txt'), 'c\n'.repeat(9_000_000));
	assert.notEqual(workTreeKey(createGit(repo), 'npm test'), first);
	assert.equal(git(repo, 'stash', 'list'), '', 'git stash create leaves no stash behind');
});

test('R4 a bare `git push` that lands on main is refused (push.default=upstream)', () => {
	const home = scratch();
	const remote = scratch();
	git(remote, 'init', '-q', '--bare');
	const repo = makeRepo();
	git(repo, 'remote', 'add', 'origin', remote);
	git(repo, 'push', '-q', '-u', 'origin', 'main');
	git(repo, 'switch', '-q', '-c', 'work');
	git(repo, 'branch', '-q', '--set-upstream-to=origin/main');
	git(repo, 'config', 'push.default', 'upstream');
	claim(home, 'g', repo, claimPacket({ repository: { fullName: 'a/b', defaultBranch: 'main' } }));
	const answer = fire(home, 'claude', 'PreToolUse', { session_id: 'g', cwd: repo, tool_name: 'Bash', tool_input: { command: 'git push' } }).json;
	assert.equal(answer?.hookSpecificOutput?.permissionDecision, 'deny');
});

test("R5 the person's own uncommitted work never blocks the agent's completion", () => {
	const home = scratch();
	const repo = makeRepo();
	fs.writeFileSync(path.join(repo, 'my-notes.txt'), 'personal WIP\n');
	claim(home, 'u', repo);
	fs.writeFileSync(path.join(repo, 'api.js'), 'x\n');
	fire(home, 'claude', 'PostToolUse', { session_id: 'u', cwd: repo, tool_name: 'Write', tool_input: { file_path: path.join(repo, 'api.js') }, tool_response: 'ok' });
	const complete = () => fire(home, 'claude', 'PreToolUse', { session_id: 'u', cwd: repo, tool_name: 'mcp__introsio__completeTask', tool_input: { taskId: 'task-1', outcome: { summary: 's', verification: 'v' } } }).json;
	assert.match(complete().hookSpecificOutput.permissionDecisionReason, /api\.js/, 'its own file still counts');
	assert.doesNotMatch(complete().hookSpecificOutput.permissionDecisionReason, /my-notes/);
	git(repo, 'add', 'api.js');
	git(repo, 'commit', '-q', '-m', 'api');
	assert.equal(complete(), null);
});

test("R6 a subagent's stop is not held to the parent's claims", () => {
	const home = scratch();
	claim(home, 'sa');
	assert.equal(fire(home, 'claude', 'SubagentStop', { session_id: 'sa', cwd: home }).json, null);
	assert.equal(stop(home, 'sa').decision, 'block', 'the parent still is');
});

test('R7 a task that no longer exists is dropped, and a released set never re-blocks', () => {
	const home = scratch();
	claim(home, 'd');
	fire(home, 'claude', 'PostToolUse', { session_id: 'd', cwd: home, tool_name: 'mcp__introsio__completeTask', tool_input: { taskId: 'task-1' }, tool_response: mcpResult({ success: false, error: 'Task not found.', status: 404 }, true) });
	assert.equal(stop(home, 'd'), null);
	// A claim the agent deliberately leaves open: one reminder, then a visible warning, then quiet.
	claim(home, 'e');
	const seq = Array.from({ length: 5 }, (_, i) => {
		const answer = stop(home, 'e', { stop_hook_active: i > 0 });
		return answer?.decision ?? (answer?.systemMessage ? 'warn' : 'none');
	});
	assert.deepEqual(seq, ['block', 'warn', 'none', 'none', 'none']);
	// A new claim is a new set: it gets its reminder.
	claim(home, 'e', home, claimPacket({ task: { id: 'task-2', title: 'Second' } }));
	assert.equal(stop(home, 'e').decision, 'block');
});

test('R8 payloads without a session id never share state across agent processes', () => {
	const home = scratch();
	fire(home, 'claude', 'PostToolUse', { cwd: home, tool_name: 'mcp__introsio__claimTask', tool_input: {}, tool_response: mcpResult(claimPacket()) });
	const other = spawnSync(process.execPath, ['-e', `const r=require('child_process').spawnSync(process.execPath,[${JSON.stringify(HOOK)},'claude','Stop'],{input:'{}',encoding:'utf8',env:{...process.env,INTROSIO_HOME:${JSON.stringify(home)}}});process.stdout.write(r.stdout)`], { encoding: 'utf8' });
	assert.equal(other.stdout.trim(), '');
});

test("R9 a crashed session's workerId can be reused after a restart", () => {
	const home = scratch();
	fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
	let deadPid = 999_999;
	while (isAliveCheck(deadPid)) deadPid -= 1;
	fs.writeFileSync(path.join(home, 'sessions', 'dead.json'), JSON.stringify({ sessionId: 'dead', agent: 'claude', workerId: 'agent-1', lastSeenAt: Date.now() - 60_000, agentPid: deadPid, claims: { t: { taskId: 't', workerId: 'agent-1', expiresAt: Date.now() + 20 * 60_000 } } }));
	const ask = () => fire(home, 'claude', 'PreToolUse', { session_id: 'new', cwd: home, tool_name: 'mcp__introsio__claimTask', tool_input: { projectId: 'p', workerId: 'agent-1' } }).json;
	assert.equal(ask(), null);
	// …but a live one still protects its id.
	fs.writeFileSync(path.join(home, 'sessions', 'dead.json'), JSON.stringify({ sessionId: 'dead', agent: 'claude', workerId: 'agent-1', lastSeenAt: Date.now(), agentPid: process.pid, claims: { t: { taskId: 't', workerId: 'agent-1', expiresAt: Date.now() + 20 * 60_000 } } }));
	assert.equal(ask()?.hookSpecificOutput?.permissionDecision, 'deny');
});

test('R10 nothing a hook says can flood the context', async () => {
	assert.ok(capMessage('E'.repeat(500_000)).length <= 6000);
	const result = await runCommand(`node -e "process.stdout.write('E'.repeat(400000)); process.exit(1)"`, { cwd: scratch(), timeoutSec: 20 });
	assert.ok(result.output.length <= 3001, `${result.output.length}`);
});

test("R11 vendors' documented example keys are not secrets", () => {
	assert.equal(scanDiff('+++ b/test/s3.test.js\n@@ -0,0 +1 @@\n+const key = "AKIAIOSFODNN7EXAMPLE";\n').length, 0);
});

test('R12 + R13 global hooks name the absolute Node binary, with portable paths', () => {
	const home = scratch();
	spawnSync(process.execPath, [path.join(KIT, 'cli.mjs'), 'setup', '--agents', 'claude'], { env: { ...process.env, INTROSIO_TEST_HOME: home, INTROSIO_HOME: path.join(home, '.introsio') } });
	const command = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')).hooks.Stop[0].hooks[0].command;
	assert.ok(command.startsWith(`"${process.execPath.replace(/\\/g, '/')}" `), command);
	const win = hookCommand({ scope: 'user', hookScript: 'C:\\Users\\me\\.introsio\\kit\\hook\\introsio-hook.mjs', nodePath: 'C:\\Program Files\\nodejs\\node.exe' }, 'claude', 'Stop');
	assert.equal(win, '"C:/Program Files/nodejs/node.exe" "C:/Users/me/.introsio/kit/hook/introsio-hook.mjs" claude Stop');
});

test("R14 a gate timeout beyond the agents' hook timeout is refused", () => {
	const home = scratch();
	const repo = makeRepo();
	const result = spawnSync(process.execPath, [path.join(KIT, 'cli.mjs'), 'gate', 'set', 'true', '--timeout', '3000'], { cwd: repo, encoding: 'utf8', env: { ...process.env, INTROSIO_HOME: home } });
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /at most 840s/);
});

test('R15 Codex always gets JSON on stdout', () => {
	const home = scratch();
	claim(home, 'cz', home, claimPacket(), 'codex');
	fire(home, 'codex', 'PostToolUse', { session_id: 'cz', cwd: home, tool_name: 'mcp__introsio__completeTask', tool_input: { taskId: 'task-1' }, tool_response: mcpResult({ success: true, task: { id: 'task-1', completed: true }, nowReady: [] }) });
	assert.deepEqual(fire(home, 'codex', 'Stop', { session_id: 'cz', cwd: home }).json, {});
	assert.deepEqual(fire(home, 'codex', 'PreToolUse', { session_id: 'cz', cwd: home, tool_name: 'Bash', tool_input: { command: 'ls' } }).json, {});
});

test('R16 a task another worker took over no longer holds this session', () => {
	const home = scratch();
	claim(home, 'l');
	const after = fire(home, 'claude', 'PostToolUse', { session_id: 'l', cwd: home, tool_name: 'mcp__introsio__completeTask', tool_input: { taskId: 'task-1', workerId: 'agent-1' }, tool_response: mcpResult({ success: false, error: 'claimed by worker "agent-9"', status: 409, claimedBy: { workerId: 'agent-9' } }, true) }).json;
	assert.match(after.hookSpecificOutput.additionalContext, /agent-9 holds it now/);
	assert.equal(stop(home, 'l'), null);
	// A 409 naming our own worker (we forgot workerId) keeps the claim.
	claim(home, 'm');
	fire(home, 'claude', 'PostToolUse', { session_id: 'm', cwd: home, tool_name: 'mcp__introsio__completeTask', tool_input: { taskId: 'task-1' }, tool_response: mcpResult({ success: false, error: 'claimed', status: 409, claimedBy: { workerId: 'agent-1' } }, true) });
	assert.equal(stop(home, 'm').decision, 'block');
});

test('R17 the stop message offers a way to pause when the person asked to stop', () => {
	const home = scratch();
	claim(home, 'pause');
	const reason = stop(home, 'pause').reason;
	assert.match(reason, /statusState: "pending"/);
	// The user's own instruction comes before "do the work": releasing is the first option offered.
	assert.ok(reason.indexOf('statusState: "pending"') < reason.indexOf('completeTask {'), 'release is offered before completion');
	assert.match(reason, /follow what the user asked/);
});

test('R18 a hook never waits for stdin EOF once the payload is complete', async () => {
	const home = scratch();
	const child = spawn(process.execPath, [HOOK, 'claude', 'Stop'], { env: { ...process.env, INTROSIO_HOME: home } });
	child.stdin.write(JSON.stringify({ session_id: 'x', cwd: home }));
	const exited = await new Promise((resolve) => {
		const timer = setTimeout(() => resolve(false), 4000);
		child.on('close', () => { clearTimeout(timer); resolve(true); });
	});
	child.kill();
	assert.equal(exited, true);
});

test('R19 a long transcript is read incrementally', () => {
	const home = scratch();
	const transcript = path.join(home, 't.jsonl');
	const filler = `${JSON.stringify({ type: 'message', text: 'claimed nothing here '.repeat(100) })}\n`;
	fs.writeFileSync(transcript, filler.repeat(20_000) + `${JSON.stringify({ payload: { output: JSON.stringify(claimPacket()) } })}\n`);
	assert.equal(fire(home, 'codex', 'Stop', { session_id: 'big', cwd: home, transcript_path: transcript }).json.decision, 'block');
	const offset = JSON.parse(fs.readFileSync(path.join(home, 'sessions', 'big.json'), 'utf8')).transcript.offset;
	assert.equal(offset, fs.statSync(transcript).size, 'next stop starts at the end');
	fs.appendFileSync(transcript, `${JSON.stringify({ payload: { output: JSON.stringify({ success: true, task: { id: 'task-1', completed: true }, nowReady: [] }) } })}\n`);
	assert.deepEqual(fire(home, 'codex', 'Stop', { session_id: 'big', cwd: home, transcript_path: transcript }).json, {}, 'the appended completion is seen');
});

test('R20 the context re-read refusal tells a subagent how to get through', () => {
	const home = scratch();
	claim(home, 'r');
	fire(home, 'claude', 'PostToolUse', { session_id: 'r', cwd: home, tool_name: 'mcp__introsio__getProjectContext', tool_input: { projectId: 'proj-1' }, tool_response: mcpResult({ revision: 4 }) });
	const ask = () => fire(home, 'claude', 'PreToolUse', { session_id: 'r', cwd: home, tool_name: 'mcp__introsio__getProjectContext', tool_input: { projectId: 'proj-1' } }).json;
	assert.match(ask().hookSpecificOutput.permissionDecisionReason, /subagent/);
	assert.equal(ask(), null);
});

test('R21 a parallel worker without a workerId is told to pick its own', () => {
	const home = scratch();
	claim(home, 'pw');
	const answer = fire(home, 'claude', 'PreToolUse', { session_id: 'pw', cwd: home, tool_name: 'mcp__introsio__claimTask', tool_input: { projectId: 'proj-1' } }).json;
	assert.match(answer.hookSpecificOutput.permissionDecisionReason, /agent-1-2/);
});

test('R22 a broken settings file is never overwritten by a command', () => {
	const home = scratch();
	const file = path.join(home, 'config.json');
	fs.writeFileSync(file, '{ "features": { "secrets": false }, "repos": { BROKEN');
	const result = spawnSync(process.execPath, [path.join(KIT, 'cli.mjs'), 'disable', 'lease'], { encoding: 'utf8', env: { ...process.env, INTROSIO_HOME: home } });
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /not valid JSON/);
	assert.match(fs.readFileSync(file, 'utf8'), /BROKEN/);
	// …while the hooks keep working on defaults.
	claim(home, 'b');
	assert.equal(stop(home, 'b').decision, 'block');
});

test('R23 an internal hook error is logged, never printed, and the agent still gets valid output', () => {
	const home = scratch();
	fs.writeFileSync(path.join(home, 'sessions'), 'a file where the sessions folder should be');
	const result = fire(home, 'codex', 'PostToolUse', { session_id: 'z', cwd: home, tool_name: 'mcp__introsio__claimTask', tool_input: {}, tool_response: mcpResult(claimPacket()) });
	assert.equal(result.status, 0);
	assert.deepEqual(result.json, {});
	assert.match(fs.readFileSync(path.join(home, 'errors.log'), 'utf8'), /codex PostToolUse/);
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
