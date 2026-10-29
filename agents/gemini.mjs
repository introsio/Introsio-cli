// Gemini CLI: MCP + hooks in settings.json, /introsio-execute as a TOML command.
import { join, editJson, setMatcherHooks, removeMatcherHooks, hasOurHooks, hookCommand, executeText, existsDir, existsFile, hasCli, SERVER_NAME, COMMAND_NAME, DESCRIPTION } from './common.mjs';
import { readJsonSafe } from '../lib/jsonFile.mjs';

const base = (ctx) => (ctx.scope === 'project' ? join(ctx.root, '.gemini') : join(ctx.home, '.gemini'));
const paths = (ctx) => ({ settings: join(base(ctx), 'settings.json'), command: join(base(ctx), 'commands', `${COMMAND_NAME}.toml`) });

function hookGroups(ctx) {
	// Gemini timeouts are milliseconds.
	const cmd = (event, timeout) => ({ name: 'introsio', type: 'command', command: hookCommand(ctx, 'gemini', event), timeout });
	return {
		SessionStart: [{ matcher: '*', hooks: [cmd('SessionStart', 10_000)] }],
		BeforeTool: [{ matcher: '.*', hooks: [cmd('BeforeTool', 900_000)] }],
		AfterTool: [{ matcher: '.*', hooks: [cmd('AfterTool', 15_000)] }],
		PreCompress: [{ matcher: '*', hooks: [cmd('PreCompress', 10_000)] }],
		AfterAgent: [{ matcher: '*', hooks: [cmd('AfterAgent', 15_000)] }],
	};
}

const tomlString = (text) => `"""\n${text.replaceAll('\\', '\\\\').replaceAll('"""', '\\"\\"\\"')}\n"""`;

export default {
	id: 'gemini',
	label: 'Gemini CLI',
	hooks: 'blocking',
	detect: (ctx) => existsDir(join(ctx.home, '.gemini')) || hasCli('gemini', ctx.env),
	install(ctx, writer) {
		const p = paths(ctx);
		const report = { connect: null, command: p.command, hooks: 'blocking', next: [] };
		const result = editJson(writer, p.settings, (settings) => {
			settings.mcpServers = settings.mcpServers ?? {};
			const before = JSON.stringify(settings);
			if (!settings.mcpServers[SERVER_NAME]) settings.mcpServers[SERVER_NAME] = { httpUrl: ctx.url };
			else settings.mcpServers[SERVER_NAME].httpUrl = ctx.url;
			setMatcherHooks(settings, hookGroups(ctx));
			return JSON.stringify(settings) !== before;
		});
		report.connect = result.error ?? (result.manual ? `manual — ${p.settings} has comments; add mcpServers.${SERVER_NAME} = { "httpUrl": "${ctx.url}" }` : 'added');
		if (result.manual || result.error) report.hooks = 'manual';
		report.next.push(`In Gemini CLI run /mcp auth ${SERVER_NAME} to sign in. Then: /${COMMAND_NAME} <project>`);
		writer.writeText(p.command, `description = ${JSON.stringify(DESCRIPTION)}\nprompt = ${tomlString(executeText(ctx, '{{args}}'))}\n`);
		return report;
	},
	uninstall(ctx, writer) {
		const p = paths(ctx);
		editJson(writer, p.settings, (settings) => {
			const had = !!settings.mcpServers?.[SERVER_NAME];
			if (had) delete settings.mcpServers[SERVER_NAME];
			return removeMatcherHooks(settings) || had;
		});
		writer.remove(p.command);
	},
	status(ctx) {
		const p = paths(ctx);
		const settings = readJsonSafe(p.settings, {});
		return { connect: settings.mcpServers?.[SERVER_NAME] ? 'yes' : 'no', command: existsFile(p.command), hooks: hasOurHooks(settings) ? 'blocking' : 'not installed' };
	},
	print: (ctx) => ({ hooks: hookGroups(ctx) }),
};
