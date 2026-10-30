// Introsio plugin for OpenCode — installed by `introsio setup`. Runs the same engine as the
// Claude Code / Codex / Gemini / Cursor hooks: tracks claimed tasks, guards completion and git,
// and on session.idle sends the agent back if a claimed task is still open in Introsio.
import { handleEvent } from '__ENGINE__';
// OpenCode runs this plugin inside its own process: every hook here is awaited, and
// nothing here may throw except a deliberate refusal in tool.execute.before.
import { classifyTool, parseToolResult } from '__NORMALIZE__';

const argsByCall = new Map();

export const IntrosioPlugin = async ({ client, directory, worktree }) => {
	const cwd = worktree || directory || process.cwd();
	const base = (sessionID, hookEvent, event) => ({
		agent: 'opencode', hookEvent, event, sessionId: String(sessionID ?? 'unknown'), cwd,
		transcriptPath: null, source: null, stopHookActive: false, loopCount: 0,
	});
	const safe = async (fn) => {
		try {
			return (await fn()) ?? { type: 'none' };
		} catch {
			return { type: 'none' };
		}
	};

	return {
		'tool.execute.before': async (input, output) => {
			argsByCall.set(input.callID, output?.args ?? {});
			const tool = classifyTool(input.tool, output?.args ?? {}, 'opencode');
			const answer = await safe(() => handleEvent({ ...base(input.sessionID, 'tool.execute.before', 'before-tool'), tool, result: null }));
			if (answer.type === 'deny') throw new Error(answer.message);
		},
		'tool.execute.after': async (input, output) => {
			const args = argsByCall.get(input.callID) ?? {};
			argsByCall.delete(input.callID);
			const tool = classifyTool(input.tool, args, 'opencode');
			const result = parseToolResult(output?.output ?? output?.metadata);
			const answer = await safe(() => handleEvent({ ...base(input.sessionID, 'tool.execute.after', 'after-tool'), tool, result }));
			if (answer.type === 'context' && output && typeof output.output === 'string') output.output += `\n\n${answer.message}`;
		},
		event: async ({ event }) => {
			const sessionID = event?.properties?.sessionID ?? event?.properties?.info?.id;
			if (!sessionID) return;
			if (event.type === 'session.compacted') {
				await safe(() => handleEvent({ ...base(sessionID, 'session.compacted', 'compact') }));
				return;
			}
			if (event.type !== 'session.idle') return;
			const answer = await safe(() => handleEvent({ ...base(sessionID, 'session.idle', 'stop') }));
			if (answer.type !== 'block') return;
			client.session
				.prompt({ path: { id: sessionID }, body: { parts: [{ type: 'text', text: answer.message }] } })
				.catch(() => {});
		},
	};
};
