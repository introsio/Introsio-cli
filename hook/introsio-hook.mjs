#!/usr/bin/env node
// Entry point every agent's hook config calls:  node introsio-hook.mjs <agent> [<event>]
// Reads the hook payload on stdin, answers on stdout in that agent's format, and
// ALWAYS exits 0 — a broken hook must never trap the agent.
import { normalize } from './normalize.mjs';
import { respond } from './respond.mjs';
import { handleEvent } from './engine.mjs';

async function readStdin() {
	if (process.stdin.isTTY) return '';
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	return Buffer.concat(chunks).toString('utf8');
}

async function main() {
	const [agent, eventArg] = process.argv.slice(2);
	let payload = {};
	try {
		const text = await readStdin();
		payload = text.trim() ? JSON.parse(text) : {};
	} catch {
		return;
	}
	const evt = normalize(agent, eventArg, payload);
	if (!evt) return;
	const answer = handleEvent(evt);
	const output = respond(agent, evt, answer);
	if (output !== null && output !== undefined) process.stdout.write(`${JSON.stringify(output)}\n`);
}

main().catch((error) => {
	if (process.env.INTROSIO_HOOK_DEBUG) process.stderr.write(`introsio hook: ${error?.stack ?? error}\n`);
}).finally(() => {
	process.exitCode = 0;
});
