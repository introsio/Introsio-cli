// Shared test helpers: scratch homes, scratch git repos, and firing the real hook script.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const HOOK = path.join(KIT, 'hook', 'introsio-hook.mjs');

export function scratch(prefix = 'introsio-test-') {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function git(cwd, ...args) {
	const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
	if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
	return result.stdout.trim();
}

export function makeRepo() {
	const dir = scratch('introsio-repo-');
	git(dir, 'init', '-q', '-b', 'main');
	git(dir, 'config', 'user.email', 'test@example.com');
	git(dir, 'config', 'user.name', 'Test');
	git(dir, 'config', 'commit.gpgsign', 'false');
	fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n');
	git(dir, 'add', '.');
	git(dir, 'commit', '-q', '-m', 'init');
	return dir;
}

/** Fires the real hook script the way an agent would; returns parsed stdout (or null) and the raw result. */
export function fire(home, agent, event, payload, extraEnv = {}) {
	const result = spawnSync(process.execPath, [HOOK, agent, event], {
		input: typeof payload === 'string' ? payload : JSON.stringify(payload),
		encoding: 'utf8',
		env: { ...process.env, INTROSIO_HOME: home, INTROSIO_HOOKS: '', ...extraEnv },
		timeout: 30000,
	});
	let json = null;
	if (result.stdout.trim()) json = JSON.parse(result.stdout);
	return { json, status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** An MCP tool result as Claude Code hands it to PostToolUse: content blocks of JSON text. */
export const mcpResult = (data, isError = false) => (isError
	? { isError: true, content: [{ type: 'text', text: JSON.stringify(data) }] }
	: [{ type: 'text', text: JSON.stringify(data) }]);

export const claimPacket = (overrides = {}) => ({
	claimed: true,
	workerId: 'agent-1',
	leaseExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
	task: { id: 'task-1', title: 'Build the API', description: 'Change `src/api.js` and src/routes/index.js.', subtaskWaves: [[{ id: 's1' }], [{ id: 's2' }]] },
	context: { revision: 4, gaps: [] },
	project: { id: 'proj-1', name: 'Demo', otherReadyTasks: 0 },
	...overrides,
});
