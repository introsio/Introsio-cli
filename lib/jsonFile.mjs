// Small, careful file helpers: atomic writes, tolerant reads, JSON with comments stripped.
import fs from 'node:fs';
import path from 'node:path';

export function readText(file) {
	try {
		return fs.readFileSync(file, 'utf8');
	} catch {
		return null;
	}
}

/** Strips // and /* *\/ comments and trailing commas outside strings (VS Code / OpenCode configs allow them). */
export function stripJsonComments(text) {
	let out = '';
	let inString = false;
	for (let i = 0; i < text.length; i += 1) {
		const ch = text[i];
		const next = text[i + 1];
		if (inString) {
			out += ch;
			if (ch === '\\') { out += next ?? ''; i += 1; } else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') { inString = true; out += ch; continue; }
		if (ch === '/' && next === '/') { while (i < text.length && text[i] !== '\n') i += 1; out += '\n'; continue; }
		if (ch === '/' && next === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1; i += 1; continue; }
		out += ch;
	}
	return out.replace(/,(\s*[}\]])/g, '$1');
}

/**
 * Reads a JSON file. Missing or empty → `fallback`. Unparseable → throws, so an
 * installer never overwrites a file it could not understand.
 */
export function readJson(file, fallback = {}) {
	const text = readText(file);
	if (text === null || !text.trim()) return structuredClone(fallback);
	try {
		return JSON.parse(text);
	} catch {
		try {
			return JSON.parse(stripJsonComments(text));
		} catch {
			const error = new Error(`${file} is not valid JSON — fix or move it, then run again. Nothing was changed.`);
			error.code = 'BAD_JSON';
			throw error;
		}
	}
}

/** Same as readJson but never throws (hook-side state: a broken file just reads as empty). */
export function readJsonSafe(file, fallback = {}) {
	try {
		return readJson(file, fallback);
	} catch {
		return structuredClone(fallback);
	}
}

export function writeAtomic(file, text) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(tmp, text);
	fs.renameSync(tmp, file);
}

export function writeJson(file, value) {
	writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function appendLine(file, line) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.appendFileSync(file, `${line}\n`);
}
