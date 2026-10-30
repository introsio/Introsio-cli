// Feature `log`: one line per Introsio call in ~/.introsio/log.jsonl, summed up by `int stats`.
import fs from 'node:fs';
import { logPath } from '../../lib/paths.mjs';
import { appendLine } from '../../lib/jsonFile.mjs';

const MAX_LOG_BYTES = 20 * 1024 * 1024;

export function logRow(session, evt, { name, args = {}, result }, now) {
	const started = session.pending?.[name];
	if (started) delete session.pending[name];
	const data = result?.data ?? {};
	const error = result?.ok ? null : String(data.error ?? data.message ?? (result?.isError ? 'error' : 'refused')).slice(0, 200);
	return {
		at: new Date(now).toISOString(),
		agent: evt.agent,
		session: session.sessionId,
		tool: name,
		ok: !!result?.ok,
		...(error ? { error } : {}),
		...(data.code ? { code: data.code } : {}),
		...(args.taskId || data.task?.id ? { taskId: String(args.taskId ?? data.task.id) } : {}),
		...(args.projectId || data.project?.id ? { projectId: String(args.projectId ?? data.project.id) } : {}),
		...(Number.isFinite(evt.durationMs) ? { ms: evt.durationMs } : started ? { ms: now - started } : {}),
	};
}

export function writeLog(row, env) {
	const file = logPath(env);
	try {
		if (fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.1`);
	} catch { /* no log yet */ }
	appendLine(file, JSON.stringify(row));
}

/** Pure summary of log rows, for `int stats`. */
export function summarize(rows) {
	const byTool = new Map();
	const byTask = new Map();
	const errors = new Map();
	const streaks = new Map();
	const loops = [];
	for (const row of rows) {
		const tool = byTool.get(row.tool) ?? { tool: row.tool, calls: 0, refused: 0, totalMs: 0, timed: 0 };
		tool.calls += 1;
		if (!row.ok) tool.refused += 1;
		if (Number.isFinite(row.ms)) { tool.totalMs += row.ms; tool.timed += 1; }
		byTool.set(row.tool, tool);
		if (!row.ok && row.error) errors.set(row.error, (errors.get(row.error) ?? 0) + 1);
		if (row.taskId) {
			const task = byTask.get(row.taskId) ?? { taskId: row.taskId, calls: 0, refused: 0, first: row.at, last: row.at, completed: false };
			task.calls += 1;
			if (!row.ok) task.refused += 1;
			task.last = row.at;
			if (row.ok && row.tool === 'completeTask') task.completed = true;
			byTask.set(row.taskId, task);
			const key = `${row.session}|${row.tool}|${row.taskId}`;
			const streak = row.ok ? 0 : (streaks.get(key) ?? 0) + 1;
			streaks.set(key, streak);
			if (streak === 3) loops.push({ tool: row.tool, taskId: row.taskId, session: row.session, error: row.error });
		}
	}
	return {
		calls: rows.length,
		refused: rows.filter((row) => !row.ok).length,
		tools: [...byTool.values()].map((tool) => ({ tool: tool.tool, calls: tool.calls, refused: tool.refused, avgMs: tool.timed ? Math.round(tool.totalMs / tool.timed) : null })).sort((a, b) => b.calls - a.calls),
		topErrors: [...errors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([error, count]) => ({ error, count })),
		tasks: [...byTask.values()].map((task) => ({ ...task, minutes: Math.round((Date.parse(task.last) - Date.parse(task.first)) / 60000) })).sort((a, b) => b.refused - a.refused || b.calls - a.calls),
		retryLoops: loops,
	};
}
