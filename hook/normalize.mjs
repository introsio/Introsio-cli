// Turns each agent's hook payload into one shape the engine understands:
//   { agent, event, sessionId, cwd, source, stopHookActive, loopCount, transcriptPath, tool, result }
// event: session-start | before-tool | after-tool | stop | compact
// tool:  { kind: introsio | shell | edit | other, raw, name, args, command, files }

/** Every Introsio MCP tool whose name alone identifies it, even under another server name. */
export const DISTINCTIVE_TOOLS = new Set([
	'claimTask', 'completeTask', 'undoTaskCompletion', 'updateSubtask', 'getReadySubtasks', 'getReadyTasks',
	'getExecutionWaves', 'getProjectPlan', 'createProjectPlan', 'getProjectState', 'updateProjectState',
	'getProjectContext', 'updateProjectContext', 'editProjectContextItems', 'recordProjectDecision',
	'exportProjectBlueprint', 'importProjectBlueprint', 'getTaskDependencies', 'addTaskDependency', 'removeTaskDependency',
]);

const EVENT_MAP = {
	// SubagentStop is deliberately absent: a subagent must not be held to its parent's claims.
	claude: { SessionStart: 'session-start', PreToolUse: 'before-tool', PostToolUse: 'after-tool', Stop: 'stop', PreCompact: 'compact' },
	codex: { SessionStart: 'session-start', PreToolUse: 'before-tool', PostToolUse: 'after-tool', Stop: 'stop', PreCompact: 'compact', PostCompact: 'session-start' },
	gemini: { SessionStart: 'session-start', BeforeTool: 'before-tool', AfterTool: 'after-tool', AfterAgent: 'stop', PreCompress: 'compact' },
	cursor: {
		beforeMCPExecution: 'before-tool', afterMCPExecution: 'after-tool', beforeShellExecution: 'before-tool',
		afterShellExecution: 'after-tool', afterFileEdit: 'after-tool', stop: 'stop',
	},
	opencode: { 'tool.execute.before': 'before-tool', 'tool.execute.after': 'after-tool', 'session.idle': 'stop', 'session.compacted': 'session-start', 'session.created': 'session-start' },
};

export const AGENTS_WITH_HOOKS = Object.keys(EVENT_MAP);

const SHELL_TOOLS = /^(bash|shell|exec_command|local_shell|run_shell_command|run_terminal_cmd|terminal)$/i;
const EDIT_TOOLS = /^(edit|write|multiedit|notebookedit|apply_patch|write_file|replace|patch|str_replace_editor|create_file|edit_file)$/i;

/** The bare tool name of an MCP tool: mcp__introsio__claimTask, mcp_introsio_claimTask, introsio_claimTask → claimTask. */
export function bareToolName(raw) {
	return String(raw ?? '').split(/__|[_.:/]/).filter(Boolean).pop() ?? '';
}

export function isIntrosioTool(raw, agent) {
	const name = bareToolName(raw);
	if (!name) return false;
	if (/introsio/i.test(String(raw)) && String(raw) !== name) return true;
	if (DISTINCTIVE_TOOLS.has(name)) return true;
	// Cursor passes the bare name; updateTask / getTasks etc. are only counted when the server is Introsio.
	return agent === 'cursor' && /introsio/i.test(String(raw));
}

function parseMaybeJson(value) {
	if (typeof value !== 'string') return value;
	const text = value.trim();
	if (!text || !'{['.includes(text[0])) return value;
	try {
		return JSON.parse(text);
	} catch {
		return value;
	}
}

/**
 * The data an Introsio tool answered with. Agents hand the MCP result over in
 * different wrappers (content blocks, { content }, a JSON string, the parsed
 * object); the server always sends one text block of JSON.
 */
export function parseToolResult(response) {
	let value = parseMaybeJson(response);
	let isError = false;
	for (let depth = 0; depth < 4 && value && typeof value === 'object'; depth += 1) {
		if (value.isError === true) isError = true;
		const blocks = Array.isArray(value) ? value : Array.isArray(value.content) ? value.content : null;
		if (blocks) {
			// MCP content blocks ({ type: 'text', text }) or Gemini parts ({ text }).
			const text = blocks.filter((block) => block && (block.type === 'text' || block.type === undefined) && typeof block.text === 'string').map((block) => block.text).join('');
			value = parseMaybeJson(text);
			continue;
		}
		if (value.llmContent !== undefined && !('success' in value)) {
			// Gemini CLI: { llmContent, returnDisplay, error }.
			if (value.error) isError = true;
			value = parseMaybeJson(value.llmContent);
			continue;
		}
		if (typeof value.result === 'string' || (value.result && typeof value.result === 'object' && !('success' in value))) {
			value = parseMaybeJson(value.result);
			continue;
		}
		if (typeof value.output === 'string' && !('success' in value) && !('claimed' in value)) {
			value = parseMaybeJson(value.output);
			continue;
		}
		break;
	}
	const data = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
	const ok = !isError && !!data && data.success !== false && !(typeof data.error === 'string' && data.success !== true && !('claimed' in data));
	return { ok, data, isError };
}

