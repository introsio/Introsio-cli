// Per-session state: one small JSON file per agent session under ~/.introsio/sessions,
// so parallel sessions never write the same file.
import fs from 'node:fs';
import path from 'node:path';
import { sessionsDir } from '../lib/paths.mjs';
import { readJsonSafe, writeJson } from '../lib/jsonFile.mjs';

export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

const safeName = (sessionId) => String(sessionId || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);

export function emptySession(sessionId, agent, now) {
	return {
		sessionId: String(sessionId || 'unknown'),
		agent,
		workerId: null,
		cwd: null,
		startedAt: now,
		lastSeenAt: now,
		claims: {},
		contextRevision: {},
		contextRead: {},
		lastCompletion: null,
		lastBlock: null,
		pending: {},
		warnedFiles: [],
		editedFiles: [],
		agentPid: null,
		notes: [],
		contextLost: false,
		sawIntrosioResult: false,
	};
}

export function loadSession(sessionId, agent, now, env) {
	const stored = readJsonSafe(path.join(sessionsDir(env), `${safeName(sessionId)}.json`), null);
	return stored ? { ...emptySession(sessionId, agent, now), ...stored } : emptySession(sessionId, agent, now);
}

export function sessionFile(sessionId, env) {
	return path.join(sessionsDir(env), `${safeName(sessionId)}.json`);
}

export function sessionExists(sessionId, env) {
	return fs.existsSync(sessionFile(sessionId, env));
}

export function saveSession(session, env) {
	writeJson(path.join(sessionsDir(env), `${safeName(session.sessionId)}.json`), session);
}

/** Every other session seen in the last day (for worker-id collisions and `int claims`). */
export function loadOtherSessions(sessionId, now, env) {
	const dir = sessionsDir(env);
	let names = [];
	try {
		names = fs.readdirSync(dir).filter((name) => name.endsWith('.json') && !name.includes('.tmp'));
	} catch {
		return [];
	}
	const own = `${safeName(sessionId)}.json`;
	const out = [];
	for (const name of names) {
		if (name === own) continue;
		const session = readJsonSafe(path.join(dir, name), null);
		if (!session) continue;
		if (now - Number(session.lastSeenAt || 0) > SESSION_TTL_MS) {
			try { fs.unlinkSync(path.join(dir, name)); } catch { /* another hook pruned it */ }
			continue;
		}
		out.push(session);
	}
	return out;
}

export function clearSessions(env) {
	const dir = sessionsDir(env);
	let removed = 0;
	try {
		for (const name of fs.readdirSync(dir)) {
			if (!name.endsWith('.json')) continue;
			fs.unlinkSync(path.join(dir, name));
			removed += 1;
		}
	} catch { /* nothing to clear */ }
	return removed;
}
