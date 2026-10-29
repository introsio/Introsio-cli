// The one decision point every agent's hooks go through: a normalized event in,
// an answer ({ type: none | deny | context | block | warn, message }) out.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, featureOn, repoSettings } from '../lib/config.mjs';
import { createGit } from '../lib/git.mjs';
import { gateCachePath } from '../lib/paths.mjs';
import { readJsonSafe, readText, writeJson } from '../lib/jsonFile.mjs';
import { loadSession, saveSession, loadOtherSessions, sessionExists } from './state.mjs';
import { applyIntrosioResult, claimsFromTranscript, isCompletionCall } from './features/claims.mjs';
import { stopDecision } from './features/stopGuard.mjs';
import { makeWorkerId, workerIdDecision } from './features/workerId.mjs';
import { shippedDecision, testGateDecision, resolveMode } from './features/gates.mjs';
import { pushDecision, secretsDecision } from './features/git.mjs';
import { scopeNote, leaseNote, recoveryNote, rereadDecision } from './features/notes.mjs';
import { logRow, writeLog } from './features/log.mjs';

const NONE = Object.freeze({ type: 'none' });
const GIT_WRITE = /\bgit\b[^\n]*\b(push|commit)\b/;
// Agents whose after-tool hook may not see MCP calls: their stop check falls back to the transcript.
const TRANSCRIPT_FALLBACK = new Set(['codex', 'gemini']);

/**
 * Whether an event can matter to a session that has never used Introsio. Most
 * tool calls in most sessions are not Introsio's: those return at once, with no
 * state file read or written.
 */
function relevantWithoutSession(evt) {
	if (evt.tool?.kind === 'introsio') return true;
	if (evt.tool?.kind === 'shell' && GIT_WRITE.test(evt.tool.command ?? '')) return true;
	return evt.event === 'stop' && !!evt.transcriptPath && TRANSCRIPT_FALLBACK.has(evt.agent);
}

function gateCache(env) {
	const file = gateCachePath(env);
	const data = readJsonSafe(file, {});
	return {
		get: (root) => data[root],
		set: (root, value) => {
			data[root] = value;
			writeJson(file, data);
		},
	};
}

function firstDeny(...decisions) {
	for (const decide of decisions) {
		const answer = decide();
		if (answer?.type === 'deny') return answer;
	}
	return NONE;
}

const context = (notes) => {
	const text = notes.filter(Boolean).join('\n');
	return text ? { type: 'context', message: text } : NONE;
};

