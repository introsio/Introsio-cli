// The hook end to end: the real script, real stdin/stdout, per agent.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { scratch, fire, mcpResult, claimPacket } from './helpers.js';
import { handleEvent } from '../hook/engine.mjs';
import { normalize } from '../hook/normalize.mjs';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const claim = (home, sid, agent = 'claude', data = claimPacket()) => fire(home, agent, 'PostToolUse', {
	session_id: sid, cwd: home, tool_name: 'mcp__introsio__claimTask', tool_input: { projectId: 'proj-1', workerId: 'agent-1' }, tool_response: mcpResult(data),
});
const stop = (home, sid, extra = {}) => fire(home, 'claude', 'Stop', { session_id: sid, cwd: home, ...extra });

test('claude: a claim then a stop is refused with the task named', () => {
	const home = scratch();
	claim(home, 's1');
	const { json, status } = stop(home, 's1');
	assert.equal(status, 0);
	assert.equal(json.decision, 'block');
	assert.match(json.reason, /Build the API/);
	assert.match(json.reason, /completeTask/);
	assert.match(json.reason, /task-1/);
});

test('a refused completeTask keeps the stop refused', () => {
	const home = scratch();
	claim(home, 's2');
	fire(home, 'claude', 'PostToolUse', {
		session_id: 's2', cwd: home, tool_name: 'mcp__introsio__completeTask', tool_input: { taskId: 'task-1' },
		tool_response: mcpResult({ success: false, error: 'Outcome needs a verification.' }, true),
	});
	assert.equal(stop(home, 's2').json.decision, 'block');
});

test('a successful completeTask lets the agent stop', () => {
	const home = scratch();
	claim(home, 's3');
	fire(home, 'claude', 'PostToolUse', {
		session_id: 's3', cwd: home, tool_name: 'mcp__introsio__completeTask', tool_input: { taskId: 'task-1', workerId: 'agent-1' },
		tool_response: mcpResult({ success: true, task: { id: 'task-1', completed: true }, nowReady: [{ id: 'task-2' }], openTasks: 3 }),
	});
	const result = stop(home, 's3');
	assert.equal(result.json, null);
});

test('updateTask blocked releases the task', () => {
	const home = scratch();
	claim(home, 's4');
	fire(home, 'claude', 'PostToolUse', {
		session_id: 's4', cwd: home, tool_name: 'mcp__introsio__updateTask', tool_input: { taskId: 'task-1', statusState: 'blocked' },
		tool_response: mcpResult({ success: true, task: { id: 'task-1', statusState: 'blocked' } }),
	});
	assert.equal(stop(home, 's4').json, null);
});

test('loop guard: refuses twice, then lets it stop with a warning', () => {
	const home = scratch();
	claim(home, 's5');
	assert.equal(stop(home, 's5').json.decision, 'block');
	assert.equal(stop(home, 's5', { stop_hook_active: true }).json.decision, 'block');
	const third = stop(home, 's5', { stop_hook_active: true }).json;
	assert.ok(third.systemMessage, 'third stop is allowed with a visible warning');
	assert.equal(third.decision, undefined);
});

test('garbage stdin exits 0 with no output', () => {
	const home = scratch();
	const result = fire(home, 'claude', 'Stop', 'this is { not json');
	assert.equal(result.status, 0);
	assert.equal(result.stdout, '');
});

test('INTROSIO_HOOKS=off turns everything off', () => {
	const home = scratch();
	claim(home, 's6');
	assert.equal(fire(home, 'claude', 'Stop', { session_id: 's6' }, { INTROSIO_HOOKS: 'off' }).json, null);
});

test('sessions are independent', () => {
	const home = scratch();
	claim(home, 'a');
	assert.equal(stop(home, 'b').json, null);
});

test('codex: transcript fallback finds an open claim when after-tool never fired', () => {
	const home = scratch();
	const transcript = path.join(home, 'rollout.jsonl');
	const output = JSON.stringify(claimPacket());
	fs.writeFileSync(transcript, `${JSON.stringify({ type: 'function_call_output', payload: { output } })}\n`);
	const result = fire(home, 'codex', 'Stop', { session_id: 'cx', cwd: home, transcript_path: transcript });
	assert.equal(result.json.decision, 'block');
	// …and a later completion in the transcript closes it.
	fs.appendFileSync(transcript, `${JSON.stringify({ type: 'function_call_output', payload: { output: JSON.stringify({ success: true, task: { id: 'task-1', completed: true }, nowReady: [] }) } })}\n`);
	assert.equal(fire(home, 'codex', 'Stop', { session_id: 'cx2', cwd: home, transcript_path: transcript }).json, null);
});

test('gemini: AfterAgent refuses with decision deny', () => {
	const home = scratch();
	fire(home, 'gemini', 'AfterTool', {
		session_id: 'g', cwd: home, tool_name: 'claimTask', mcp_context: { server_name: 'introsio' },
		tool_input: { projectId: 'proj-1' }, tool_response: { llmContent: JSON.stringify(claimPacket()) },
	});
	// Gemini wraps results its own way — the claim must still be recognised from the raw response.
	const result = fire(home, 'gemini', 'AfterAgent', { session_id: 'g', cwd: home });
	assert.equal(result.json?.decision, 'deny');
});

test('cursor: stop answers followup_message; before hooks always answer JSON', () => {
	const home = scratch();
	fire(home, 'cursor', 'afterMCPExecution', {
		conversation_id: 'c', workspace_roots: [home], tool_name: 'claimTask', tool_input: JSON.stringify({ projectId: 'proj-1' }), result_json: JSON.stringify(claimPacket()),
	});
	assert.match(fire(home, 'cursor', 'stop', { conversation_id: 'c', status: 'completed', loop_count: 0 }).json.followup_message, /Build the API/);
	assert.deepEqual(fire(home, 'cursor', 'beforeShellExecution', { conversation_id: 'c', command: 'ls', cwd: home }).json, {});
});

test('a session that never uses Introsio leaves no state behind', () => {
	const home = scratch();
	fire(home, 'claude', 'PostToolUse', { session_id: 'plain', cwd: home, tool_name: 'Read', tool_input: { file_path: 'x' }, tool_response: 'ok' });
	fire(home, 'claude', 'PreToolUse', { session_id: 'plain', cwd: home, tool_name: 'Bash', tool_input: { command: 'git commit -m x' } });
	assert.equal(stop(home, 'plain').json, null);
	assert.equal(fs.existsSync(path.join(home, 'sessions', 'plain.json')), false);
});

test('the engine decides in well under 100 ms', () => {
	const home = scratch();
	const env = { INTROSIO_HOME: home };
	claim(home, 'perf');
	const evt = normalize('claude', 'Stop', { session_id: 'perf', cwd: home, stop_hook_active: false });
	handleEvent(evt, { env });
	const started = process.hrtime.bigint();
	for (let i = 0; i < 20; i += 1) handleEvent(evt, { env });
	const perCall = Number(process.hrtime.bigint() - started) / 20 / 1e6;
	assert.ok(perCall < 100, `engine took ${perCall.toFixed(1)} ms`);
	const spawnStart = Date.now();
	stop(home, 'perf');
	console.log(`    (engine ${perCall.toFixed(2)} ms/call; full hook process ${Date.now() - spawnStart} ms incl. Node start-up)`);
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
