// The git checks against real repositories, through the real hook script.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { scratch, makeRepo, git, fire, mcpResult, claimPacket } from './helpers.js';
import { writeJson } from '../lib/jsonFile.mjs';
import { repoKey } from '../lib/paths.mjs';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function setupSession(home, repo, sid, packet = claimPacket()) {
	fire(home, 'claude', 'PostToolUse', {
		session_id: sid, cwd: repo, tool_name: 'mcp__introsio__claimTask', tool_input: { projectId: 'proj-1' }, tool_response: mcpResult(packet),
	});
}
const complete = (home, repo, sid, outcome = { summary: 's', verification: 'v' }) => fire(home, 'claude', 'PreToolUse', {
	session_id: sid, cwd: repo, tool_name: 'mcp__introsio__completeTask', tool_input: { taskId: 'task-1', workerId: 'agent-1', outcome },
}).json;
const bash = (home, repo, sid, command) => fire(home, 'claude', 'PreToolUse', { session_id: sid, cwd: repo, tool_name: 'Bash', tool_input: { command } }).json;
const denied = (answer) => answer?.hookSpecificOutput?.permissionDecision === 'deny';
const config = (home, repo, settings) => writeJson(path.join(home, 'config.json'), { features: {}, repos: { [repoKey(repo)]: settings } });

test('local mode (no repository on the claim): uncommitted work blocks completion, a commit unblocks it', () => {
	const home = scratch();
	const repo = makeRepo();
	setupSession(home, repo, 'l1');
	fs.writeFileSync(path.join(repo, 'api.js'), 'export {}\n');
	const answer = complete(home, repo, 'l1');
	assert.ok(denied(answer));
	assert.match(answer.hookSpecificOutput.permissionDecisionReason, /local mode.*api\.js/s);
	git(repo, 'add', '.');
	git(repo, 'commit', '-q', '-m', 'api');
	assert.equal(complete(home, repo, 'l1'), null);
});

test('local mode: every git push is blocked', () => {
	const home = scratch();
	const repo = makeRepo();
	setupSession(home, repo, 'l2');
	assert.ok(denied(bash(home, repo, 'l2', 'git push origin feature')));
	assert.equal(bash(home, repo, 'l2', 'git status'), null);
});

test('github mode (claim names a repository): unpushed work and a missing branch block completion', () => {
	const home = scratch();
	const remote = scratch('introsio-remote-');
	git(remote, 'init', '-q', '--bare');
	const repo = makeRepo();
	git(repo, 'remote', 'add', 'origin', remote);
	git(repo, 'push', '-q', 'origin', 'main');
	setupSession(home, repo, 'g1', claimPacket({ repository: { fullName: 'me/demo', defaultBranch: 'main' } }));
	assert.match(complete(home, repo, 'g1').hookSpecificOutput.permissionDecisionReason, /default branch/);
	git(repo, 'switch', '-q', '-c', 'feature/api');
	fs.writeFileSync(path.join(repo, 'api.js'), 'x\n');
	git(repo, 'add', '.');
	git(repo, 'commit', '-q', '-m', 'api');
	assert.match(complete(home, repo, 'g1').hookSpecificOutput.permissionDecisionReason, /not pushed/);
	assert.ok(denied(bash(home, repo, 'g1', 'git push origin main')), 'push to main is blocked');
	assert.ok(denied(bash(home, repo, 'g1', 'git push --force -u origin feature/api')), 'force push is blocked');
	assert.equal(bash(home, repo, 'g1', 'git push -u origin feature/api'), null);
	git(repo, 'push', '-q', '-u', 'origin', 'feature/api');
	assert.match(complete(home, repo, 'g1', { summary: 's', verification: 'v' }).hookSpecificOutput.permissionDecisionReason, /outcome\.branch/);
	assert.equal(complete(home, repo, 'g1', { summary: 's', verification: 'v', branch: 'feature/api' }), null);
});

test('secrets: a staged key blocks the commit and the message never contains it', () => {
	const home = scratch();
	const repo = makeRepo();
	setupSession(home, repo, 's1');
	const key = `AKIA${'Z'.repeat(16)}`;
	fs.writeFileSync(path.join(repo, 'config.js'), `export const key = "${key}";\n`);
	git(repo, 'add', '.');
	const answer = bash(home, repo, 's1', 'git commit -m "add config"');
	assert.ok(denied(answer));
	const reason = answer.hookSpecificOutput.permissionDecisionReason;
	assert.match(reason, /config\.js:1 — AWS access key/);
	assert.ok(!reason.includes(key));
});

test('secrets: `git add . && git commit` scans the untracked files it is about to add', () => {
	const home = scratch();
	const repo = makeRepo();
	setupSession(home, repo, 's2');
	fs.writeFileSync(path.join(repo, '.env'), 'TOKEN=1\n');
	assert.ok(denied(bash(home, repo, 's2', 'git add . && git commit -m wip')));
});

test('outside an Introsio session the git guards stay out of the way', () => {
	const home = scratch();
	const repo = makeRepo();
	assert.equal(bash(home, repo, 'plain', 'git push origin main'), null);
});

test('test gate: a failing check blocks completion; a pass is cached until the work tree changes', () => {
	const home = scratch();
	const repo = makeRepo();
	// The marker lives outside the repo, so flipping it changes the check's result but not the tree.
	const marker = path.join(scratch('introsio-marker-'), 'pass');
	// A node script, not sh: the check must run the same on Windows, macOS and Linux.
	fs.writeFileSync(path.join(repo, 'check.js'), `const fs = require('node:fs');\nif (fs.existsSync(${JSON.stringify(marker)})) { console.log('ok'); } else { console.log('1 test failing'); process.exit(1); }\n`);
	git(repo, 'add', '.');
	git(repo, 'commit', '-q', '-m', 'check');
	config(home, repo, { mode: 'off', gate: 'node check.js' });
	setupSession(home, repo, 't1');
	assert.match(complete(home, repo, 't1').hookSpecificOutput.permissionDecisionReason, /1 test failing/);
	fs.writeFileSync(marker, '');
	assert.equal(complete(home, repo, 't1'), null, 'passes');
	fs.rmSync(marker);
	assert.equal(complete(home, repo, 't1'), null, 'same tree → cached pass, the check is not run again');
	fs.writeFileSync(path.join(repo, 'more.js'), 'x\n');
	assert.ok(denied(complete(home, repo, 't1')), 'tree changed → runs again and fails');
});

test('gate and mode only apply to tasks this session claimed', () => {
	const home = scratch();
	const repo = makeRepo();
	fs.writeFileSync(path.join(repo, 'dirty.js'), 'x\n');
	const answer = fire(home, 'claude', 'PreToolUse', { session_id: 'u1', cwd: repo, tool_name: 'mcp__introsio__completeTask', tool_input: { taskId: 'groceries' } }).json;
	assert.equal(answer, null);
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
