#!/usr/bin/env node
// int — the Introsio agent kit: connect coding agents to Introsio, run projects with
// /introsio-execute, and manage the hooks that keep Introsio updated.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AGENTS, agentById } from './agents/index.mjs';
import { Writer, nodePathOf, COMMANDS, commandText } from './agents/common.mjs';
import { FEATURES, MODES, loadConfig, saveConfig, repoSettings, updateRepo, featureOn } from './lib/config.mjs';
import { MAX_GATE_TIMEOUT_SEC } from './hook/features/gates.mjs';
import { createGit } from './lib/git.mjs';
import { homeDir, introsioDir, kitDir, logPath, configPath } from './lib/paths.mjs';
import { readText } from './lib/jsonFile.mjs';
import { loadOtherSessions, clearSessions } from './hook/state.mjs';
import { summarize } from './hook/features/log.mjs';
import { runGateCommand } from './hook/features/gates.mjs';
import { listLocalPauses, removeLocalPause } from './hook/features/pause.mjs';
import { sessionIsLive } from './hook/features/workerId.mjs';

const KIT_SOURCE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_URL = 'https://api.introsio.app/mcp?toolset=developer';
// Which tools the agents load: `developer` plans and executes; `execute` is the slim set for running a
// plan that already exists (about a third of the definitions, so every turn is cheaper).
const KIT_TOOLSETS = ['developer', 'execute', 'all'];

/** `url` with its toolset replaced; a URL that cannot be parsed is left alone. */
function withToolset(url, toolset) {
	try {
		const parsed = new URL(url);
		parsed.searchParams.set('toolset', toolset);
		return parsed.toString();
	} catch {
		return url;
	}
}

/** The MCP URL a run of setup uses: --url, else the remembered one, else the default; --toolset switches its tools. */
function mcpUrlFor(flags, config) {
	const base = typeof flags.url === 'string' ? flags.url : (config.mcpUrl ?? DEFAULT_URL);
	return typeof flags.toolset === 'string' && KIT_TOOLSETS.includes(flags.toolset) ? withToolset(base, flags.toolset) : base;
}
const KIT_DIRS = ['hook', 'lib'];
const VERSION = JSON.parse(readText(path.join(KIT_SOURCE, 'package.json')) ?? '{"version":"0"}').version;

process.stdout.on('error', (error) => {
	if (error.code === 'EPIPE') process.exit(0);
});
const out = (line = '') => process.stdout.write(`${line}\n`);
const fail = (message) => {
	process.stderr.write(`introsio: ${message}\n`);
	process.exitCode = 1;
};

function parseArgs(argv) {
	const positional = [];
	const flags = {};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg.startsWith('--')) {
			const [key, inline] = arg.slice(2).split('=', 2);
			if (inline !== undefined) flags[key] = inline;
			else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) flags[key] = argv[(i += 1)];
			else flags[key] = true;
		} else positional.push(arg);
	}
	return { positional, flags };
}

function context(flags, env = process.env) {
	const scope = flags.project ? 'project' : 'user';
	const root = scope === 'project' ? path.resolve(flags.project === true ? '.' : flags.project) : null;
	const config = loadConfig(env, { strict: true });
	const kitInstallDir = scope === 'project' ? path.join(root, '.introsio', 'kit') : kitDir(env);
	return {
		env,
		home: homeDir(env),
		scope,
		root,
		platform: process.platform,
		url: mcpUrlFor(flags, config),
		kitSource: KIT_SOURCE,
		kitInstallDir,
		hookScript: path.join(kitInstallDir, 'hook', 'introsio-hook.mjs'),
		nodePath: process.execPath,
		executeTemplate: readText(path.join(KIT_SOURCE, 'templates', 'execute.md')),
		templates: Object.fromEntries(COMMANDS.map((command) => [command.name, readText(path.join(KIT_SOURCE, 'templates', command.template)) ?? ''])),
	};
}

