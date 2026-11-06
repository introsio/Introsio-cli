// Shared installer plumbing: a writer that can dry-run, careful JSON merging, and our hook entries.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readText, stripJsonComments, writeAtomic } from '../lib/jsonFile.mjs';

export const SERVER_NAME = 'introsio';
export const COMMAND_NAME = 'introsio-execute';
export const HOOK_MARK = 'introsio-hook.mjs';
export const DESCRIPTION = 'Execute an Introsio Developer Mode project task by task (claim → work → complete)';

/**
 * The commands every agent gets. `template` is a file in templates/; `$ARGUMENTS`
 * in it is rendered the way each agent passes what the user typed after the command.
 */
export const COMMANDS = Object.freeze([
	{ name: COMMAND_NAME, template: 'execute.md', description: DESCRIPTION, argumentHint: '<project name or id>', inputLabel: 'Project name or id' },
	{
		name: 'introsio-pause',
		template: 'pause.md',
		description: 'Pause the Introsio task(s) you hold so they resume exactly later — note, next steps, git snapshot (out of usage, context or time)',
		argumentHint: '[--release] [anything the next session should know]',
		inputLabel: 'Optional: --release, and a note',
	},
	{
		name: 'introsio-resume',
		template: 'resume.md',
		description: 'Resume paused or interrupted Introsio work exactly where it stopped — after checking the repository still matches',
		argumentHint: '[task id, or project name or id]',
		inputLabel: 'Optional: task id or project',
	},
]);

export class Writer {
	constructor({ dryRun = false } = {}) {
		this.dryRun = dryRun;
		this.actions = [];
	}

	writeText(file, text) {
		if (readText(file) === text) return false;
		this.actions.push(`write ${file}`);
		if (!this.dryRun) writeAtomic(file, text);
		return true;
	}

	writeJson(file, value) {
		return this.writeText(file, `${JSON.stringify(value, null, 2)}\n`);
	}

	remove(file) {
		if (!fs.existsSync(file)) return false;
		this.actions.push(`remove ${file}`);
		if (!this.dryRun) fs.rmSync(file, { recursive: true, force: true });
		return true;
	}

	run(command, args) {
		this.actions.push(`run ${command} ${args.join(' ')}`);
		if (this.dryRun) return { ok: true, out: '' };
		const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30000, shell: process.platform === 'win32' });
		return { ok: result.status === 0, out: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
	}
}

/** True when `command` is on PATH (never in tests — they must not touch the real tools). */
export function hasCli(command, env = process.env) {
	if (env.INTROSIO_TEST_HOME) return false;
	const result = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 10000, shell: process.platform === 'win32' });
	return result.status === 0;
}

/**
 * Merges into a JSON config. A file with comments is never rewritten (that
 * would drop them): the caller gets `{ manual: true }` and prints a snippet.
 */
export function editJson(writer, file, mutate) {
	const raw = readText(file);
	let value = {};
	if (raw !== null && raw.trim()) {
		try {
			value = JSON.parse(raw);
		} catch {
			try {
				JSON.parse(stripJsonComments(raw));
				return { manual: true };
			} catch {
				return { error: `${file} is not valid JSON — left untouched` };
			}
		}
	}
	const changed = mutate(value);
	if (changed === false) return { changed: false };
	return { changed: writer.writeJson(file, value) };
}

const isOurs = (entry) => JSON.stringify(entry ?? {}).includes(HOOK_MARK);

/** Claude / Codex / Gemini hook shape: { Event: [ { matcher, hooks: [ { type, command, timeout } ] } ] }. */
export function setMatcherHooks(root, groups) {
	removeMatcherHooks(root);
	root.hooks = root.hooks && typeof root.hooks === 'object' ? root.hooks : {};
	for (const [event, entries] of Object.entries(groups)) {
		root.hooks[event] = [...(root.hooks[event] ?? []), ...entries];
	}
	return true;
}

