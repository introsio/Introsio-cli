// The one decision point every agent's hooks go through: a normalized event in,
// an answer ({ type: none | deny | context | block | warn, message }) out.
//
// Concurrency: agents run the hooks of parallel tool calls at the same time, so
// every read-modify-write of a session happens under that session's lock. The
// test gate (minutes) runs after the lock is released.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, featureOn, repoSettings } from '../lib/config.mjs';
import { createGit } from '../lib/git.mjs';
import { gateCachePath, sessionsDir, relativeInside } from '../lib/paths.mjs';
import { readJsonSafe, writeJson } from '../lib/jsonFile.mjs';
import { acquireLock } from '../lib/lock.mjs';
import { agentPid } from '../lib/processTree.mjs';
import { loadSession, saveSession, loadOtherSessions, sessionExists, sessionFile } from './state.mjs';
import { applyIntrosioResult, updateClaimsFromTranscript, isCompletionCall } from './features/claims.mjs';
import { stopDecision } from './features/stopGuard.mjs';
import { makeWorkerId, workerIdDecision } from './features/workerId.mjs';
import { shippedDecision, planTestGate, runTestGate, resolveMode, workTreeKey } from './features/gates.mjs';
import { pushDecision, secretsDecision } from './features/git.mjs';
import { scopeNote, leaseNote, recoveryNote, rereadDecision } from './features/notes.mjs';
import { logRow, writeLog } from './features/log.mjs';
import { pauseDecision, recordPause, forgetPause, pauseInAnswer, resumeReport, formatReport, readLocalPause, interruptedNote } from './features/pause.mjs';

const NONE = Object.freeze({ type: 'none' });
const GIT_WRITE = /\bgit\b[^\n]*\b(push|commit)\b/;
// Agents whose after-tool hook may not see MCP calls: their stop check falls back to the transcript.
const TRANSCRIPT_FALLBACK = new Set(['codex', 'gemini']);
const MAX_EDITED_FILES = 500;

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
	return {
		get: (root) => readJsonSafe(file, {})[root],
		set: (root, value) => {
			const data = readJsonSafe(file, {});
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

export async function handleEvent(evt, deps = {}) {
	const env = deps.env ?? process.env;
	if (!evt || String(env.INTROSIO_HOOKS ?? '').toLowerCase() === 'off') return NONE;
	const existed = sessionExists(evt.sessionId, env);
	if (!existed && !relevantWithoutSession(evt)) return NONE;

	fs.mkdirSync(sessionsDir(env), { recursive: true });
	const release = await acquireLock(sessionFile(evt.sessionId, env));
	let gatePlan = null;
	let gateClaim = null;
	let answer = NONE;
	try {
		const now = deps.now ?? Date.now();
		const config = loadConfig(env);
		const on = (feature) => featureOn(config, feature);
		const session = loadSession(evt.sessionId, evt.agent, now, env);
		session.lastSeenAt = now;
		session.agent = evt.agent;
		if (evt.cwd) session.cwd = evt.cwd;
		if (!session.workerId) session.workerId = makeWorkerId(evt.agent, evt.sessionId, deps.hostname);
		if (!session.agentPid && evt.agent !== 'opencode') session.agentPid = deps.agentPid ?? agentPid();

		let gitHandle = null;
		const git = () => (gitHandle ??= (deps.createGit ?? createGit)(evt.cwd ?? session.cwd ?? process.cwd()));
		const settingsHere = () => repoSettings(config, git().root());

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
						() => (on('worker-id') ? workerIdDecision(session, loadOtherSessions(session.sessionId, now, env), tool, now, deps.isAlive) : NONE),
						() => (on('reread') ? rereadDecision(session, tool) : NONE),
						() => (tool.name === 'pauseTask' && on('pause') ? pauseDecision({ git: git(), args: tool.args, session, now, budgetMs: deps.snapshotBudgetMs }) : NONE),
						() => (completing && on('shipped-gate') ? shippedDecision({ git: git(), settings: settingsHere(), claim, args: tool.args, session }) : NONE),
					);
					if (answer.type !== 'deny' && completing && on('test-gate')) {
						gatePlan = planTestGate({ git: git(), settings: settingsHere(), cache: gateCache(env) });
						gateClaim = claim;
					}
				} else if (tool.kind === 'shell' && GIT_WRITE.test(tool.command ?? '')) {
					const root = git().root();
					const settings = repoSettings(config, root);
					const claim = Object.values(session.claims)[0];
					const active = session.introsio || settings.mode || settings.gate;
					if (!root || !active) break;
					const mode = resolveMode(settings, claim);
					let note = null;
					answer = firstDeny(
						() => (on('push-guard') ? pushDecision({ command: tool.command, mode, git: git(), defaultBranch: claim?.repository?.defaultBranch }) : NONE),
						() => {
							if (!on('secrets')) return NONE;
							const decision = secretsDecision({ command: tool.command, git: git(), readFile: (file) => readSmallFile(path.join(root, file)) });
							note = decision.note ?? null;
							return decision;
						},
					);
					if (answer.type !== 'deny' && note) session.notes = [...(session.notes ?? []), note].slice(-3);
				}
				break;
			}
			case 'after-tool': {
				const tool = evt.tool ?? {};
				const notes = [];
				if (tool.kind === 'introsio') {
					session.sawIntrosioResult = true;
					const hadClaims = Object.keys(session.claims).length;
					const pausedClaim = tool.name === 'pauseTask' ? session.claims[String(tool.args?.taskId ?? '')] : null;
					applyIntrosioResult(session, { name: tool.name, args: tool.args, result: evt.result }, now);
					if (on('pause')) notes.push(...pauseNotes({ tool, result: evt.result, session, pausedClaim, git, config, env, now, deps }));
					if (on('log')) writeLog(logRow(session, evt, { name: tool.name, args: tool.args, result: evt.result }, now), env);
					if (tool.name === 'claimTask' && Object.keys(session.claims).length > hadClaims && !session.modeNoted && on('shipped-gate')) {
						const claim = Object.values(session.claims).at(-1);
						session.modeNoted = true;
						if (resolveMode(settingsHere(), claim) === 'local' && git().root()) {
							notes.push('Introsio (local mode): this repository stays on this computer. Commit your work locally (no push), then completeTask with the commit id in outcome.summary.');
						}
					}
				} else if (tool.kind === 'edit') {
					const root = git().root();
					const edited = new Set(session.editedFiles ?? []);
					for (const file of tool.files ?? []) {
						const rel = relativeInside(root, file);
						if (rel) edited.add(rel);
					}
					session.editedFiles = [...edited].slice(-MAX_EDITED_FILES);
					if (on('scope')) notes.push(scopeNote(session, tool.files ?? [], root));
				}
				if (session.notes?.length) {
					notes.push(...session.notes);
					session.notes = [];
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
					// This agent's after-tool hook never saw an Introsio call: read the transcript instead.
					updateClaimsFromTranscript(session, evt.transcriptPath, now, fs);
				}
				answer = stopDecision(session, evt, now);
				break;
			}
			default:
		}
		// A transcript offset is worth keeping even before any Introsio call: the next stop then reads only what is new.
		if (existed || session.introsio || session.transcript) saveSession(session, env);
	} finally {
		release();
	}

	if (gatePlan) {
		return runTestGate(gatePlan, { claim: gateClaim, cache: gateCache(env), runGate: deps.runGate, now: deps.now ?? Date.now() });
	}
	return answer;
}