function selectedAgents(ctx, flags) {
	if (typeof flags.agents === 'string') {
		const ids = flags.agents.split(',').map((id) => id.trim()).filter(Boolean);
		const unknown = ids.filter((id) => !agentById(id));
		if (unknown.length) throw new Error(`unknown agent(s): ${unknown.join(', ')} — choose from ${AGENTS.map((a) => a.id).join(', ')}`);
		return ids.map(agentById);
	}
	return AGENTS.filter((agent) => agent.detect(ctx));
}

/** Copies the hook engine to where the agents' configs point, so they never depend on this checkout. */
function installKit(ctx, writer) {
	const copy = (from, to) => {
		for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
			const source = path.join(from, entry.name);
			const target = path.join(to, entry.name);
			if (entry.isDirectory()) copy(source, target);
			else if (/\.(mjs|js|json)$/.test(entry.name)) writer.writeText(target, fs.readFileSync(source, 'utf8'));
		}
	};
	for (const dir of KIT_DIRS) copy(path.join(KIT_SOURCE, dir), path.join(ctx.kitInstallDir, dir));
	writer.writeText(path.join(ctx.kitInstallDir, 'package.json'), `${JSON.stringify({ type: 'module', private: true, introsio: VERSION }, null, 2)}\n`);
}

function suggestGate(dir) {
	const pkg = (() => { try { return JSON.parse(readText(path.join(dir, 'package.json')) ?? ''); } catch { return null; } })();
	if (pkg?.scripts?.test && !/no test specified/.test(pkg.scripts.test)) return 'npm test';
	if (fs.existsSync(path.join(dir, 'Makefile')) && /^test:/m.test(readText(path.join(dir, 'Makefile')) ?? '')) return 'make test';
	if (fs.existsSync(path.join(dir, 'Cargo.toml'))) return 'cargo test';
	if (fs.existsSync(path.join(dir, 'go.mod'))) return 'go test ./...';
	if (fs.existsSync(path.join(dir, 'pyproject.toml')) || fs.existsSync(path.join(dir, 'pytest.ini'))) return 'pytest -q';
	return null;
}

function setup(flags) {
	if (flags.toolset !== undefined && !KIT_TOOLSETS.includes(flags.toolset)) return fail(`--toolset takes one of: ${KIT_TOOLSETS.join(', ')}`);
	const ctx = context(flags);
	if (flags.print) {
		const agent = agentById(String(flags.print));
		if (!agent?.print) return fail(`nothing to print for ${flags.print}`);
		out(JSON.stringify(agent.print(ctx), null, 2));
		return;
	}
	const agents = selectedAgents(ctx, flags).filter((agent) => !(ctx.scope === 'project' && agent.userOnly));
	if (agents.length === 0) {
		out('No coding agents found. Name them: int setup --agents claude,codex,gemini,cursor,opencode,vscode,windsurf');
		process.exitCode = 1;
		return;
	}
	const writer = new Writer({ dryRun: !!flags['dry-run'] });
	installKit(ctx, writer);
	out(`${flags['dry-run'] ? 'Would install' : 'Installing'} Introsio for ${agents.map((a) => a.label).join(', ')} (${ctx.scope === 'project' ? `project ${ctx.root}` : 'every project — global'})`);
	out(`MCP server: ${ctx.url}`);
	out('');
	const next = [];
	for (const agent of agents) {
		try {
			const report = agent.install(ctx, writer);
			out(`● ${agent.label}`);
			out(`    connect:  ${report.connect}`);
			if (report.command) out(`    commands: /introsio-execute, /introsio-pause, /introsio-resume → ${path.dirname(report.command)}`);
			out(`    hooks:    ${report.hooks}`);
			for (const line of report.next) next.push(`${agent.label}: ${line}`);
		} catch (error) {
			out(`● ${agent.label}: failed — ${error.message}`);
		}
	}
	if (!flags['dry-run'] && (typeof flags.url === 'string' || typeof flags.toolset === 'string')) {
		const config = loadConfig(undefined, { strict: true });
		config.mcpUrl = ctx.url;
		saveConfig(config);
	}
	out('');
	out('Next:');
	for (const line of next) out(`  - ${line}`);
	const git = createGit(process.cwd());
	const root = git.root();
	if (root && !repoSettings(loadConfig(undefined, { strict: true }), root).gate) {
		const suggestion = suggestGate(root);
		if (suggestion) out(`  - Test gate for this repo (tasks complete only when it passes): int gate set "${suggestion}"`);
	}
	out('  - Check everything: int doctor');
	if (flags['dry-run']) {
		out('');
		out('Dry run — files that would change:');
		for (const action of writer.actions) out(`  ${action}`);
	}
}