export function removeMatcherHooks(root) {
	if (!root.hooks || typeof root.hooks !== 'object') return false;
	let changed = false;
	for (const [event, list] of Object.entries(root.hooks)) {
		if (!Array.isArray(list)) continue;
		const kept = list
			.map((group) => (group && Array.isArray(group.hooks) ? { ...group, hooks: group.hooks.filter((hook) => !isOurs(hook)) } : group))
			.filter((group) => !(group && Array.isArray(group.hooks) && group.hooks.length === 0) && !(group && !Array.isArray(group.hooks) && isOurs(group)));
		if (kept.length !== list.length || JSON.stringify(kept) !== JSON.stringify(list)) changed = true;
		if (kept.length) root.hooks[event] = kept;
		else delete root.hooks[event];
	}
	if (Object.keys(root.hooks).length === 0) delete root.hooks;
	return changed;
}

export const hasOurHooks = (root) => isOurs(root?.hooks);

/** Forward slashes work for Node and for every shell an agent may use on Windows. */
const portable = (file) => String(file).replace(/\\/g, '/');
const quote = (file) => `"${portable(file)}"`;

/**
 * The command line an agent runs for one event. Globally it names the absolute
 * Node binary that ran setup: GUI apps (Cursor, VS Code) often start without the
 * shell's PATH, so a bare `node` (nvm, fnm, Homebrew) is not found there.
 * In a project it stays `node` + a repo-relative path, since teammates differ.
 */
export function hookCommand(ctx, agent, event) {
	const tail = `${agent}${event ? ` ${event}` : ''}`;
	if (ctx.scope === 'project') {
		const script = agent === 'claude' ? '"$CLAUDE_PROJECT_DIR"/.introsio/kit/hook/introsio-hook.mjs' : '.introsio/kit/hook/introsio-hook.mjs';
		return `node ${script} ${tail}`;
	}
	return `${quote(ctx.nodePath ?? process.execPath)} ${quote(ctx.hookScript)} ${tail}`;
}

/** The Node binary a global hook command uses ("" when the command is not ours). */
export function nodePathOf(command) {
	const match = String(command ?? '').match(/^"([^"]+)"\s+"[^"]*introsio-hook\.mjs"/);
	return match ? match[1] : '';
}

/** A command's procedure, with `$ARGUMENTS` rendered the way an agent's commands expect. */
export function commandText(ctx, command = COMMANDS[0], argumentToken = '$ARGUMENTS') {
	const template = ctx.templates?.[command.name] ?? (command.name === COMMAND_NAME ? ctx.executeTemplate : '');
	return String(template ?? '').replaceAll('$ARGUMENTS', argumentToken).trim();
}

/** The execute procedure (kept for callers that only know that one). */
export function executeText(ctx, argumentToken = '$ARGUMENTS') {
	return commandText(ctx, COMMANDS[0], argumentToken);
}

/** A Markdown command file: frontmatter, then the procedure. `argumentHint: true` adds each command's own hint. */
export function markdownCommand(ctx, { command = COMMANDS[0], frontmatter = {}, argumentToken, argumentHint = false } = {}) {
	const fields = { description: command.description, ...(argumentHint ? { 'argument-hint': command.argumentHint } : {}), ...frontmatter };
	const lines = Object.entries(fields).map(([key, value]) => `${key}: ${value}`);
	return `---\n${lines.join('\n')}\n---\n\n${commandText(ctx, command, argumentToken)}\n`;
}

/** Writes one file per command (`fileFor(name)` → path); returns the paths. */
export function writeCommands(writer, fileFor, render) {
	return COMMANDS.map((command) => {
		const file = fileFor(command.name);
		writer.writeText(file, render(command));
		return file;
	});
}

export function removeCommands(writer, fileFor) {
	for (const command of COMMANDS) writer.remove(fileFor(command.name));
}

/** "yes" when every command file is there, "partial — re-run int setup" when some are, "no" otherwise. */
export function commandsStatus(fileFor) {
	const present = COMMANDS.filter((command) => fs.existsSync(fileFor(command.name))).length;
	if (present === COMMANDS.length) return 'yes';
	return present === 0 ? 'no' : 'partial — re-run int setup';
}

export function existsDir(dir) {
	try {
		return fs.statSync(dir).isDirectory();
	} catch {
		return false;
	}
}

export const join = path.join;

export const existsFile = (file) => (fs.existsSync(file) ? 'yes' : 'no');
