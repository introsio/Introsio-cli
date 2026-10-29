// A delimited block the kit owns inside a text config (TOML): add, replace or remove it without touching the rest.
export const BEGIN = '# >>> introsio (managed by `introsio setup` — edit with the introsio command) >>>';
export const END = '# <<< introsio <<<';

export function withBlock(text, body) {
	const without = withoutBlock(text ?? '');
	const block = `${BEGIN}\n${body.trim()}\n${END}\n`;
	return without.trim() ? `${without.trimEnd()}\n\n${block}` : block;
}

export function withoutBlock(text) {
	const start = text.indexOf(BEGIN);
	if (start < 0) return text;
	const end = text.indexOf(END, start);
	if (end < 0) return text;
	return `${text.slice(0, start).trimEnd()}\n${text.slice(end + END.length).replace(/^\n+/, '')}`.replace(/^\n+/, '');
}

export const hasBlock = (text) => (text ?? '').includes(BEGIN);
