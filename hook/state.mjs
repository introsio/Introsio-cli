// Per-session state: one small JSON file per agent session under ~/.introsio/sessions,
// so parallel sessions never write the same file.
import fs from 'node:fs';
import path from 'node:path';
import { sessionsDir } from '../lib/paths.mjs';
import { readJsonSafe, writeJson } from '../lib/jsonFile.mjs';
import { acquireLock, SAVE_WAIT_MS } from '../lib/lock.mjs';

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

const KEYED = ['claims', 'paused', 'pending', 'pendingPause', 'contextRevision', 'contextRead', 'rereadDenied', 'resumeChecked'];
const LISTS = ['editedFiles', 'warnedFiles'];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isMap = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * When the session lock could not be taken in time, other hooks of the same
 * session may have written meanwhile: apply only what THIS hook changed (since
 * `start`, the session as it was loaded) on top of what is on disk now, instead
 * of overwriting their claims with a stale copy.
 */
export function mergeSessionChanges(start, ours, disk) {
	if (!disk) return ours;
	const merged = { ...disk };
	for (const [key, value] of Object.entries(ours)) {
		if (KEYED.includes(key) && isMap(value)) {
			const before = isMap(start[key]) ? start[key] : {};
			const next = { ...(isMap(disk[key]) ? disk[key] : {}) };
			for (const id of Object.keys(before)) if (!(id in value)) delete next[id];
			for (const [id, item] of Object.entries(value)) if (!(id in before) || !same(before[id], item)) next[id] = item;
			merged[key] = next;
		} else if (LISTS.includes(key) && Array.isArray(value)) {
			const before = new Set(Array.isArray(start[key]) ? start[key] : []);
			const added = value.filter((item) => !before.has(item));
			merged[key] = [...new Set([...(Array.isArray(disk[key]) ? disk[key] : []), ...added])];
		} else if (!same(start[key], value)) {
			merged[key] = value;
		}
	}
	for (const key of Object.keys(start)) if (!(key in ours)) delete merged[key];
	return merged;
}

/**
 * Saves a session this hook worked on without the lock: takes the lock once
 * more for the short read-merge-write (so two such hooks cannot race each
 * other), and merges its own changes into whatever another hook saved meanwhile.
 */
export async function saveSessionUnlocked(start, session, env) {
	const file = sessionFile(session.sessionId, env);
	const release = await acquireLock(file, { waitMs: SAVE_WAIT_MS });
	try {
		saveSession(mergeSessionChanges(start, session, readJsonSafe(file, null)), env);
	} finally {
		release();
	}
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
