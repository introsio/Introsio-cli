// Codex: MCP server in config.toml (a managed block), /prompts:introsio-execute, hooks in hooks.json.
import { join, editJson, setMatcherHooks, removeMatcherHooks, hasOurHooks, hookCommand, markdownCommand, existsDir, existsFile, hasCli, SERVER_NAME, COMMAND_NAME } from './common.mjs';
import { readJsonSafe, readText } from '../lib/jsonFile.mjs';
import { withBlock, withoutBlock, hasBlock } from '../lib/managedBlock.mjs';

const base = (ctx) => (ctx.scope === 'project' ? join(ctx.root, '.codex') : join(ctx.home, '.codex'));
const paths = (ctx) => ({
	config: join(base(ctx), 'config.toml'),
	hooks: join(base(ctx), 'hooks.json'),
	command: join(base(ctx), 'prompts', `${COMMAND_NAME}.md`),
});

function hookGroups(ctx) {
	const cmd = (event, timeout) => ({ type: 'command', command: hookCommand(ctx, 'codex', event), timeout });
	return {
		SessionStart: [{ hooks: [cmd('SessionStart', 10)] }],
		PreToolUse: [{ matcher: 'mcp__.*|Bash|shell|exec_command', hooks: [cmd('PreToolUse', 900)] }],
		PostToolUse: [{ matcher: '.*', hooks: [cmd('PostToolUse', 15)] }],
		PreCompact: [{ hooks: [cmd('PreCompact', 10)] }],
		PostCompact: [{ hooks: [cmd('PostCompact', 10)] }],
		Stop: [{ hooks: [cmd('Stop', 15)] }],
	};
}

/** True when the user already configured [mcp_servers.introsio] themselves (outside our block). */
const userDefinedServer = (text) => /^\s*\[mcp_servers\.introsio\]/m.test(withoutBlock(text ?? ''));

export default {
	id: 'codex',
	label: 'Codex',
	hooks: 'blocking',
	detect: (ctx) => existsDir(join(ctx.home, '.codex')) || hasCli('codex', ctx.env),
	install(ctx, writer) {
		const p = paths(ctx);
		const report = { connect: null, command: p.command, hooks: 'blocking', next: [] };
		const text = readText(p.config) ?? '';
		if (userDefinedServer(text)) report.connect = 'already configured in config.toml';
		else {
			const body = `[mcp_servers.${SERVER_NAME}]\nurl = ${JSON.stringify(ctx.url)}`;
			report.connect = writer.writeText(p.config, withBlock(text, body)) ? 'added' : 'already connected';
		}
		report.next.push(`Sign in: codex mcp login ${SERVER_NAME}. Then in Codex: /prompts:${COMMAND_NAME} <project>`);
		report.next.push('If your Codex version keeps hooks behind a flag, add to config.toml:  [features]  codex_hooks = true');
		writer.writeText(p.command, markdownCommand(ctx, { frontmatter: { 'argument-hint': '<project name or id>' } }));
		const hooks = editJson(writer, p.hooks, (config) => setMatcherHooks(config, hookGroups(ctx)));
		if (hooks.manual || hooks.error) report.hooks = hooks.error ?? `manual — ${p.hooks} has comments`;
		return report;
	},
	uninstall(ctx, writer) {
		const p = paths(ctx);
		const text = readText(p.config);
		if (text && hasBlock(text)) writer.writeText(p.config, withoutBlock(text));
		editJson(writer, p.hooks, (config) => removeMatcherHooks(config));
		writer.remove(p.command);
	},
	status(ctx) {
		const p = paths(ctx);
		const text = readText(p.config) ?? '';
		return {
			connect: hasBlock(text) || userDefinedServer(text) ? 'yes' : 'no',
			command: existsFile(p.command),
			hooks: hasOurHooks(readJsonSafe(p.hooks, {})) ? 'blocking' : 'not installed',
		};
	},
	print: (ctx) => ({ hooks: hookGroups(ctx) }),
};
