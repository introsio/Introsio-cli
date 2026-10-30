// ~/.introsio/config.json — which features are on, and each repository's settings.
import { configPath, repoKey } from './paths.mjs';
import { readJson, readJsonSafe, writeJson } from './jsonFile.mjs';

/** Every hook feature, on by default. `int disable <name>` turns one off. */
export const FEATURES = {
	'stop-guard': 'Keep the agent from finishing while a task it claimed is still open in Introsio',
	'test-gate': "Run the repo's check command before a task can be completed (needs `int gate set`)",
	'shipped-gate': 'Before completing: work committed (local mode) or committed + pushed + branch recorded (github mode)',
	'push-guard': 'Block pushes to the default branch, force pushes, and every push in local mode',
	secrets: 'Block commits / pushes that add API keys, private keys or .env files',
	scope: "Warn when the agent edits files the claimed task doesn't mention",
	'worker-id': 'One workerId per session; refuse a claim with another live session\'s workerId',
	'compact-recovery': 'Restore the claimed task, workerId and progress after the context is compacted',
	lease: 'Remind the agent to report progress before its claim expires',
	reread: 'Skip re-reading context / schedule the agent already has',
	log: 'Record every Introsio call in ~/.introsio/log.jsonl (see `int stats`)',
};

export const MODES = ['github', 'local', 'off'];
export const DEFAULT_GATE_TIMEOUT_SEC = 300;

/**
 * Hooks read the config leniently (a broken file means defaults — never a stuck
 * agent). The CLI reads it strictly (`strict: true` throws on a broken file), so
 * a command never overwrites settings it could not read.
 */
export function loadConfig(env, { strict = false } = {}) {
	const config = strict ? readJson(configPath(env), {}) : readJsonSafe(configPath(env), {});
	return {
		features: { ...(config.features ?? {}) },
		repos: { ...(config.repos ?? {}) },
		mcpUrl: config.mcpUrl ?? null,
	};
}

export function saveConfig(config, env) {
	writeJson(configPath(env), config);
}

export function featureOn(config, name) {
	return config.features?.[name] !== false;
}

/** The settings of the repository at `root` (any spelling of its path), defaults filled in. */
export function repoSettings(config, root) {
	const stored = (root && (config.repos?.[repoKey(root)] ?? config.repos?.[root])) || {};
	return {
		mode: MODES.includes(stored.mode) ? stored.mode : null,
		gate: typeof stored.gate === 'string' && stored.gate.trim() ? stored.gate.trim() : null,
		gateTimeoutSec: Number(stored.gateTimeoutSec) > 0 ? Number(stored.gateTimeoutSec) : DEFAULT_GATE_TIMEOUT_SEC,
	};
}

export function updateRepo(config, root, patch) {
	const key = repoKey(root);
	const next = { ...(config.repos[key] ?? config.repos[root] ?? {}), ...patch };
	for (const [name, value] of Object.entries(next)) if (value === null || value === undefined) delete next[name];
	if (key !== root) delete config.repos[root];
	config.repos[key] = next;
	if (Object.keys(next).length === 0) delete config.repos[key];
	return config;
}