function uninstall(flags) {
	const ctx = context(flags);
	const agents = typeof flags.agents === 'string' ? selectedAgents(ctx, flags) : AGENTS;
	const writer = new Writer({ dryRun: !!flags['dry-run'] });
	for (const agent of agents) {
		if (ctx.scope === 'project' && agent.userOnly) continue;
		try { agent.uninstall(ctx, writer); } catch (error) { out(`${agent.label}: ${error.message}`); }
	}
	if (typeof flags.agents !== 'string') writer.remove(ctx.kitInstallDir);
	out(writer.actions.length ? `Removed Introsio from:\n${writer.actions.map((a) => `  ${a}`).join('\n')}` : 'Nothing to remove.');
	out('Your settings and log in ~/.introsio stay; delete that folder to remove them too.');
}

function repoRoot(flags) {
	const root = createGit(path.resolve(typeof flags.repo === 'string' ? flags.repo : '.')).root();
	if (!root) throw new Error('not inside a git repository (use --repo <dir>)');
	return path.resolve(root);
}

function status(flags) {
	const ctx = context(flags);
	out(`int ${VERSION} — hook engine ${fs.existsSync(ctx.hookScript) ? `installed at ${ctx.kitInstallDir}` : 'NOT installed (run int setup)'}`);
	out('');
	for (const agent of AGENTS) {
		if (!agent.detect(ctx)) continue;
		const s = agent.status(ctx);
		out(`● ${agent.label.padEnd(18)} connect: ${s.connect.padEnd(4)}  commands: ${String(s.command).padEnd(4)}  hooks: ${s.hooks}`);
	}
	const config = loadConfig(undefined, { strict: true });
	out('');
	out(`Features: ${Object.keys(FEATURES).map((name) => `${name}${featureOn(config, name) ? '' : ' (off)'}`).join(', ')}`);
	const root = createGit(process.cwd()).root();
	if (root) {
		const settings = repoSettings(config, root);
		out(`This repo (${root}): mode ${settings.mode ?? 'auto (github if the project is linked to GitHub, else local)'} · test gate ${settings.gate ? `"${settings.gate}" (${settings.gateTimeoutSec}s)` : 'off'}`);
	}
	if (String(process.env.INTROSIO_HOOKS ?? '').toLowerCase() === 'off') out('INTROSIO_HOOKS=off is set in this shell — hooks do nothing here.');
}

function mode(positional, flags) {
	const value = positional[1];
	const root = repoRoot(flags);
	const config = loadConfig(undefined, { strict: true });
	if (!value) {
		out(`${root}: ${repoSettings(config, root).mode ?? 'auto'}`);
		return;
	}
	if (value !== 'auto' && !MODES.includes(value)) return fail(`mode must be one of: ${MODES.join(', ')}, auto`);
	saveConfig(updateRepo(config, root, { mode: value === 'auto' ? null : value }));
	const explain = {
		github: 'tasks complete only when the work is committed, pushed on its own branch and outcome.branch is recorded; pushes to the default branch and force pushes are blocked',
		local: 'the code stays on this computer: tasks complete once the work is committed, and every git push is blocked',
		off: 'no git checks before completing; push guard off',
		auto: 'github when the Introsio project is linked to a GitHub repository, else local',
	};
	out(`${root}: mode ${value} — ${explain[value]}`);
}

