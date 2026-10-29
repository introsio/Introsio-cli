// Feature `stop-guard`: the agent may not finish while a task it claimed is still open in Introsio.

export function openClaims(session) {
	return Object.values(session.claims ?? {});
}

const describe = (claim) => `- "${claim.title}" (taskId ${claim.taskId}${claim.workerId ? `, workerId ${claim.workerId}` : ''})`;

export function stopDecision(session, evt, now) {
	const open = openClaims(session);
	if (open.length === 0) {
		session.lastBlock = null;
		return { type: 'none' };
	}
	const key = open.map((claim) => claim.taskId).sort().join(',');
	const retried = evt.stopHookActive || evt.loopCount > 0 || (session.lastBlock && now - session.lastBlock.at < 10 * 60_000);
	if (retried && session.lastBlock?.key === key && session.lastBlock.count >= 2) {
		// Asked twice and nothing changed: let it stop rather than loop forever, but say so.
		session.lastBlock = null;
		return {
			type: 'warn',
			message: `Introsio: stopping with ${open.length} claimed task(s) still open:\n${open.map(describe).join('\n')}\nThey stay in progress until their lease expires; the next claimTask resumes them.`,
		};
	}
	session.lastBlock = { key, at: now, count: session.lastBlock?.key === key ? session.lastBlock.count + 1 : 1 };
	return {
		type: 'block',
		message:
			`Introsio: you still hold ${open.length} claimed task(s) that are not completed:\n${open.map(describe).join('\n')}\n` +
			'Before you stop, for each one: if the work is done, call completeTask { taskId, workerId, outcome: { summary: what you ' +
			'produced, verification: how you checked it, files } }. If you cannot finish it, call updateTask { taskId, workerId, ' +
			'statusState: "blocked" } and tell the user why.',
	};
}
