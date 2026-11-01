// The installer per agent, in a scratch HOME: added once, foreign config kept, uninstall clean.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { scratch, KIT, makeRepo } from './helpers.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const ALL = 'claude,codex,gemini,cursor,opencode,vscode,windsurf';

/** Where the VS Code adapter looks, per platform (the tests run on all three). */
function vscodeUserDir(home) {
	if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Code', 'User');
	if (process.platform === 'win32') return path.join(home, 'AppData', 'Roaming', 'Code', 'User');
	return path.join(home, '.config', 'Code', 'User');
}

function cli(home, args, cwd = home) {
	const result = spawnSync(process.execPath, [path.join(KIT, 'cli.mjs'), ...args], {
		cwd, encoding: 'utf8', env: { ...process.env, INTROSIO_TEST_HOME: home, INTROSIO_HOME: path.join(home, '.introsio'), XDG_CONFIG_HOME: '' },
	});
	return { out: result.stdout + result.stderr, status: result.status };
}
const read = (file) => fs.readFileSync(file, 'utf8');
const json = (file) => JSON.parse(read(file));
const write = (file, text) => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
};
const count = (text, needle) => text.split(needle).length - 1;

function seedForeignConfig(home) {
	write(path.join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } }));
	write(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { other: { type: 'http', url: 'https://other' } }, numStartups: 3 }));
	write(path.join(home, '.codex', 'config.toml'), 'model = "gpt-5"\n\n[mcp_servers.other]\nurl = "https://other"\n');
	write(path.join(home, '.gemini', 'settings.json'), JSON.stringify({ theme: 'dark', mcpServers: { other: { httpUrl: 'https://other' } } }));
	write(path.join(home, '.cursor', 'hooks.json'), JSON.stringify({ version: 1, hooks: { stop: [{ command: 'mine.sh' }] } }));
	write(path.join(home, '.config', 'opencode', 'opencode.json'), JSON.stringify({ theme: 'x' }));
	write(path.join(vscodeUserDir(home), 'mcp.json'), JSON.stringify({ servers: { other: { type: 'http', url: 'https://other' } } }));
	write(path.join(home, '.codeium', 'windsurf', 'mcp_config.json'), JSON.stringify({ mcpServers: {} }));
}

test('the published package: both command names, and every file it needs ships', () => {
	const pkg = json(path.join(KIT, 'package.json'));
	assert.deepEqual(Object.keys(pkg.bin).sort(), ['int', 'introsio']);
	assert.equal(pkg.bin.int, pkg.bin.introsio);
	assert.ok(pkg.publishConfig?.access === 'public' && pkg.repository && pkg.engines?.node);
	// On Windows npm is npm.cmd, which only starts through a shell.
	const packed = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: KIT, encoding: 'utf8', shell: process.platform === 'win32' });
	assert.equal(packed.status, 0, packed.stderr);
	const files = JSON.parse(packed.stdout)[0].files.map((file) => file.path);
	for (const needed of ['cli.mjs', 'hook/introsio-hook.mjs', 'hook/engine.mjs', 'templates/execute.md', 'opencode/introsio.template.js', 'agents/claude.mjs', 'lib/lock.mjs', 'README.md']) {
		assert.ok(files.includes(needed), `${needed} must be in the package`);
	}
	assert.ok(!files.some((file) => file.startsWith('test/')), 'tests are not shipped');
	// Windows has no executable bit (npm writes .cmd shims there); elsewhere the bin must be executable.
	if (process.platform !== 'win32') assert.ok(fs.statSync(path.join(KIT, 'cli.mjs')).mode & 0o100, 'cli.mjs is executable');
	assert.match(fs.readFileSync(path.join(KIT, 'cli.mjs'), 'utf8'), /^#!\/usr\/bin\/env node/, 'the bin starts with a node shebang');
});

test('setup detects agents by their folders and installs into each', () => {
	const home = scratch();
	seedForeignConfig(home);
	const { out, status } = cli(home, ['setup']);
	assert.equal(status, 0, out);
	for (const label of ['Claude Code', 'Codex', 'Gemini CLI', 'Cursor', 'OpenCode', 'VS Code', 'Windsurf']) assert.match(out, new RegExp(label));
	assert.ok(fs.existsSync(path.join(home, '.introsio', 'kit', 'hook', 'introsio-hook.mjs')));
});

