// A project reset revokes the claims agents hold. The server then refuses their finishing writes
// with CLAIM_REVOKED_BY_RESET (backend agentExecutionService). The hook must stop holding the
// session to a task that can no longer be finished — and tell the agent why.
import assert from 'node:assert/strict';
import { scratch, fire, mcpResult, claimPacket } from './helpers.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const claim = (home, sid) => fire(home, 'claude', 'PostToolUse', {
    session_id: sid, cwd: home, tool_name: 'mcp__introsio__claimTask', tool_input: { projectId: 'proj-1' }, tool_response: mcpResult(claimPacket()),
});
const refused = (home, sid, tool, extra) => fire(home, 'claude', 'PostToolUse', {
    session_id: sid, cwd: home, tool_name: `mcp__introsio__${tool}`, tool_input: { taskId: 'task-1', workerId: 'agent-1' },
    tool_response: mcpResult({ success: false, error: 'This project\'s execution was reset ...', status: 409, code: 'CLAIM_REVOKED_BY_RESET', ...extra }, true),
});
const stop = (home, sid) => fire(home, 'claude', 'Stop', { session_id: sid, cwd: home }).json;

test('a completion refused because the project was reset releases the session from the task', () => {
    const home = scratch();
    claim(home, 'r1');
    assert.equal(stop(home, 'r1').decision, 'block', 'still held before the refusal');
    const after = refused(home, 'r1', 'completeTask').json;
    assert.match(after.hookSpecificOutput.additionalContext, /execution was reset, so that work no longer counts/);
    assert.match(after.hookSpecificOutput.additionalContext, /claimTask/);
    assert.equal(stop(home, 'r1'), null, 'nothing left to finish');
});

test('the same for a refused updateSubtask and updateTask', () => {
    for (const tool of ['updateSubtask', 'updateTask']) {
        const home = scratch();
        claim(home, `r-${tool}`);
        refused(home, `r-${tool}`, tool);
        assert.equal(stop(home, `r-${tool}`), null, tool);
    }
});

test('another refusal (a 409 with no code) still keeps the task held', () => {
    const home = scratch();
    claim(home, 'r2');
    fire(home, 'claude', 'PostToolUse', {
        session_id: 'r2', cwd: home, tool_name: 'mcp__introsio__completeTask', tool_input: { taskId: 'task-1', workerId: 'agent-1' },
        tool_response: mcpResult({ success: false, error: 'still waits for X', status: 409 }, true),
    });
    assert.equal(stop(home, 'r2').decision, 'block');
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