async function gate(positional, flags) {
	const action = positional[1];
	const root = repoRoot(flags);
	const config = loadConfig(undefined, { strict: true });
	const settings = repoSettings(config, root);
	if (action === 'set') {
		const command = positional.slice(2).join(' ').trim();
		if (!command) return fail('usage: int gate set "<command>" [--timeout <seconds>]');
		const timeout = flags.timeout ? Number(flags.timeout) : null;
		if (timeout !== null && !(timeout > 0)) return fail('--timeout must be a number of seconds');
		if (timeout !== null && timeout > MAX_GATE_TIMEOUT_SEC) {
			return fail(`--timeout can be at most ${MAX_GATE_TIMEOUT_SEC}s: agents stop a hook after 900s, and a gate cut off by the agent would let the completion through unchecked.`);
		}
		saveConfig(updateRepo(config, root, { gate: command, ...(timeout ? { gateTimeoutSec: timeout } : {}) }));
		out(`${root}: claimed Introsio tasks complete only after "${command}" passes (${timeout ?? settings.gateTimeoutSec}s limit). Try it: int gate run`);
	} else if (action === 'off') {
		saveConfig(updateRepo(config, root, { gate: null, gateTimeoutSec: null }));
		out(`${root}: test gate off`);
	} else if (action === 'run') {
		if (!settings.gate) return fail('no gate set — int gate set "<command>"');
		out(`Running "${settings.gate}" in ${root} …`);
		const result = await runGateCommand(settings.gate, root, settings.gateTimeoutSec);
		out(result.output);
		out(result.ok ? `✓ passed in ${Math.round(result.ms / 1000)}s` : result.timedOut ? `✗ timed out after ${settings.gateTimeoutSec}s` : `✗ failed (exit ${result.code})`);
		if (!result.ok) process.exitCode = 1;
	} else {
		out(settings.gate ? `${root}: "${settings.gate}" (${settings.gateTimeoutSec}s)` : `${root}: no test gate — int gate set "<command>"`);
	}
}

function features(positional) {
	const [action, name] = positional;
	const config = loadConfig(undefined, { strict: true });
	if (action === 'enable' || action === 'disable') {
		if (!FEATURES[name]) return fail(`unknown feature "${name}" — one of: ${Object.keys(FEATURES).join(', ')}`);
		config.features[name] = action === 'enable';
		saveConfig(config);
		out(`${name}: ${action === 'enable' ? 'on' : 'off'}`);
		return;
	}
	for (const [feature, description] of Object.entries(FEATURES)) out(`${featureOn(config, feature) ? '✓' : '·'} ${feature.padEnd(17)} ${description}`);
}

function claims(positional) {
	if (positional[1] === 'clear') {
		out(`Cleared ${clearSessions()} session record(s) on this computer. Nothing changed in Introsio — a claim there ends when it is completed or its lease expires.`);
		return;
	}
	const now = Date.now();
	const sessions = loadOtherSessions('', now).filter((session) => Object.keys(session.claims ?? {}).length);
	if (sessions.length === 0) {
		out('No open claims tracked on this computer.');
		return;
	}
	for (const session of sessions) {
		out(`${session.agent} session ${session.sessionId} (workerId ${session.workerId ?? '?'}, ${session.cwd ?? ''})`);
		for (const claim of Object.values(session.claims)) {
			const lease = claim.expiresAt ? (claim.expiresAt > now ? `lease ${Math.round((claim.expiresAt - now) / 60000)} min left` : 'lease expired') : '';
			out(`  - "${claim.title}" taskId ${claim.taskId} ${lease}`);
		}
	}
}

/**
 * `int paused`: the pauses made on this computer, and tasks a session that is no
 * longer running still holds (interrupted without a pause). Reads only local
 * files and git — it works after the agent is gone, with no Introsio sign-in.
 * `--prune` drops the records (and snapshot refs) of pauses older than --days (default 30).
 */
