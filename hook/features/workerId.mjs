// Feature `worker-id`: one workerId per session, never shared with another live session.
import os from 'node:os';
import { isAlive } from '../../lib/processTree.mjs';

/** Without a known agent process, a session counts as live this long after its last hook. */
export const LIVE_WINDOW_MS = 10 * 60_000;

/** Whether another session is still running: its agent process is alive, or it was heard from recently. */
export function sessionIsLive(other, now, alive = isAlive) {
	if (other.agentPid) return alive(other.agentPid);
	return now - Number(other.lastSeenAt || 0) < LIVE_WINDOW_MS;
}

export function makeWorkerId(agent, sessionId, host = os.hostname()) {
	const clean = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
	const id = [clean(agent) || 'agent', clean(host).slice(0, 20) || 'host', clean(sessionId).replace(/-/g, '').slice(0, 8) || 'session']
		.join('-');
	return id.slice(0, 64);
}

const STARTS_WORK = (name, args) => name === 'claimTask' || (name === 'updateTask' && args?.statusState === 'in_progress');

/** Before claimTask (or a start): refuse a workerId another live session is using, and a second claim without one. */
export function workerIdDecision(session, others, { name, args = {} }, now, alive = isAlive) {
	if (!STARTS_WORK(name, args)) return { type: 'none' };
	const requested = typeof args.workerId === 'string' ? args.workerId.trim() : '';
	const held = Object.values(session.claims ?? {});
	if (!requested) {
		if (held.length > 0 && name === 'claimTask' && !args.taskId) {
			const mine = session.workerId ?? held[0].workerId;
			return {
				type: 'deny',
				message: `Introsio: pass a workerId. To continue "${held[0].title}", use "${mine}". If you are a separate parallel worker (e.g. a subagent), use your own, e.g. "${mine}-2" — without one the server cannot tell workers apart.`,
			};
		}
		return { type: 'none' };
	}
	const taken = others.find((other) => Object.values(other.claims ?? {}).some((claim) => (claim.workerId ?? other.workerId) === requested
		&& (!claim.expiresAt || claim.expiresAt > now))
		&& sessionIsLive(other, now, alive));
	if (taken) {
		const mine = session.workerId && session.workerId !== requested ? session.workerId : null;
		return {
			type: 'deny',
			message: `Introsio: workerId "${requested}" is in use by another live ${taken.agent ?? 'agent'} session. Two sessions with one workerId look like one worker and can both work the same task. Use ${mine ? `your own workerId "${mine}"` : 'a workerId of your own'}.`,
		};
	}
	return { type: 'none' };
}

export function workerIdNote(session) {
	return session.workerId
		? `Introsio: if you execute an Introsio project in this session, use workerId "${session.workerId}" on claimTask, updateTask, updateSubtask and completeTask.`
		: null;
}