export function handleEvent(evt, deps = {}) {
	const env = deps.env ?? process.env;
	if (!evt || String(env.INTROSIO_HOOKS ?? '').toLowerCase() === 'off') return NONE;
	const existed = sessionExists(evt.sessionId, env);
	if (!existed && !relevantWithoutSession(evt)) return NONE;
	const now = deps.now ?? Date.now();
	const config = loadConfig(env);
	const on = (feature) => featureOn(config, feature);
	const session = loadSession(evt.sessionId, evt.agent, now, env);
	session.lastSeenAt = now;
	session.agent = evt.agent;
	if (evt.cwd) session.cwd = evt.cwd;
	if (!session.workerId) session.workerId = makeWorkerId(evt.agent, evt.sessionId, deps.hostname);

	let gitHandle = null;
	const git = () => (gitHandle ??= (deps.createGit ?? createGit)(evt.cwd ?? session.cwd ?? process.cwd()));
	const settingsHere = () => repoSettings(config, git().root());

	let answer = NONE;
	switch (evt.event) {
		case 'session-start': {
			if (evt.source === 'compact' || session.contextLost) {
				session.contextLost = false;
				if (on('compact-recovery')) answer = context([recoveryNote(session)]);
			}
			break;
		}
		case 'compact': {
			session.contextRead = {};
			session.rereadDenied = {};
			if (session.lastCompletion) session.lastCompletion.rereadDenied = true;
			session.contextLost = true;
			break;
		}
		case 'before-tool': {
			const tool = evt.tool ?? {};
			if (tool.kind === 'introsio') {
				session.introsio = true;
				session.pending[tool.name] = now;
				const claim = session.claims[String(tool.args?.taskId ?? '')];
				const completing = claim && isCompletionCall(tool.name, tool.args);
				answer = firstDeny(
					() => (on('worker-id') ? workerIdDecision(session, loadOtherSessions(session.sessionId, now, env), tool, now) : NONE),
					() => (on('reread') ? rereadDecision(session, tool) : NONE),
					() => (completing && on('shipped-gate') ? shippedDecision({ git: git(), settings: settingsHere(), claim, args: tool.args }) : NONE),
					() => (completing && on('test-gate') ? testGateDecision({ git: git(), settings: settingsHere(), claim, cache: gateCache(env), runGate: deps.runGate, now }) : NONE),
				);
			} else if (tool.kind === 'shell' && GIT_WRITE.test(tool.command ?? '')) {
				const root = git().root();
				const settings = repoSettings(config, root);
				const claim = Object.values(session.claims)[0];
				const active = session.introsio || settings.mode || settings.gate;
				if (!root || !active) break;
				const mode = resolveMode(settings, claim);
				answer = firstDeny(
					() => (on('push-guard') ? pushDecision({ command: tool.command, mode, git: git(), defaultBranch: claim?.repository?.defaultBranch }) : NONE),
					() => (on('secrets') ? secretsDecision({ command: tool.command, git: git(), readFile: (file) => readSmallFile(path.join(root, file)) }) : NONE),
				);
			}
			break;
		}
		case 'after-tool': {
			const tool = evt.tool ?? {};
			const notes = [];
			if (tool.kind === 'introsio') {
				session.sawIntrosioResult = true;
				const hadClaims = Object.keys(session.claims).length;
				applyIntrosioResult(session, { name: tool.name, args: tool.args, result: evt.result }, now);
				if (on('log')) writeLog(logRow(session, evt, { name: tool.name, args: tool.args, result: evt.result }, now), env);
				if (tool.name === 'claimTask' && Object.keys(session.claims).length > hadClaims && !session.modeNoted && on('shipped-gate')) {
					const claim = Object.values(session.claims).at(-1);
					const settings = settingsHere();
					const mode = resolveMode(settings, claim);
					session.modeNoted = true;
					if (mode === 'local' && git().root()) {
						notes.push('Introsio (local mode): this repository stays on this computer. Commit your work locally (no push), then completeTask with the commit id in outcome.summary.');
					}
				}
			} else if (tool.kind === 'edit' && on('scope')) {
				notes.push(scopeNote(session, tool.files ?? [], git().root()));
			}
			if (session.contextLost && on('compact-recovery')) {
				session.contextLost = false;
				notes.push(recoveryNote(session));
			}
			if (on('lease')) notes.push(leaseNote(session, now));
			answer = context(notes);
			break;
		}
		case 'stop': {
			if (!on('stop-guard')) break;
			if (!session.sawIntrosioResult && evt.transcriptPath && TRANSCRIPT_FALLBACK.has(evt.agent)) {
				// This agent's after-tool hook never saw an MCP call: rebuild from the transcript.
				const rebuilt = claimsFromTranscript(readText(evt.transcriptPath), now);
				session.claims = { ...rebuilt };
			}
			answer = stopDecision(session, evt, now);
			break;
		}
		default:
	}
	if (existed || session.introsio) saveSession(session, env);
	return answer;
}

function readSmallFile(file) {
	try {
		const stat = fs.statSync(file);
		if (!stat.isFile() || stat.size > 1024 * 1024) return '';
		const text = fs.readFileSync(file, 'utf8');
		return text.includes('\u0000') ? '' : text;
	} catch {
		return '';
	}
}
