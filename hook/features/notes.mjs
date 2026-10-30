// Features `scope`, `lease`, `compact-recovery` and `reread`: short notes that save the agent work.
import path from 'node:path';
import { relativeInside } from '../../lib/paths.mjs';

const IGNORED = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|go\.sum)$/;

/** `scope`: a soft warning when an edit lands outside the files the claimed task names. */
export function scopeNote(session, files, root) {
	const claims = Object.values(session.claims ?? {}).filter((claim) => claim.files?.length);
	if (claims.length === 0 || !root) return null;
	const named = claims.flatMap((claim) => claim.files);
	const outside = [];
	for (const file of files) {
		const rel = relativeInside(root, file);
		if (!rel || IGNORED.test(rel) || session.warnedFiles.includes(rel)) continue;
		const inScope = named.some((entry) => {
			const clean = entry.replace(/\/$/, '');
			return rel === clean || rel.startsWith(`${clean}/`) || rel.endsWith(`/${clean}`) || path.posix.basename(rel) === clean;
		});
		if (!inScope) {
			outside.push(rel);
			session.warnedFiles.push(rel);
		}
	}
	if (outside.length === 0) return null;
	return `Introsio: ${outside.join(', ')} ${outside.length === 1 ? 'is' : 'are'} not among the files "${claims[0].title}" names. Fine if the task needs it — otherwise keep the change to the task's scope, and list every file you touched in outcome.files.`;
}

const clock = (ms) => new Date(ms).toISOString().slice(11, 16) + ' UTC';

/** `lease`: one reminder per write when a claim is 60% through its lease. */
export function leaseNote(session, now) {
	const notes = [];
	for (const claim of Object.values(session.claims ?? {})) {
		if (!claim.expiresAt) continue;
		if (claim.nudgedAt && claim.nudgedAt >= claim.lastWriteAt) continue;
		const lease = claim.leaseMs || claim.expiresAt - claim.lastWriteAt;
		if (now >= claim.expiresAt) {
			notes.push(`Introsio: your claim on "${claim.title}" expired at ${clock(claim.expiresAt)} — another worker may take it. Call claimTask { taskId: "${claim.taskId}", workerId: "${claim.workerId}" } to hold it again before you continue.`);
			claim.nudgedAt = now;
		} else if (now - claim.lastWriteAt > 0.6 * lease) {
			notes.push(`Introsio: your claim on "${claim.title}" expires at ${clock(claim.expiresAt)}. Report progress (updateSubtask, or updateTask with workerId "${claim.workerId}") to keep it.`);
			claim.nudgedAt = now;
		}
	}
	return notes.length ? notes.join('\n') : null;
}

/** `compact-recovery`: what the agent needs to carry on after its context was compacted. */
export function recoveryNote(session) {
	const claims = Object.values(session.claims ?? {});
	if (!session.introsio && claims.length === 0) return null;
	const lines = [`Introsio (restored after compaction): your workerId is "${session.workerId ?? claims[0]?.workerId ?? 'unset'}".`];
	for (const claim of claims) {
		const revision = claim.projectId != null ? session.contextRevision?.[claim.projectId] : undefined;
		const parts = [
			claim.subtasks?.total ? `subtasks ${claim.subtasks.done}/${claim.subtasks.total} done` : null,
			revision !== undefined ? `context revision ${revision}` : null,
			claim.expiresAt ? `lease until ${clock(claim.expiresAt)}` : null,
		].filter(Boolean);
		lines.push(`You hold "${claim.title}" (taskId ${claim.taskId}${claim.projectId ? `, project ${claim.projectId}` : ''})${parts.length ? ` — ${parts.join(', ')}` : ''}. Continue it (getReadySubtasks shows the next step), then completeTask with outcome.`);
	}
	if (claims.length === 0) lines.push('You hold no task. claimTask { projectId, workerId } takes the next one.');
	return lines.join('\n');
}

/** `reread`: refuse once a read whose answer the agent already has; a second identical call goes through. */
export function rereadDecision(session, { name, args = {} }) {
	if (session.contextLost) return { type: 'none' };
	if (name === 'getProjectContext') {
		const pid = args.projectId;
		const read = session.contextRead?.[pid];
		const latest = session.contextRevision?.[pid];
		if (read === undefined || latest === undefined || read !== latest) return { type: 'none' };
		const key = `context:${pid}:${latest}`;
		session.rereadDenied = session.rereadDenied ?? {};
		if (session.rereadDenied[key]) return { type: 'none' };
		session.rereadDenied[key] = true;
		return { type: 'deny', message: `Introsio: revision ${latest} of this project's context was already read in this session and has not changed — use what you have. If it is not in your context (you are a subagent, or it was trimmed), call again and it goes through.` };
	}
	if ((name === 'getExecutionWaves' || name === 'getProjectPlan') && session.lastCompletion?.nowReady?.length && !session.lastCompletion.rereadDenied) {
		session.lastCompletion.rereadDenied = true;
		return { type: 'deny', message: `Introsio: your last completeTask already said what is next — nowReady: ${session.lastCompletion.nowReady.join(', ')}. Call claimTask { projectId, workerId } instead of re-reading the schedule. (Call again if you really need the whole schedule.)` };
	}
	return { type: 'none' };
}
