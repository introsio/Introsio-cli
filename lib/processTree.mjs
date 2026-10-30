// Running a command so that a timeout really stops it — the command and everything
// it started (test runners fork workers) — and keeping only the tail of its output.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'ksh', 'cmd.exe', 'powershell.exe', 'pwsh', 'pwsh.exe']);

export function killTree(pid) {
	if (!pid) return;
	if (process.platform === 'win32') {
		spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
		return;
	}
	try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
}

/** Keeps the last `maxLines` lines, each cut to `maxLineChars`, at most `maxChars` in all. */
export function tailText(text, { maxLines = 40, maxLineChars = 300, maxChars = 3000 } = {}) {
	const lines = String(text ?? '').replace(/\r/g, '').trimEnd().split('\n').slice(-maxLines)
		.map((line) => (line.length > maxLineChars ? `${line.slice(0, maxLineChars)}…` : line));
	let out = lines.join('\n');
	if (out.length > maxChars) out = `…${out.slice(-maxChars)}`;
	return out;
}

// Groups started by this process, killed if the process ends first.
const running = new Set();
const killAll = () => { for (const pid of running) killTree(pid); running.clear(); };
let exitHookInstalled = false;

/**
 * For the hook process only (never inside an agent like OpenCode, whose signals
 * are its own): if the agent kills the hook — its timeout, or the person
 * cancelling — the gate's processes go with it instead of running on unattended.
 */
export function killChildrenOnSignals() {
	for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
		process.once(signal, () => {
			killAll();
			process.exit(0);
		});
	}
}

/** Runs `command` in a shell, in its own process group; on timeout the whole group is killed. */
export function runCommand(command, { cwd, timeoutSec, env = process.env, keepBytes = 64 * 1024 }) {
	return new Promise((resolve) => {
		const started = Date.now();
		let output = '';
		let timedOut = false;
		const keep = (chunk) => {
			output += chunk.toString('utf8');
			if (output.length > keepBytes * 2) output = output.slice(-keepBytes);
		};
		let child;
		try {
			child = spawn(command, { cwd, shell: true, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
		} catch (error) {
			resolve({ ok: false, code: null, timedOut: false, output: String(error.message), ms: 0 });
			return;
		}
		if (!exitHookInstalled) {
			exitHookInstalled = true;
			process.on('exit', killAll);
		}
		running.add(child.pid);
		child.stdout.on('data', keep);
		child.stderr.on('data', keep);
		const timer = setTimeout(() => {
			timedOut = true;
			killTree(child.pid);
		}, timeoutSec * 1000);
		let finished = false;
		const finish = (code) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			running.delete(child.pid);
			// Stray background processes the command left behind go too.
			if (process.platform !== 'win32') { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* none left */ } }
			resolve({ ok: code === 0 && !timedOut, code, timedOut, output: tailText(output), ms: Date.now() - started });
		};
		child.on('error', (error) => { keep(String(error.message)); finish(null); });
		// 'exit' rather than 'close': a forked worker holding the pipe must not keep us waiting.
		child.on('exit', (code) => finish(code));
	});
}

/**
 * The agent process behind a hook. Agents start hooks through a shell, so the
 * hook's parent is usually a short-lived `sh -c`; its parent is the agent.
 */
export function agentPid(ppid = process.ppid) {
	try {
		const parent = parentOf(ppid);
		if (parent && SHELLS.has(parent.comm)) return parentOf(parent.ppid)?.pid ?? ppid;
		return ppid;
	} catch {
		return ppid;
	}
}

function parentOf(pid) {
	if (!pid || pid <= 1) return null;
	if (process.platform === 'linux') {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
		const close = stat.lastIndexOf(')');
		const comm = stat.slice(stat.indexOf('(') + 1, close);
		const ppid = Number(stat.slice(close + 2).split(' ')[1]);
		return { pid, comm, ppid };
	}
	if (process.platform === 'win32') return null;
	const result = spawnSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 });
	const match = result.stdout.trim().match(/^(\d+)\s+(.+)$/);
	if (!match) return null;
	return { pid, ppid: Number(match[1]), comm: match[2].split('/').pop().replace(/^-/, '') };
}

export function isAlive(pid) {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code === 'EPERM';
	}
}
