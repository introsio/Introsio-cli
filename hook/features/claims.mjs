// Tracks which Introsio tasks this session holds, from the tools' own answers.
// Only a successful answer changes anything: a refused call means the agent must fix what the error names.

const PATH_IN_BACKTICKS = /`([^`\s]+)`/g;
const BARE_PATH = /(?:^|[\s(])((?:[\w@.-]+\/)+[\w@.-]+\.[A-Za-z0-9]+)(?=$|[\s),:;]|\.(?:\s|$))/gm;

/** File and folder paths a task spec names (`src/a.js`, src/b/, …). */
export function extractPaths(text) {
	const found = new Set();
	const add = (candidate) => {
		const value = candidate.replace(/^\.\//, '').replace(/[.,;:]+$/, '');
		if (!value || /^[a-z]+:\/\//i.test(value) || value.startsWith('@') || value.includes('*')) return;
		if (value.includes('/') || /\.[A-Za-z0-9]{1,6}$/.test(value)) found.add(value);
	};
	for (const match of String(text ?? '').matchAll(PATH_IN_BACKTICKS)) add(match[1]);
	for (const match of String(text ?? '').matchAll(BARE_PATH)) add(match[1]);
	return [...found].slice(0, 100);
}

const time = (value) => {
	const parsed = Date.parse(value ?? '');
	return Number.isFinite(parsed) ? parsed : null;
};

const countSubtasks = (task) => {
	const waves = Array.isArray(task?.subtaskWaves) ? task.subtaskWaves.flat() : [];
	const done = Number(task?.completedSubtasks) || 0;
	return { total: waves.length + done, done };
};

function rememberRevision(session, projectId, revision) {
	if (projectId && Number.isFinite(Number(revision))) session.contextRevision[projectId] = Number(revision);
}

export function isCompletionCall(name, args) {
	return name === 'completeTask' || (name === 'updateTask' && args?.completed === true);
}

const RELEASING_STATES = new Set(['blocked', 'pending']);

/** Applies one Introsio tool answer to the session. */
export function applyIntrosioResult(session, { name, args = {}, result }, now) {
	session.introsio = true;
	const data = result?.data;
	if (!result?.ok || !data) return;

	const projectId = data.project?.id ?? args.projectId ?? null;
	if (data.context && typeof data.context === 'object') rememberRevision(session, projectId, data.context.revision);

	switch (name) {
		case 'claimTask': {
			session.lastCompletion = null;
			if (data.claimed !== true || !data.task?.id) return;
			const id = String(data.task.id);
			const previous = session.claims[id];
			const expiresAt = time(data.leaseExpiresAt);
			session.claims[id] = {
				taskId: id,
				title: data.task.title ?? previous?.title ?? id,
				workerId: data.workerId ?? previous?.workerId ?? null,
				projectId,
				claimedAt: previous?.claimedAt ?? now,
				lastWriteAt: now,
				expiresAt,
				leaseMs: expiresAt ? Math.max(60_000, expiresAt - now) : 30 * 60_000,
				nudgedAt: null,
				repository: data.repository ?? null,
				branch: data.task.outcome?.branch ?? previous?.branch ?? null,
				files: extractPaths(data.task.description),
				subtasks: countSubtasks(data.task),
			};
			if (data.workerId) session.workerId = data.workerId;
			return;
		}
		case 'completeTask': {
			const id = String(args.taskId ?? data.task?.id ?? '');
			if (data.task && data.task.completed === false) return;
			delete session.claims[id];
			session.lastCompletion = {
				taskId: id,
				at: now,
				nowReady: Array.isArray(data.nowReady) ? data.nowReady.map((task) => task.id).filter(Boolean) : [],
				projectComplete: data.projectComplete === true,
				rereadDenied: false,
			};
			return;
		}
		case 'updateTask': {
			const id = String(args.taskId ?? data.task?.id ?? '');
			const claim = session.claims[id];
			if (args.completed === true || (Object.hasOwn(args, 'statusState') && (args.statusState === null || RELEASING_STATES.has(args.statusState)))) {
				delete session.claims[id];
				return;
			}
			if (args.statusState === 'in_progress' && !claim && data.task?.id) {
				const expiresAt = time(data.task.claim?.expiresAt);
				session.claims[id] = {
					taskId: id, title: data.task.title ?? id, workerId: data.task.claim?.workerId ?? args.workerId ?? null,
					projectId, claimedAt: now, lastWriteAt: now, expiresAt,
					leaseMs: expiresAt ? Math.max(60_000, expiresAt - now) : 30 * 60_000,
					nudgedAt: null, repository: null, branch: args.outcome?.branch ?? null, files: [], subtasks: { total: 0, done: 0 },
				};
				if (session.claims[id].workerId) session.workerId = session.workerId ?? session.claims[id].workerId;
				return;
			}
			if (claim) {
				claim.lastWriteAt = now;
				const expiresAt = time(data.task?.claim?.expiresAt);
				if (expiresAt) claim.expiresAt = expiresAt;
				if (args.outcome?.branch) claim.branch = args.outcome.branch;
			}
			return;
		}
		case 'updateSubtask': {
			const claim = session.claims[String(args.taskId ?? '')];
			if (!claim) return;
			claim.lastWriteAt = now;
			const expiresAt = time(data.task?.claim?.expiresAt);
			if (expiresAt) claim.expiresAt = expiresAt;
			const counts = data.task?.subtasks;
			if (counts && Number.isFinite(counts.total)) claim.subtasks = { total: counts.total, done: counts.total - (Number(counts.open) || 0) };
			return;
		}
		case 'getProjectContext': {
			const pid = args.projectId ?? null;
			if (pid && Number.isFinite(Number(data.revision))) {
				rememberRevision(session, pid, data.revision);
				session.contextRead[pid] = Number(data.revision);
			}
			return;
		}
		case 'getProjectState':
		case 'getExecutionWaves': {
			const pid = args.projectId ?? null;
			rememberRevision(session, pid, data.context?.revision ?? data.contextRevision);
			return;
		}
		default:
	}
}

/**
 * Fallback for agents whose after-tool hook does not see MCP calls: rebuild the
 * open set from the transcript. Format-agnostic — it looks for the Introsio
 * answers themselves (a claim's work packet, a completion receipt), which are
 * distinctive JSON wherever the agent stores them.
 */
export function claimsFromTranscript(text, now) {
	const claims = {};
	const visit = (value, depth) => {
		if (depth > 8 || value === null || value === undefined) return;
		if (typeof value === 'string') {
			const trimmed = value.trim();
			if (trimmed.startsWith('{') && (trimmed.includes('"claimed"') || trimmed.includes('"nowReady"'))) {
				try { visit(JSON.parse(trimmed), depth + 1); } catch { /* not JSON */ }
			}
			return;
		}
		if (Array.isArray(value)) { value.forEach((item) => visit(item, depth + 1)); return; }
		if (typeof value !== 'object') return;
		if (value.claimed === true && value.task?.id) {
			claims[value.task.id] = { taskId: value.task.id, title: value.task.title ?? value.task.id, workerId: value.workerId ?? null, claimedAt: now, lastWriteAt: now, expiresAt: time(value.leaseExpiresAt), files: [], subtasks: countSubtasks(value.task) };
			return;
		}
		if (value.success === true && Array.isArray(value.nowReady) && value.task?.id && value.task.completed === true) {
			delete claims[value.task.id];
			return;
		}
		Object.values(value).forEach((item) => visit(item, depth + 1));
	};
	for (const line of String(text ?? '').split('\n')) {
		if (!line.includes('claimed') && !line.includes('nowReady')) continue;
		try { visit(JSON.parse(line), 0); } catch { /* a partial line */ }
	}
	return claims;
}
