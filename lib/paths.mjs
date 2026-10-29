// Every path the kit reads or writes, resolved from one HOME so tests can point it at a scratch folder.
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