/**
 * Feature `pause`, after an Introsio answer: keep the snapshot of a pause that
 * landed, drop it once the task is done, check the repository against any pause
 * an answer carries, and say so when a task was left by a session that died.
 */
function pauseNotes({ tool, result, session, pausedClaim, git, config, env, now, deps }) {
	const data = result?.data;
	const notes = [];
	const root = () => git().root();
	const gatePassed = () => {
		const settings = repoSettings(config, root());
		if (!settings.gate) return null;
		const key = workTreeKey(git(), settings.gate);
		return !!key && readJsonSafe(gateCachePath(env), {})[root()]?.key === key;
	};
	if (tool.name === 'pauseTask' && result?.ok && data?.success !== false) {
		if (pausedClaim) session.claims[String(tool.args?.taskId)] = pausedClaim; // recordPause reads the title / files once more
		const record = recordPause({ git: root() ? git() : null, session, args: tool.args, data, now, env, gatePassed: root() ? gatePassed() : null });
		delete session.claims[String(tool.args?.taskId)];
		if (record) {
			notes.push(`Introsio: paused "${record.title}".${record.snapshot ? ` The working tree is saved as ${record.ref} (local only, never pushed; your files are untouched).` : record.snapshotError ? ` No snapshot of the working tree (${record.snapshotError}) — resume will compare file lists only.` : ''}` +
				` Resume later with /introsio-resume ${record.taskId}.`);
		}
		return notes;
	}
	if (tool.name === 'completeTask' && result?.ok && data?.task?.completed !== false && tool.args?.taskId) {
		forgetPause({ git: root() ? git() : null, taskId: String(tool.args.taskId), env });
		if (session.paused) delete session.paused[String(tool.args.taskId)];
		return notes;
	}
	const found = result?.ok ? pauseInAnswer(tool.name, data) : null;
	if (found?.resumed && session.paused) delete session.paused[found.taskId];
	if (found) {
		const key = `${found.taskId}:${found.pause?.at ?? ''}:${found.resumed ? 'r' : 'p'}`;
		session.resumeChecked = session.resumeChecked ?? {};
		if (session.resumeChecked[key]) return notes;
		session.resumeChecked[key] = now;
		const report = resumeReport({
			git: root() ? git() : null,
			taskId: found.taskId,
			pause: found.pause,
			local: readLocalPause(found.taskId, env),
			others: loadOtherSessions(session.sessionId, now, env),
			now,
			alive: deps.isAlive,
			taskChanged: found.changed === true,
			gatePassedNow: root() ? gatePassed() : null,
		});
		const title = data.title ?? data.name ?? data.task?.title ?? found.taskId;
		notes.push(formatReport(title, report, { resumed: found.resumed }));
		return notes;
	}
	// Interrupted without a pause: the task is held by a session on this computer whose agent died.
	const taskId = String(tool.args?.taskId ?? data?.id ?? '');
	const claimWorkerId = tool.name === 'getTaskById' && result?.ok
		? data?.claim?.workerId
		: (!result?.ok && Number(data?.status) === 409 ? (data?.claimedBy?.workerId ?? data?.details?.claimedBy?.workerId) : null);
	if (taskId && claimWorkerId && claimWorkerId !== session.workerId) {
		const note = interruptedNote({ taskId, claimWorkerId, others: loadOtherSessions(session.sessionId, now, env), now, alive: deps.isAlive });
		if (note) notes.push(note);
	}
	return notes;
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
