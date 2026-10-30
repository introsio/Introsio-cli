// Feature `stop-guard`: the agent may not finish while a task it claimed is still open in Introsio.

export function openClaims(session) {
	return Object.values(session.claims ?? {});
}

const describe = (claim) => `- "${claim.title}" (taskId ${claim.taskId}${claim.workerId ? `, workerId ${claim.workerId}` : ''})`;

export function stopDecision(session, evt, now) {
	const open = openClaims(session);
	if (open.length === 0) {
		session.lastBlock = null;
		session.releasedKey = null;
		return { type: 'none' };
	}
	const key = open.map((claim) => claim.taskId).sort().join(',');
	// Already let go once with exactly these tasks open: don't start refusing again.
	if (session.releasedKey === key) return { type: 'none' };
	const retried = evt.stopHookActive || evt.loopCount > 0 || (session.lastBlock && now - session.lastBlock.at < 10 * 60_000);
	if (retried && session.lastBlock?.key === key && session.lastBlock.count >= 1) {
		// Reminded once and it stops again with the same tasks open: that is a decision (the
		// user may keep the task for themselves). Let it stop, say so, and don't ask again.
		session.lastBlock = null;
		session.releasedKey = key;
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
			'Before you stop, settle each one — and follow what the user asked, not this reminder:\n' +
			'- the user only wanted it claimed, or asked you to stop or pause: release it with updateTask { taskId, workerId, statusState: "pending" } (it goes back to the queue) — do not do the work;\n' +
			'- the work is done: completeTask { taskId, workerId, outcome: { summary: what you produced, verification: how you checked it, files } };\n' +
			'- you cannot finish it: updateTask { taskId, workerId, statusState: "blocked" } and tell the user why;\n' +
			'- the user wants to keep it claimed for themselves: just stop again — you will not be asked twice.',
	};
}
