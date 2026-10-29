// Windsurf: MCP in mcp_config.json. No global commands or hooks — setup prints the procedure to paste as a rule.
import { join, editJson, existsDir, SERVER_NAME } from './common.mjs';
import { readJsonSafe } from '../lib/jsonFile.mjs';

const configFile = (ctx) => join(ctx.home, '.codeium', 'windsurf', 'mcp_config.json');

export default {
	id: 'windsurf',
	label: 'Windsurf',
	hooks: 'none — the server still resumes abandoned claims',
	userOnly: true,
	detect: (ctx) => existsDir(join(ctx.home, '.codeium', 'windsurf')),
	install(ctx, writer) {
		const file = configFile(ctx);
		const report = { connect: null, command: null, hooks: 'none', next: [] };
		const mcp = editJson(writer, file, (config) => {
			config.mcpServers = config.mcpServers ?? {};
			if (config.mcpServers[SERVER_NAME]?.serverUrl === ctx.url) return false;
			config.mcpServers[SERVER_NAME] = { serverUrl: ctx.url };
			return true;
		});
		report.connect = mcp.error ?? (mcp.manual ? `manual — add "${SERVER_NAME}": { "serverUrl": "${ctx.url}" } to ${file}` : mcp.changed ? 'added' : 'already connected');
		report.next.push('In Windsurf: Cascade → MCP servers → refresh, sign in to introsio. For the execute procedure run `introsio print-execute` and save it as a Windsurf rule or workflow.');
		return report;
	},
	uninstall(ctx, writer) {
		editJson(writer, configFile(ctx), (config) => (config.mcpServers?.[SERVER_NAME] ? (delete config.mcpServers[SERVER_NAME], true) : false));
	},
	status(ctx) {
		return { connect: readJsonSafe(configFile(ctx), {}).mcpServers?.[SERVER_NAME] ? 'yes' : 'no', command: 'n/a', hooks: 'none' };
	},
};
