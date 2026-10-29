// Cursor: MCP in mcp.json, /introsio-execute in commands/, hooks in hooks.json (version 1 format).
import { join, editJson, hookCommand, markdownCommand, existsDir, existsFile, SERVER_NAME, COMMAND_NAME, HOOK_MARK } from './common.mjs';
import { readJsonSafe } from '../lib/jsonFile.mjs';

const base = (ctx) => (ctx.scope === 'project' ? join(ctx.root, '.cursor') : join(ctx.home, '.cursor'));
const paths = (ctx) => ({ mcp: join(base(ctx), 'mcp.json'), hooks: join(base(ctx), 'hooks.json'), command: join(base(ctx), 'commands', `${COMMAND_NAME}.md`) });

const EVENTS = ['beforeMCPExecution', 'afterMCPExecution', 'beforeShellExecution', 'afterFileEdit', 'stop'];

function removeOurs(config) {
	if (!config.hooks) return false;
	let changed = false;
	for (const [event, list] of Object.entries(config.hooks)) {
		if (!Array.isArray(list)) continue;
		const kept = list.filter((hook) => !String(hook?.command ?? '').includes(HOOK_MARK));
		if (kept.length !== list.length) changed = true;
		if (kept.length) config.hooks[event] = kept;
		else delete config.hooks[event];
	}
	return changed;
}

export default {
	id: 'cursor',
	label: 'Cursor',
	hooks: 'blocking (stop hook reliability varies by Cursor version)',
	detect: (ctx) => existsDir(join(ctx.home, '.cursor')),
	install(ctx, writer) {
		const p = paths(ctx);
		const report = { connect: null, command: p.command, hooks: 'blocking', next: [] };
		const mcp = editJson(writer, p.mcp, (config) => {
			config.mcpServers = config.mcpServers ?? {};
			if (config.mcpServers[SERVER_NAME]?.url === ctx.url) return false;
			config.mcpServers[SERVER_NAME] = { url: ctx.url };
			return true;
		});
		report.connect = mcp.error ?? (mcp.manual ? `manual — add "${SERVER_NAME}": { "url": "${ctx.url}" } to ${p.mcp}` : mcp.changed ? 'added' : 'already connected');
		report.next.push('In Cursor: Settings → MCP → introsio → Connect (sign in). Then in Agent chat: /introsio-execute <project>');
		writer.writeText(p.command, markdownCommand(ctx, { argumentToken: 'the project named after the command' }));
		const hooks = editJson(writer, p.hooks, (config) => {
			config.version = config.version ?? 1;
			config.hooks = config.hooks ?? {};
			removeOurs(config);
			for (const event of EVENTS) config.hooks[event] = [...(config.hooks[event] ?? []), { command: hookCommand(ctx, 'cursor', event) }];
			return true;
		});
		if (hooks.manual || hooks.error) report.hooks = hooks.error ?? 'manual';
		return report;
	},
	uninstall(ctx, writer) {
		const p = paths(ctx);
		editJson(writer, p.mcp, (config) => (config.mcpServers?.[SERVER_NAME] ? (delete config.mcpServers[SERVER_NAME], true) : false));
		editJson(writer, p.hooks, (config) => removeOurs(config));
		writer.remove(p.command);
	},
	status(ctx) {
		const p = paths(ctx);
		const hooks = JSON.stringify(readJsonSafe(p.hooks, {}));
		return { connect: readJsonSafe(p.mcp, {}).mcpServers?.[SERVER_NAME] ? 'yes' : 'no', command: existsFile(p.command), hooks: hooks.includes(HOOK_MARK) ? 'blocking' : 'not installed' };
	},
	print: (ctx) => ({ version: 1, hooks: Object.fromEntries(EVENTS.map((event) => [event, [{ command: hookCommand(ctx, 'cursor', event) }]])) }),
};
