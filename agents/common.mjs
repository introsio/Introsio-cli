// Shared installer plumbing: a writer that can dry-run, careful JSON merging, and our hook entries.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readText, stripJsonComments, writeAtomic } from '../lib/jsonFile.mjs';

export const SERVER_NAME = 'introsio';
export const COMMAND_NAME = 'introsio-execute';
export const HOOK_MARK = 'introsio-hook.mjs';
export const DESCRIPTION = 'Execute an Introsio Developer Mode project task by task (claim → work → complete)';

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

/** The execute procedure, with `$ARGUMENTS` rendered the way an agent's commands expect. */
export function executeText(ctx, argumentToken = '$ARGUMENTS') {
	return ctx.executeTemplate.replaceAll('$ARGUMENTS', argumentToken).trim();
}

export function markdownCommand(ctx, { frontmatter = {}, argumentToken } = {}) {
	const lines = Object.entries({ description: DESCRIPTION, ...frontmatter }).map(([key, value]) => `${key}: ${value}`);
	return `---\n${lines.join('\n')}\n---\n\n${executeText(ctx, argumentToken)}\n`;
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