function paused(flags) {
	const now = Date.now();
	const pauses = listLocalPauses().sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
	if (flags.prune) {
		const days = flags.days !== undefined && Number(flags.days) >= 0 ? Number(flags.days) : 30;
		let pruned = 0;
		for (const pause of pauses) {
			if (now - Date.parse(pause.at) < days * 86_400_000) continue;
			if (pause.ref && pause.root) createGit(pause.root).deleteRef(pause.ref);
			removeLocalPause(pause.taskId);
			pruned += 1;
		}
		out(`Removed ${pruned} pause record(s) older than ${days} days (and their snapshot refs). Nothing changed in Introsio.`);
		return;
	}
	const interrupted = loadOtherSessions('', now)
		.filter((session) => Object.keys(session.claims ?? {}).length && !sessionIsLive(session, now));
	if (pauses.length === 0 && interrupted.length === 0) {
		out('Nothing paused or interrupted on this computer.');
		return;
	}
	const ago = (iso) => {
		const minutes = Math.round((now - Date.parse(iso)) / 60_000);
		return minutes < 90 ? `${minutes} min ago` : minutes < 2880 ? `${Math.round(minutes / 60)} h ago` : `${Math.round(minutes / 1440)} days ago`;
	};
	if (pauses.length) {
		out('Paused:');
		for (const pause of pauses) {
			const snapshot = pause.ref && pause.root && createGit(pause.root).resolve(pause.ref) ? 'working tree saved' : (pause.dirtyFiles?.length ? 'no snapshot' : 'clean tree');
			out(`  - "${pause.title}" (taskId ${pause.taskId}) ${ago(pause.at)} by ${pause.agent ?? 'agent'}${pause.release ? ', released' : ''}`);
			if (pause.root) out(`      ${pause.root} · ${pause.branch ?? 'detached HEAD'} @ ${String(pause.head ?? '?').slice(0, 10)} · ${pause.dirtyFiles?.length ?? 0} unfinished file(s), ${snapshot}`);
			if (pause.note) out(`      ${pause.note.replace(/\s+/g, ' ').slice(0, 160)}`);
			out(`      resume: /introsio-resume ${pause.taskId}`);
		}
	}
	if (interrupted.length) {
		if (pauses.length) out('');
		out('Interrupted without a pause (the agent session is gone, its claim is still open):');
		for (const session of interrupted) {
			for (const claim of Object.values(session.claims)) {
				out(`  - "${claim.title}" (taskId ${claim.taskId}) — ${session.agent} session, workerId ${claim.workerId ?? session.workerId ?? '?'}${session.cwd ? `, in ${session.cwd}` : ''}`);
				out(`      resume: /introsio-resume ${claim.taskId}  (it takes the task over with workerId ${claim.workerId ?? session.workerId ?? '?'})`);
			}
		}
	}
}

function parseSince(value) {
	const match = String(value ?? '').match(/^(\d+)([hdw])$/);
	if (!match) return null;
	return Date.now() - Number(match[1]) * { h: 3_600_000, d: 86_400_000, w: 604_800_000 }[match[2]];
}

function stats(flags) {
	const since = flags.since ? parseSince(flags.since) : null;
	if (flags.since && since === null) return fail('--since takes e.g. 12h, 7d, 2w');
	const rows = [`${logPath()}.1`, logPath()]
		.flatMap((file) => (readText(file) ?? '').split('\n'))
		.filter(Boolean)
		.map((line) => { try { return JSON.parse(line); } catch { return null; } })
		.filter(Boolean)
		.filter((row) => (since === null || Date.parse(row.at) >= since) && (!flags.project || row.projectId === flags.project));
	const summary = summarize(rows);
	if (flags.json) {
		out(JSON.stringify(summary, null, 2));
		return;
	}
	if (rows.length === 0) {
		out('No Introsio calls logged yet.');
		return;
	}
	out(`${summary.calls} Introsio calls, ${summary.refused} refused (${Math.round((summary.refused / summary.calls) * 100)}%)`);
	out('');
	out('By tool:');
	for (const tool of summary.tools) out(`  ${tool.tool.padEnd(24)} ${String(tool.calls).padStart(5)} calls  ${String(tool.refused).padStart(4)} refused  ${tool.avgMs === null ? '' : `${tool.avgMs} ms avg`}`);
	if (summary.topErrors.length) {
		out('');
		out('Most common refusals:');
		for (const { error, count } of summary.topErrors) out(`  ${String(count).padStart(4)}× ${error}`);
	}
	if (summary.retryLoops.length) {
		out('');
		out('Retry loops (same call refused 3+ times in a row):');
		for (const loop of summary.retryLoops) out(`  ${loop.tool} on ${loop.taskId}: ${loop.error ?? ''}`);
	}
	out('');
	out('Tasks (most refusals first):');
	for (const task of summary.tasks.slice(0, 15)) out(`  ${task.taskId}  ${task.completed ? 'done' : 'open'}  ${task.calls} calls  ${task.refused} refused  ${task.minutes} min`);
}

