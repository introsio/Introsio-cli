// The daily MCP budget (backend services/billing, docs/adr/0016-plans-and-entitlements.md). When it is
// used up the server refuses metered calls with PLAN_LIMIT_REACHED. The hook must tell the agent when it
// resets, never hold the session to a claim it did not get, and still let it settle what it holds —
// pausing and completing are reporting calls the budget never refuses.
import assert from 'node:assert/strict';
import { scratch, fire, mcpResult, claimPacket } from './helpers.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const RESETS = '2026-11-16T05:00:00.000Z';
const refusal = (key = 'mcpDeveloperPerDay') => ({
	success: false,
	error: "You've used today's 400 developer calls on Free. They reset at 00:00 (your time) — upgrade to Pro for 5,000 a day.",
	status: 402, code: 'PLAN_LIMIT_REACHED', key, limit: 400, used: 400, resetsAt: RESETS, upgradeUrl: 'https://introsio.app/pricing',
});
const post = (home, sid, tool, input, data, isError = false) => fire(home, 'claude', 'PostToolUse', {
	session_id: sid, cwd: home, tool_name: `mcp__introsio__${tool}`, tool_input: input, tool_response: mcpResult(data, isError),
});
const contextOf = (answer) => answer.json?.hookSpecificOutput?.additionalContext ?? '';
const stop = (home, sid) => fire(home, 'claude', 'Stop', { session_id: sid, cwd: home }).json;

test('a claimTask refused by the budget leaves no claim, says when it resets, and lets the agent stop', () => {
	const home = scratch();
	const after = post(home, 'b1', 'claimTask', { projectId: 'proj-1', workerId: 'agent-1' }, refusal(), true);
	assert.match(contextOf(after), /Introsio budget reached, resets 2026-11-16T05:00:00.000Z/);
	assert.match(contextOf(after), /pause what you hold and tell the user/);
	assert.equal(stop(home, 'b1'), null, 'nothing is held, so nothing blocks the stop');
});

test('at 100%, a held task still pauses (a reporting call) and the session is free to stop', () => {
	const home = scratch();
	post(home, 'b2', 'claimTask', { projectId: 'proj-1' }, claimPacket());
	post(home, 'b2', 'getExecutionWaves', { projectId: 'proj-1' }, refusal(), true);
	assert.equal(stop(home, 'b2').decision, 'block', 'the claim is still held until it is settled');
	post(home, 'b2', 'pauseTask', { taskId: 'task-1', workerId: 'agent-1' }, { success: true, task: { id: 'task-1', title: 'Build the API', paused: true }, portable: false });
	assert.equal(stop(home, 'b2'), null, 'paused: nothing left to hold');
});

test('the personal budget is noted the same way; another plan limit (projects) is not a budget note', () => {
	const home = scratch();
	assert.match(contextOf(post(home, 'b3', 'createTask', { name: 'x' }, refusal('mcpPersonalPerDay'), true)), /Introsio budget reached/);
	const other = post(home, 'b3', 'createProject', { name: 'x' }, { ...refusal('projects'), resetsAt: undefined }, true);
	assert.doesNotMatch(contextOf(other), /budget reached/);
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