test('running setup twice adds everything once and keeps foreign config', () => {
	const home = scratch();
	seedForeignConfig(home);
	cli(home, ['setup', '--agents', ALL]);
	cli(home, ['setup', '--agents', ALL]);
	const claude = json(path.join(home, '.claude', 'settings.json'));
	assert.equal(claude.model, 'opus');
	assert.equal(claude.hooks.Stop.length, 2, 'user Stop hook + ours');
	assert.equal(count(JSON.stringify(claude.hooks), 'introsio-hook.mjs'), 6);
	const claudeJson = json(path.join(home, '.claude.json'));
	assert.equal(claudeJson.numStartups, 3);
	assert.deepEqual(Object.keys(claudeJson.mcpServers).sort(), ['introsio', 'other']);
	const toml = read(path.join(home, '.codex', 'config.toml'));
	assert.equal(count(toml, '[mcp_servers.introsio]'), 1);
	assert.match(toml, /model = "gpt-5"/);
	assert.match(toml, /\[mcp_servers\.other\]/);
	assert.equal(json(path.join(home, '.gemini', 'settings.json')).theme, 'dark');
	assert.equal(json(path.join(home, '.gemini', 'settings.json')).mcpServers.introsio.httpUrl, 'https://api.introsio.app/mcp?toolset=developer');
	const cursor = json(path.join(home, '.cursor', 'hooks.json'));
	assert.equal(cursor.hooks.stop.length, 2);
	assert.equal(json(path.join(home, '.config', 'opencode', 'opencode.json')).mcp.introsio.type, 'remote');
	assert.match(read(path.join(home, '.config', 'opencode', 'plugins', 'introsio.js')), /file:\/\/.*\.introsio\/kit\/hook\/engine\.mjs/);
	assert.equal(json(path.join(vscodeUserDir(home), 'mcp.json')).servers.introsio.type, 'http');
	assert.equal(json(path.join(home, '.codeium', 'windsurf', 'mcp_config.json')).mcpServers.introsio.serverUrl, 'https://api.introsio.app/mcp?toolset=developer');
	for (const file of ['.claude/commands/introsio-execute.md', '.codex/prompts/introsio-execute.md', '.gemini/commands/introsio-execute.toml', '.cursor/commands/introsio-execute.md', '.config/opencode/commands/introsio-execute.md', path.relative(home, path.join(vscodeUserDir(home), 'prompts', 'introsio-execute.prompt.md'))]) {
		assert.ok(fs.existsSync(path.join(home, file)), file);
	}
});

// OpenCode runs plugins on Bun, which accepts ES modules in a bare .js file. Node 18
// (and 20 before 20.19) does not detect module syntax without a package scope, so the test
// imports a copy named .mjs. The installed file itself is unchanged.
async function importInstalledPlugin(home, query = '') {
	const source = path.join(home, '.config', 'opencode', 'plugins', 'introsio.js');
	const copy = path.join(home, `introsio-plugin-${Date.now()}.mjs`);
	fs.copyFileSync(source, copy);
	return import(`${pathToFileURL(copy).href}${query}`);
}

test('the installed OpenCode plugin loads and exposes its hooks', async () => {
	const home = scratch();
	cli(home, ['setup', '--agents', 'opencode']);
	const plugin = await importInstalledPlugin(home);
	const hooks = await plugin.IntrosioPlugin({ client: { session: { prompt: async () => {} } }, directory: home });
	assert.equal(typeof hooks['tool.execute.before'], 'function');
	assert.equal(typeof hooks.event, 'function');
});

test('the OpenCode plugin refuses, notes and sends the agent back like the other agents', async () => {
	const home = scratch();
	const state = path.join(home, 'state');
	process.env.INTROSIO_HOME = state;
	try {
		cli(home, ['setup', '--agents', 'opencode']);
		const prompts = [];
		const plugin = await importInstalledPlugin(home);
		const hooks = await plugin.IntrosioPlugin({ client: { session: { prompt: async (request) => { prompts.push(request); } } }, directory: home });
		const packet = { claimed: true, workerId: 'oc-1', task: { id: 't1', title: 'OpenCode task' }, project: { id: 'p' } };
		await hooks['tool.execute.before']({ tool: 'introsio_claimTask', sessionID: 'oc', callID: 'c1' }, { args: { projectId: 'p' } });
		const after = { title: '', output: JSON.stringify(packet), metadata: {} };
		await hooks['tool.execute.after']({ tool: 'introsio_claimTask', sessionID: 'oc', callID: 'c1' }, after);
		await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'oc' } } });
		await new Promise((resolve) => { setTimeout(resolve, 20); });
		assert.equal(prompts.length, 1);
		assert.equal(prompts[0].path.id, 'oc');
		assert.match(prompts[0].body.parts[0].text, /OpenCode task/);
		await assert.rejects(
			hooks['tool.execute.before']({ tool: 'introsio_claimTask', sessionID: 'oc', callID: 'c2' }, { args: { projectId: 'p' } }),
			/pass a workerId/,
		);
	} finally {
		delete process.env.INTROSIO_HOME;
	}
});

