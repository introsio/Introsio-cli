// VS Code (GitHub Copilot agent mode): MCP in the user mcp.json and a /introsio-execute prompt file. No hooks.
import { join, editJson, commandText, writeCommands, removeCommands, commandsStatus, existsDir, SERVER_NAME, COMMAND_NAME } from './common.mjs';
import { readJsonSafe } from '../lib/jsonFile.mjs';

function userDir(ctx) {
	const platform = ctx.platform ?? process.platform;
	if (platform === 'darwin') return join(ctx.home, 'Library', 'Application Support', 'Code', 'User');
	if (platform === 'win32') return join(ctx.env.APPDATA && !ctx.env.INTROSIO_TEST_HOME ? ctx.env.APPDATA : join(ctx.home, 'AppData', 'Roaming'), 'Code', 'User');
	return join(ctx.home, '.config', 'Code', 'User');
}

const paths = (ctx) => {
	const prompts = ctx.scope === 'project' ? join(ctx.root, '.github', 'prompts') : join(userDir(ctx), 'prompts');
	const commandFile = (name) => join(prompts, `${name}.prompt.md`);
	return { mcp: ctx.scope === 'project' ? join(ctx.root, '.vscode', 'mcp.json') : join(userDir(ctx), 'mcp.json'), command: commandFile(COMMAND_NAME), commandFile };
};

export default {
	id: 'vscode',
	label: 'VS Code (Copilot)',
	hooks: 'none — the server still resumes abandoned claims',
	detect: (ctx) => existsDir(userDir(ctx)),
	install(ctx, writer) {
		const p = paths(ctx);
		const report = { connect: null, command: p.command, hooks: 'none', next: [] };
		const mcp = editJson(writer, p.mcp, (config) => {
			config.servers = config.servers ?? {};
			const next = { type: 'http', url: ctx.url };
			if (JSON.stringify(config.servers[SERVER_NAME]) === JSON.stringify(next)) return false;
			config.servers[SERVER_NAME] = next;
			return true;
		});
		report.connect = mcp.error ?? (mcp.manual ? `manual — add "${SERVER_NAME}": { "type": "http", "url": "${ctx.url}" } under "servers" in ${p.mcp}` : mcp.changed ? 'added' : 'already connected');
		report.next.push('In VS Code: open mcp.json and click Start above "introsio" to sign in. Then in Copilot Chat (Agent mode): /introsio-execute <project>');
		writeCommands(writer, p.commandFile, (command) => `---\nmode: agent\ndescription: ${command.description}\n---\n\n${commandText(ctx, command, `\${input:args:${command.inputLabel}}`)}\n`);
		return report;
	},
	uninstall(ctx, writer) {
		const p = paths(ctx);
		editJson(writer, p.mcp, (config) => (config.servers?.[SERVER_NAME] ? (delete config.servers[SERVER_NAME], true) : false));
		removeCommands(writer, p.commandFile);
	},
	status(ctx) {
		const p = paths(ctx);
		return { connect: readJsonSafe(p.mcp, {}).servers?.[SERVER_NAME] ? 'yes' : 'no', command: commandsStatus(p.commandFile), hooks: 'none' };
	},
};
