// OpenCode: MCP in opencode.json, /introsio-execute in commands/, and a plugin (OpenCode has no shell hooks).
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { join, editJson, markdownCommand, existsDir, existsFile, hasCli, SERVER_NAME, COMMAND_NAME } from './common.mjs';
import { readJsonSafe, readText } from '../lib/jsonFile.mjs';
import { xdgConfigHome } from '../lib/paths.mjs';

const paths = (ctx) => {
	const base = ctx.scope === 'project' ? join(ctx.root, '.opencode') : join(xdgConfigHome(ctx.env), 'opencode');
	return {
		config: ctx.scope === 'project' ? join(ctx.root, 'opencode.json') : join(base, 'opencode.json'),
		command: join(base, 'commands', `${COMMAND_NAME}.md`),
		plugin: join(base, 'plugins', 'introsio.js'),
	};
};

function pluginSource(ctx, pluginFile) {
	const template = readText(join(ctx.kitSource, 'opencode', 'introsio.template.js'));
	const target = (file) => {
		const absolute = join(ctx.kitInstallDir, 'hook', file);
		if (ctx.scope !== 'project') return pathToFileURL(absolute).href;
		const relative = path.relative(path.dirname(pluginFile), absolute).split(path.sep).join('/');
		return relative.startsWith('.') ? relative : `./${relative}`;
	};
	return template.replace('__ENGINE__', target('engine.mjs')).replace('__NORMALIZE__', target('normalize.mjs'));
}

export default {
	id: 'opencode',
	label: 'OpenCode',
	hooks: 'blocking (plugin)',
	detect: (ctx) => existsDir(join(xdgConfigHome(ctx.env), 'opencode')) || hasCli('opencode', ctx.env),
	install(ctx, writer) {
		const p = paths(ctx);
		const report = { connect: null, command: p.command, hooks: 'blocking (plugin)', next: [] };
		const config = editJson(writer, p.config, (value) => {
			value.$schema = value.$schema ?? 'https://opencode.ai/config.json';
			value.mcp = value.mcp ?? {};
			const next = { type: 'remote', url: ctx.url, enabled: true };
			if (JSON.stringify(value.mcp[SERVER_NAME]) === JSON.stringify(next)) return false;
			value.mcp[SERVER_NAME] = next;
			return true;
		});
		report.connect = config.error ?? (config.manual ? `manual — add "mcp": { "${SERVER_NAME}": { "type": "remote", "url": "${ctx.url}" } } to ${p.config}` : config.changed ? 'added' : 'already connected');
		report.next.push(`Sign in: opencode mcp auth ${SERVER_NAME}. Then in OpenCode: /${COMMAND_NAME} <project>`);
		writer.writeText(p.command, markdownCommand(ctx));
		writer.writeText(p.plugin, pluginSource(ctx, p.plugin));
		return report;
	},
	uninstall(ctx, writer) {
		const p = paths(ctx);
		editJson(writer, p.config, (value) => (value.mcp?.[SERVER_NAME] ? (delete value.mcp[SERVER_NAME], true) : false));
		writer.remove(p.command);
		writer.remove(p.plugin);
	},
	status(ctx) {
		const p = paths(ctx);
		return {
			connect: readJsonSafe(p.config, {}).mcp?.[SERVER_NAME] ? 'yes' : 'no',
			command: existsFile(p.command),
			hooks: existsFile(p.plugin) === 'yes' ? 'blocking (plugin)' : 'not installed',
		};
	},
};
