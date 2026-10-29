// Feature `worker-id`: one workerId per session, never shared with another live session.
import os from 'node:os';

export function makeWorkerId(agent, sessionId, host = os.hostname()) {
	const clean = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
	const id = [clean(agent) || 'agent', clean(host).slice(0, 20) || 'host', clean(sessionId).replace(/-/g, '').slice(0, 8) || 'session']
		.join('-');
	return id.slice(0, 64);
}

const STARTS_WORK = (name, args) => name === 'claimTask' || (name === 'updateTask' && args?.statusState === 'in_progress');

/** Before claimTask (or a start): refuse a workerId another live session is using, and a second claim without one. */
export function workerIdDecision(session, others, { name, args = {} }, now) {
	if (!STARTS_WORK(name, args)) return { type: 'none' };
	const requested = typeof args.workerId === 'string' ? args.workerId.trim() : '';
	const held = Object.values(session.claims ?? {});
	if (!requested) {
		if (held.length > 0 && name === 'claimTask' && !args.taskId) {
			const mine = session.workerId ?? held[0].workerId;
			return {
				type: 'deny',
				message: `Introsio: pass your workerId "${mine}" — without it the server treats this as a new worker and hands out a second task while you still hold "${held[0].title}".`,
			};
		}
		return { type: 'none' };
	}
	const taken = others.find((other) => other.workerId === requested
		&& Object.values(other.claims ?? {}).some((claim) => !claim.expiresAt || claim.expiresAt > now));
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
