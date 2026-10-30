// The engine's answer in each agent's own hook output format. `null` = print nothing.

/** Nothing a hook says may flood the agent's context. */
export const MAX_MESSAGE_CHARS = 6000;

export function capMessage(message) {
	const text = String(message ?? '');
	return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS - 40)}\n…(cut — ${text.length} chars in all)` : text;
}
//   { type: 'none' | 'deny' | 'context' | 'block' | 'warn', message }

export function respond(agent, evt, answer) {
	if (!answer || answer.type === 'none' || !answer.message) {
		// Codex expects JSON on stdout whenever a hook exits 0; Cursor's before-hooks too.
		if (agent === 'codex') return {};
		return agent === 'cursor' && evt?.event === 'before-tool' ? {} : null;
	}
	const { type } = answer;
	const message = capMessage(answer.message);
	switch (agent) {
		case 'claude':
		case 'codex':
			if (type === 'deny') {
				return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: message } };
			}
			if (type === 'block') return { decision: 'block', reason: message };
			if (type === 'warn') return agent === 'claude' ? { systemMessage: message } : {};
			if (type === 'context') {
				const hookEventName = evt.hookEvent === 'PostCompact' ? 'SessionStart' : evt.hookEvent;
				return { hookSpecificOutput: { hookEventName, additionalContext: message } };
			}
			return null;
		case 'gemini':
			if (type === 'deny' || type === 'block') return { decision: 'deny', reason: message };
			if (type === 'warn') return { systemMessage: message };
			if (type === 'context') return { hookSpecificOutput: { hookEventName: evt.hookEvent, additionalContext: message } };
			return null;
		case 'cursor':
			if (type === 'deny') return { permission: 'deny', user_message: message, agent_message: message };
			if (type === 'block') return { followup_message: message };
			// Cursor's after-hooks cannot add to the agent's context; the note is kept in the log only.
			return evt?.event === 'before-tool' ? {} : null;
		default:
			return answer;
	}
}