/** Every hook command string in a parsed config. */
function hookCommandsIn(value, found = []) {
	if (typeof value === 'string') {
		if (value.includes('introsio-hook.mjs')) found.push(value);
	} else if (value && typeof value === 'object') {
		for (const item of Object.values(value)) hookCommandsIn(item, found);
	}
	return found;
}

function doctor(flags) {
	let problems = 0;
	const check = (ok, label, hint) => {
		out(`${ok ? '✓' : '✗'} ${label}${ok || !hint ? '' : ` — ${hint}`}`);
		if (!ok) problems += 1;
	};
	const major = Number(process.versions.node.split('.')[0]);
	check(major >= 18, `Node ${process.versions.node}`, 'Node 18 or newer is required for the hooks');
	let ctx;
	try {
		ctx = context(flags);
		check(true, `settings ${configPath()}`);
	} catch (error) {
		check(false, `settings ${configPath()}`, `${error.message}`);
		out('\n1 problem — fix the settings file first.');
		process.exitCode = 1;
		return;
	}
	check(fs.existsSync(ctx.hookScript), `hook engine at ${ctx.kitInstallDir}`, 'run int setup');
	const installed = (() => { try { return JSON.parse(readText(path.join(ctx.kitInstallDir, 'package.json'))).introsio; } catch { return null; } })();
	if (installed) check(installed === VERSION, `hook engine version ${installed}`, `this int is ${VERSION} — run int setup to update the installed hooks`);

	const hookFiles = ctx.scope === 'project'
		? []
		: [path.join(ctx.home, '.claude', 'settings.json'), path.join(ctx.home, '.codex', 'hooks.json'), path.join(ctx.home, '.gemini', 'settings.json'), path.join(ctx.home, '.cursor', 'hooks.json')];
	const nodes = new Set();
	for (const file of hookFiles) {
		const text = readText(file);
		if (!text) continue;
		try { for (const command of hookCommandsIn(JSON.parse(text))) nodes.add(nodePathOf(command)); } catch { /* reported by the agent check */ }
	}
	nodes.delete('');
	for (const node of nodes) {
		check(fs.existsSync(node), `hooks run with ${node}`, 'that Node binary is gone (nvm / Homebrew upgrade?) — run int setup again to point the hooks at the current one');
	}

	for (const agent of AGENTS) {
		if (!agent.detect(ctx)) continue;
		const s = agent.status(ctx);
		check(s.connect !== 'no', `${agent.label}: MCP server`, 'run int setup');
		if (agent.hooks.startsWith('blocking')) check(s.hooks.startsWith('blocking'), `${agent.label}: hooks`, 'run int setup');
	}
	if (fs.existsSync(ctx.hookScript)) {
		// Fire the installed hook, with the Node the hooks use, in a scratch state folder: a claim, then a stop — it must refuse the stop.
		const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'introsio-doctor-'));
		const env = { ...process.env, INTROSIO_HOME: scratch, INTROSIO_HOOKS: '' };
		const node = [...nodes].find((candidate) => fs.existsSync(candidate)) ?? process.execPath;
		const fire = (event, payload) => spawnSync(node, [ctx.hookScript, 'claude', event], { input: JSON.stringify(payload), encoding: 'utf8', env, timeout: 20000 });
		const started = Date.now();
		fire('PostToolUse', {
			session_id: 'doctor', cwd: scratch, tool_name: 'mcp__introsio__claimTask', tool_input: { projectId: 'p' },
			tool_response: [{ type: 'text', text: JSON.stringify({ claimed: true, workerId: 'doctor', task: { id: 't1', title: 'Doctor check' } }) }],
		});
		const stop = fire('Stop', { session_id: 'doctor', cwd: scratch, stop_hook_active: false });
		const ms = Date.now() - started;
		let blocked = false;
		try { blocked = JSON.parse(stop.stdout).decision === 'block'; } catch { /* no output */ }
		check(blocked, `hook fires and refuses a stop with an open claim (2 calls in ${ms} ms)`, `unexpected output: ${stop.stdout || stop.stderr}`);
		fs.rmSync(scratch, { recursive: true, force: true });
	}
	const errors = (readText(path.join(introsioDir(), 'errors.log')) ?? '').trim().split('\n').filter(Boolean);
	const recent = errors.filter((line) => Date.now() - Date.parse(line.slice(0, 24)) < 7 * 86_400_000);
	check(recent.length === 0, 'no hook errors in the last 7 days', `${recent.length} — latest: ${recent.at(-1)?.slice(0, 240)} (full log: ${path.join(introsioDir(), 'errors.log')})`);
	out(problems ? `\n${problems} problem(s).` : '\nAll good.');
	if (problems) process.exitCode = 1;
}