/** Files named by an apply_patch body ("*** Update File: path"). */
export function patchFiles(patch) {
	const files = [];
	for (const match of String(patch ?? '').matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) files.push(match[1].trim());
	for (const match of String(patch ?? '').matchAll(/^\*\*\* Move to: (.+)$/gm)) files.push(match[1].trim());
	return files;
}

function shellCommandOf(input) {
	const command = input?.command ?? input?.cmd ?? input?.script;
	if (Array.isArray(command)) {
		// ["bash", "-lc", "git push"] → the script; otherwise the joined argv.
		const flagIndex = command.findIndex((part) => part === '-c' || part === '-lc');
		return flagIndex >= 0 ? String(command[flagIndex + 1] ?? '') : command.join(' ');
	}
	return typeof command === 'string' ? command : '';
}

function editFilesOf(input) {
	if (!input || typeof input !== 'object') return [];
	const direct = input.file_path ?? input.filePath ?? input.path ?? input.notebook_path ?? input.absolute_path;
	if (typeof direct === 'string') return [direct];
	const patch = input.patch ?? input.input ?? (typeof input.command === 'string' ? input.command : null);
	if (typeof patch === 'string') return patchFiles(patch);
	if (Array.isArray(input.edits)) return input.edits.map((edit) => edit?.file_path ?? edit?.filePath).filter(Boolean);
	return [];
}

export function classifyTool(raw, input, agent) {
	const args = parseMaybeJson(input);
	const objectArgs = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
	if (isIntrosioTool(raw, agent)) return { kind: 'introsio', raw, name: bareToolName(raw), args: objectArgs };
	if (SHELL_TOOLS.test(String(raw))) return { kind: 'shell', raw, command: shellCommandOf(objectArgs) || (typeof args === 'string' ? args : '') };
	if (EDIT_TOOLS.test(String(raw))) return { kind: 'edit', raw, files: editFilesOf(typeof args === 'string' ? { patch: args } : objectArgs) };
	return { kind: 'other', raw };
}

/** One agent payload → the engine's event, or null for an event this kit ignores. */
export function normalize(agent, hookEvent, payload) {
	const map = EVENT_MAP[agent];
	const eventName = hookEvent || payload?.hook_event_name || payload?.hookEventName;
	const event = map?.[eventName];
	if (!event) return null;
	const p = payload ?? {};
	const base = {
		agent,
		hookEvent: eventName,
		event,
		// Without an id, the agent process is the session — never one shared "unknown" for everybody.
		sessionId: String(p.session_id ?? p.sessionId ?? p.conversation_id ?? p.sessionID ?? `${agent}-pid-${process.ppid}`),
		cwd: p.cwd ?? (Array.isArray(p.workspace_roots) ? p.workspace_roots[0] : null) ?? process.cwd(),
		transcriptPath: p.transcript_path ?? p.transcriptPath ?? null,
		source: eventName === 'PostCompact' || eventName === 'session.compacted' ? 'compact' : (p.source ?? p.trigger ?? null),
		stopHookActive: p.stop_hook_active === true || p.stopHookActive === true,
		loopCount: Number(p.loop_count ?? 0) || 0,
	};
	if (event !== 'before-tool' && event !== 'after-tool') return base;

	if (agent === 'cursor') {
		if (eventName === 'beforeShellExecution' || eventName === 'afterShellExecution') {
			return { ...base, tool: { kind: 'shell', raw: 'shell', command: String(p.command ?? '') }, result: null };
		}
		if (eventName === 'afterFileEdit') return { ...base, tool: { kind: 'edit', raw: 'edit', files: p.file_path ? [p.file_path] : [] }, result: null };
		const raw = p.tool_name ?? '';
		const serverHint = /introsio/i.test(String(p.url ?? p.command ?? '')) ? `introsio_${raw}` : raw;
		const tool = classifyTool(serverHint, p.tool_input, agent);
		return { ...base, tool, result: event === 'after-tool' ? parseToolResult(p.result_json ?? p.tool_output ?? p.result) : null };
	}

	const name = String(p.tool_name ?? p.toolName ?? p.tool ?? '');
	// Gemini names MCP tools by bare name unless they clash; its payload says which server a tool belongs to.
	const server = p.mcp_server ?? p.mcp_context?.server_name ?? p.mcp_context?.serverName ?? p.server_name ?? null;
	const raw = server && !name.toLowerCase().includes(String(server).toLowerCase()) ? `${server}__${name}` : name;
	const tool = classifyTool(raw, p.tool_input ?? p.toolInput ?? p.args ?? p.arguments, agent);
	const response = p.tool_response ?? p.tool_output ?? p.toolResponse ?? p.output ?? p.result;
	const durationMs = Number(p.duration_ms);
	return { ...base, tool, result: event === 'after-tool' ? parseToolResult(response) : null, ...(Number.isFinite(durationMs) ? { durationMs } : {}) };
}
