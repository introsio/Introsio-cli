#!/usr/bin/env node
// Entry point every agent's hook config calls:  node introsio-hook.mjs <agent> [<event>]
// Reads the hook payload on stdin, answers on stdout in that agent's format, and
// ALWAYS exits 0 — a broken hook must never trap the agent. Internal errors go to
// ~/.introsio/errors.log (shown by `int doctor`), never to stdout.
import fs from 'node:fs';
import path from 'node:path';
import { normalize } from './normalize.mjs';
import { respond } from './respond.mjs';
import { handleEvent } from './engine.mjs';
import { introsioDir } from '../lib/paths.mjs';
import { killChildrenOnSignals } from '../lib/processTree.mjs';

const STDIN_IDLE_MS = 2000;
const STDIN_MAX_MS = 10_000;
const MAX_ERROR_LOG_BYTES = 1024 * 1024;

/**
 * Reads the payload. Resolves as soon as the bytes so far parse as one JSON
 * value, at EOF, or when input stops arriving — an agent that never closes
 * stdin must not hang its own hook.
 */
function readPayload(stream = process.stdin) {
	if (stream.isTTY) return Promise.resolve('');
	return new Promise((resolve) => {
		let text = '';
		let done = false;
		let idle = null;
		const finish = () => {
			if (done) return;
			done = true;
			clearTimeout(idle);
			clearTimeout(hard);
			stream.pause();
			stream.removeAllListeners('data');
			resolve(text);
		};
		const hard = setTimeout(finish, STDIN_MAX_MS);
		stream.setEncoding('utf8');
		stream.on('data', (chunk) => {
			text += chunk;
			clearTimeout(idle);
			try {
				JSON.parse(text);
				finish();
				return;
			} catch { /* not complete yet */ }
			idle = setTimeout(finish, STDIN_IDLE_MS);
		});
		stream.on('end', finish);
		stream.on('error', finish);
	});
}

function logError(agent, event, error) {
	try {
		const file = path.join(introsioDir(), 'errors.log');
		fs.mkdirSync(path.dirname(file), { recursive: true });
		try { if (fs.statSync(file).size > MAX_ERROR_LOG_BYTES) fs.renameSync(file, `${file}.1`); } catch { /* none yet */ }
		fs.appendFileSync(file, `${new Date().toISOString()} ${agent} ${event}: ${String(error?.stack ?? error).split('\n').slice(0, 6).join(' | ')}\n`);
	} catch { /* nowhere to report */ }
	if (process.env.INTROSIO_HOOK_DEBUG) process.stderr.write(`int hook: ${error?.stack ?? error}\n`);
}

async function main() {
	killChildrenOnSignals();
	const [agent, eventArg] = process.argv.slice(2);
	const text = await readPayload();
	let payload;
	try {
		payload = text.trim() ? JSON.parse(text) : {};
	} catch (error) {
		logError(agent, eventArg, new Error(`unreadable payload (${text.length} bytes): ${error.message}`));
		return;
	}
	let evt = null;
	try {
		evt = normalize(agent, eventArg, payload);
		if (!evt) return;
		const answer = await handleEvent(evt);
		const output = respond(agent, evt, answer);
		if (output !== null && output !== undefined) process.stdout.write(`${JSON.stringify(output)}\n`);
	} catch (error) {
		logError(agent, eventArg, error);
		// Still answer in the shape the agent requires.
		const output = respond(agent, evt ?? { event: null }, { type: 'none' });
		if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
	}
}

main().finally(() => {
	process.exitCode = 0;
	// Never linger: an open handle must not keep the agent waiting.
	setTimeout(() => process.exit(0), 50).unref();
});