function help() {
	out(`int ${VERSION} — the Introsio agent kit: connect coding agents to Introsio and keep it updated while they execute

  int setup [--agents claude,codex,gemini,cursor,opencode,vscode,windsurf] [--project <repo>] [--toolset developer|execute|all] [--url <mcp url>] [--dry-run]
  int uninstall [--agents …] [--project <repo>]
  int status                       what is installed, per agent and for this repo
  int doctor                       check the install and fire a test hook

  int mode github|local|off|auto   this repo: push + branch required / commit only, no push / no checks
  int gate set "<cmd>" [--timeout <sec>] | gate off | gate run | gate
  int features | enable <name> | disable <name>
  int claims | claims clear        tasks your agents hold on this computer
  int stats [--since 7d] [--project <id>] [--json]
  int paused [--prune [--days 30]] work paused or interrupted on this computer, and how to resume it
  int print-execute | print-pause | print-resume
                                   a command's procedure, to paste where an agent has no commands

  Inside an agent: /introsio-execute <project> · /introsio-pause [--release] · /introsio-resume [task]
  One session without hooks: INTROSIO_HOOKS=off`);
}

async function main() {
	const { positional, flags } = parseArgs(process.argv.slice(2));
	const command = positional[0] ?? 'help';
	try {
		return await run(command, positional, flags);
	} catch (error) {
		return fail(error.message);
	}
}

async function run(command, positional, flags) {
	{
		switch (command) {
			case 'setup': case 'install': return setup(flags);
			case 'uninstall': case 'remove': return uninstall(flags);
			case 'status': return status(flags);
			case 'doctor': return doctor(flags);
			case 'mode': return mode(positional, flags);
			case 'gate': return gate(positional, flags);
			case 'features': return features([]);
			case 'enable': case 'disable': return features(positional);
			case 'claims': return claims(positional);
			case 'stats': return stats(flags);
			case 'paused': return paused(flags);
			case 'print-execute': case 'print-pause': case 'print-resume': {
				const chosen = COMMANDS.find((item) => item.name === `introsio-${command.slice('print-'.length)}`);
				return out(commandText(context(flags), chosen, chosen.name === 'introsio-execute' ? 'the project the user names' : 'what the user names'));
			}
			case 'hook': {
				// `int hook <agent> <event>` — the same entry as introsio-hook.mjs, for package-manager installs.
				process.argv = [process.argv[0], path.join(KIT_SOURCE, 'hook', 'introsio-hook.mjs'), ...positional.slice(1)];
				await import('./hook/introsio-hook.mjs');
				return undefined;
			}
			case 'version': case '--version': return out(VERSION);
			default: return help();
		}
	}
}

main();