test('uninstall removes only what setup added', () => {
	const home = scratch();
	seedForeignConfig(home);
	const before = {
		gemini: json(path.join(home, '.gemini', 'settings.json')),
		cursor: json(path.join(home, '.cursor', 'hooks.json')),
	};
	cli(home, ['setup', '--agents', ALL]);
	cli(home, ['uninstall']);
	const claude = json(path.join(home, '.claude', 'settings.json'));
	assert.deepEqual(claude, { model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } });
	assert.deepEqual(Object.keys(json(path.join(home, '.claude.json')).mcpServers), ['other']);
	assert.equal(read(path.join(home, '.codex', 'config.toml')).includes('introsio'), false);
	assert.match(read(path.join(home, '.codex', 'config.toml')), /\[mcp_servers\.other\]/);
	assert.deepEqual(json(path.join(home, '.gemini', 'settings.json')), before.gemini);
	assert.deepEqual(json(path.join(home, '.cursor', 'hooks.json')), before.cursor);
	assert.equal(fs.existsSync(path.join(home, '.claude', 'commands', 'introsio-execute.md')), false);
	assert.equal(fs.existsSync(path.join(home, '.config', 'opencode', 'plugins', 'introsio.js')), false);
	assert.equal(fs.existsSync(path.join(home, '.introsio', 'kit')), false);
});

test('a config file with comments is never rewritten — setup prints what to add', () => {
	const home = scratch();
	const file = path.join(vscodeUserDir(home), 'mcp.json');
	const original = '{\n  // my servers\n  "servers": {}\n}\n';
	write(file, original);
	const { out } = cli(home, ['setup', '--agents', 'vscode']);
	assert.equal(read(file), original);
	assert.match(out, /manual — add "introsio"/);
});

test('an existing user-defined Codex server is left alone', () => {
	const home = scratch();
	write(path.join(home, '.codex', 'config.toml'), '[mcp_servers.introsio]\nurl = "http://localhost:8080/mcp"\n');
	const { out } = cli(home, ['setup', '--agents', 'codex']);
	assert.match(out, /already configured/);
	assert.equal(count(read(path.join(home, '.codex', 'config.toml')), '[mcp_servers.introsio]'), 1);
});

test('--project installs into the repository with repo-relative hook paths', () => {
	const home = scratch();
	const repo = makeRepo();
	cli(home, ['setup', '--agents', 'claude,codex,cursor,opencode,windsurf', '--project', repo]);
	assert.ok(fs.existsSync(path.join(repo, '.introsio', 'kit', 'hook', 'introsio-hook.mjs')));
	assert.match(read(path.join(repo, '.claude', 'settings.json')), /\$CLAUDE_PROJECT_DIR.*introsio-hook\.mjs/);
	assert.equal(json(path.join(repo, '.mcp.json')).mcpServers.introsio.type, 'http');
	assert.match(read(path.join(repo, '.codex', 'hooks.json')), /node \.introsio\/kit\/hook\/introsio-hook\.mjs codex/);
	assert.match(read(path.join(repo, '.opencode', 'plugins', 'introsio.js')), /from '\.\.\/\.\.\/\.introsio\/kit\/hook\/engine\.mjs'/);
	assert.equal(fs.existsSync(path.join(home, '.claude', 'settings.json')), false, 'nothing global');
});

test('--url and --dry-run', () => {
	const home = scratch();
	const dry = cli(home, ['setup', '--agents', 'cursor', '--dry-run', '--url', 'http://localhost:8080/mcp']);
	assert.match(dry.out, /Dry run/);
	assert.equal(fs.existsSync(path.join(home, '.cursor', 'mcp.json')), false);
	cli(home, ['setup', '--agents', 'cursor', '--url', 'http://localhost:8080/mcp']);
	assert.equal(json(path.join(home, '.cursor', 'mcp.json')).mcpServers.introsio.url, 'http://localhost:8080/mcp');
	cli(home, ['setup', '--agents', 'gemini']);
	assert.equal(json(path.join(home, '.gemini', 'settings.json')).mcpServers.introsio.httpUrl, 'http://localhost:8080/mcp', 'the URL is remembered');
});

test('mode / gate / features / claims / stats / doctor commands', () => {
	const home = scratch();
	const repo = makeRepo();
	assert.match(cli(home, ['mode', 'local'], repo).out, /stays on this computer/);
	assert.match(cli(home, ['mode'], repo).out, /local/);
	assert.match(cli(home, ['gate', 'set', 'node -v', '--timeout', '30'], repo).out, /"node -v"/);
	assert.match(cli(home, ['gate', 'run'], repo).out, /passed/);
	assert.match(cli(home, ['disable', 'secrets']).out, /secrets: off/);
	assert.match(cli(home, ['features']).out, /· secrets/);
	assert.match(cli(home, ['status'], repo).out, /mode local · test gate "node -v"/);
	assert.match(cli(home, ['claims']).out, /No open claims/);
	assert.match(cli(home, ['stats']).out, /No Introsio calls/);
	cli(home, ['setup', '--agents', 'claude']);
	const doctor = cli(home, ['doctor']);
	assert.match(doctor.out, /✓ hook fires and refuses a stop/, doctor.out);
	assert.match(cli(home, ['mode', 'sideways'], repo).out, /mode must be one of/);
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
