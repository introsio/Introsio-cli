// Every path the kit reads or writes, resolved from one HOME so tests can point it at a scratch folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function homeDir(env = process.env) {
	return env.INTROSIO_TEST_HOME || os.homedir();
}

/** ~/.introsio — the kit's own folder (installed hook code, settings, session state, log). */
export function introsioDir(env = process.env) {
	return env.INTROSIO_HOME || path.join(homeDir(env), '.introsio');
}

export const kitDir = (env) => path.join(introsioDir(env), 'kit');
export const configPath = (env) => path.join(introsioDir(env), 'config.json');
export const sessionsDir = (env) => path.join(introsioDir(env), 'sessions');
export const gateCachePath = (env) => path.join(introsioDir(env), 'gate-cache.json');
export const logPath = (env) => path.join(introsioDir(env), 'log.jsonl');
export const installedHookScript = (env) => path.join(kitDir(env), 'hook', 'introsio-hook.mjs');

/** XDG-style config root (OpenCode, VS Code on Linux). */
export function xdgConfigHome(env = process.env) {
	return env.XDG_CONFIG_HOME && !env.INTROSIO_TEST_HOME ? env.XDG_CONFIG_HOME : path.join(homeDir(env), '.config');
}

/**
 * One spelling for one location. Windows reports the same folder as
 * `C:/Users/Jane_dev/x` (git), `C:\\Users\\Jane_dev\\x` (Node) and
 * `C:\\Users\\JANE_D~1\\x` (8.3 short names in temp folders, subst drives);
 * macOS has /tmp -> /private/tmp. Every comparison and every settings key goes
 * through this, or settings saved by the CLI are never found by the hooks.
 */
export function canonicalPath(input) {
	const absolute = path.resolve(String(input));
	try {
		return fs.realpathSync.native(absolute);
	} catch {
		// Not there (yet): canonicalize the nearest folder that is.
		const parent = path.dirname(absolute);
		return parent === absolute ? absolute : path.join(canonicalPath(parent), path.basename(absolute));
	}
}

/** The key a repository's settings are stored under. Case-insensitive on Windows. */
export function repoKey(root) {
	const canonical = canonicalPath(root);
	return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

/** `file` relative to `root` with forward slashes, or null when it is outside (or is the root itself). */
export function relativeInside(root, file) {
	if (!root || !file) return null;
	const base = canonicalPath(root);
	const target = canonicalPath(path.isAbsolute(file) ? file : path.join(root, file));
	const rel = path.relative(base, target);
	if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
	return rel.split(path.sep).join('/');
}
