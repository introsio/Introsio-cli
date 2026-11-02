// Claude Code: MCP via `claude mcp add` (or ~/.claude.json / .mcp.json), /introsio-execute as a command, hooks in settings.json.
import { join, editJson, setMatcherHooks, removeMatcherHooks, hasOurHooks, hookCommand, markdownCommand, writeCommands, removeCommands, commandsStatus, existsDir, hasCli, SERVER_NAME, COMMAND_NAME } from './common.mjs';
import { readJsonSafe } from '../lib/jsonFile.mjs';

const paths = (ctx) => {
	const base = ctx.scope === 'project' ? ctx.root : ctx.home;
	const commandFile = (name) => join(base, '.claude', 'commands', `${name}.md`);
	return {
		settings: join(base, '.claude', 'settings.json'),
		mcp: ctx.scope === 'project' ? join(ctx.root, '.mcp.json') : join(ctx.home, '.claude.json'),
		command: commandFile(COMMAND_NAME),
		commandFile,
	};
};

function hookGroups(ctx) {
	const cmd = (event, timeout) => ({ type: 'command', command: hookCommand(ctx, 'claude', event), timeout });
	return {
		SessionStart: [{ matcher: 'compact', hooks: [cmd('SessionStart', 10)] }],
		PreToolUse: [
			// Completion runs the test gate, so it may take minutes.
			{ matcher: 'mcp__.*', hooks: [cmd('PreToolUse', 900)] },
			{ matcher: 'Bash', hooks: [cmd('PreToolUse', 60)] },
		],
		PostToolUse: [{ matcher: '.*', hooks: [cmd('PostToolUse', 15)] }],
		PreCompact: [{ hooks: [cmd('PreCompact', 10)] }],
		Stop: [{ hooks: [cmd('Stop', 15)] }],
	};
}

export default {
	id: 'claude',
	label: 'Claude Code',
	hooks: 'blocking',
	detect: (ctx) => existsDir(join(ctx.home, '.claude')) || hasCli('claude', ctx.env),
	install(ctx, writer) {
		const p = paths(ctx);
		const report = { connect: null, command: p.command, hooks: 'blocking', next: [] };
		if (ctx.scope === 'user' && hasCli('claude', ctx.env)) {
			const listed = writer.run('claude', ['mcp', 'get', SERVER_NAME]);
			if (listed.ok && !writer.dryRun && listed.out.includes(ctx.url)) report.connect = 'already connected';
			else {
				if (listed.ok && !writer.dryRun) writer.run('claude', ['mcp', 'remove', '--scope', 'user', SERVER_NAME]);
				const added = writer.run('claude', ['mcp', 'add', '--scope', 'user', '--transport', 'http', SERVER_NAME, ctx.url]);
				report.connect = added.ok ? 'added' : `could not add (${added.out.slice(0, 120)}) — run: claude mcp add --scope user --transport http ${SERVER_NAME} ${ctx.url}`;
			}
		} else {
			const result = editJson(writer, p.mcp, (config) => {
				config.mcpServers = config.mcpServers ?? {};
				const next = { type: 'http', url: ctx.url };
				if (JSON.stringify(config.mcpServers[SERVER_NAME]) === JSON.stringify(next)) return false;
				config.mcpServers[SERVER_NAME] = next;
				return true;
			});
			report.connect = result.error ?? (result.manual ? `manual — add "${SERVER_NAME}": { "type": "http", "url": "${ctx.url}" } to mcpServers in ${p.mcp}` : result.changed ? 'added' : 'already connected');
		}
		report.next.push('In Claude Code run /mcp, pick "introsio" and sign in. Then: /introsio-execute <project> — /introsio-pause before you stop, /introsio-resume to continue');
		writeCommands(writer, p.commandFile, (command) => markdownCommand(ctx, { command, argumentHint: true }));
		const hooks = editJson(writer, p.settings, (settings) => setMatcherHooks(settings, hookGroups(ctx)));
		if (hooks.manual || hooks.error) report.hooks = hooks.error ?? `manual — ${p.settings} has comments; add the hooks shown by \`int setup --print claude\``;
		return report;
	},
	uninstall(ctx, writer) {
		const p = paths(ctx);
		if (ctx.scope === 'user' && hasCli('claude', ctx.env)) writer.run('claude', ['mcp', 'remove', '--scope', 'user', SERVER_NAME]);
		else editJson(writer, p.mcp, (config) => (config.mcpServers?.[SERVER_NAME] ? (delete config.mcpServers[SERVER_NAME], true) : false));
		editJson(writer, p.settings, (settings) => removeMatcherHooks(settings));
		removeCommands(writer, p.commandFile);
	},
	status(ctx) {
		const p = paths(ctx);
		const mcp = readJsonSafe(p.mcp, {});
		return {
			connect: mcp.mcpServers?.[SERVER_NAME] ? 'yes' : (ctx.scope === 'user' ? 'see `claude mcp list`' : 'no'),
			command: commandsStatus(p.commandFile),
			hooks: hasOurHooks(readJsonSafe(p.settings, {})) ? 'blocking' : 'not installed',
		};
	},
	print: (ctx) => ({ hooks: hookGroups(ctx) }),
};
