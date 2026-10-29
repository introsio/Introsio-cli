// Features `push-guard` and `secrets`: what a shell command may do with git.

/** Splits a shell line into commands (on && || ; | and newlines outside quotes), each as unquoted words. */
export function shellCommands(command) {
	const commands = [];
	let words = [];
	let word = '';
	let quote = null;
	let started = false;
	const endWord = () => {
		if (started) words.push(word);
		word = '';
		started = false;
	};
	const endCommand = () => {
		endWord();
		if (words.length) commands.push(words);
		words = [];
	};
	const text = String(command ?? '');
	for (let i = 0; i < text.length; i += 1) {
		const ch = text[i];
		if (quote) {
			if (ch === quote) quote = null;
			else if (ch === '\\' && quote === '"' && i + 1 < text.length) word += text[(i += 1)];
			else word += ch;
			continue;
		}
		if (ch === '"' || ch === "'") { quote = ch; started = true; continue; }
		if (ch === '\\' && i + 1 < text.length) { word += text[(i += 1)]; started = true; continue; }
		if (ch === ';' || ch === '\n' || ch === '|' || (ch === '&' && text[i + 1] === '&')) {
			if (ch === '&' || (ch === '|' && text[i + 1] === '|')) i += 1;
			endCommand();
			continue;
		}
		if (/\s/.test(ch)) { endWord(); continue; }
		word += ch;
		started = true;
	}
	endCommand();
	return commands;
}

/** Every `git … <sub>` invocation in a shell command line, as argv arrays after `git`. */
export function gitInvocations(command) {
	const out = [];
	for (const words of shellCommands(command)) {
		const gitAt = words.findIndex((token) => token === 'git' || token.endsWith('/git'));
		if (gitAt < 0) continue;
		const args = words.slice(gitAt + 1);
		// Skip global options (-C dir, -c k=v, --no-pager …) to find the subcommand.
		let i = 0;
		while (i < args.length && args[i].startsWith('-')) i += ['-C', '-c', '--git-dir', '--work-tree'].includes(args[i]) ? 2 : 1;
		if (i < args.length) out.push({ sub: args[i], args: args.slice(i + 1) });
	}
	return out;
}

/**
 * `push-guard`: local mode pushes nothing; otherwise no force push, no mirror,
 * and nothing lands on (or deletes) the default branch.
 */
export function pushDecision({ command, mode, git, defaultBranch }) {
	const pushes = gitInvocations(command).filter((call) => call.sub === 'push');
	if (pushes.length === 0 || mode === 'off') return { type: 'none' };
	if (mode === 'local') {
		return { type: 'deny', message: 'Introsio (local mode): this repository stays on this computer — git push is blocked. Commit locally; switch with `introsio mode github` if it should go to GitHub.' };
	}
	const current = git.branch();
	const main = defaultBranch ?? git.defaultBranch();
	for (const { args } of pushes) {
		if (args.some((arg) => arg === '--force' || arg === '-f' || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(arg) && !arg.startsWith('--'))) {
			return { type: 'deny', message: 'Introsio: force push is blocked. Use --force-with-lease on your own branch if you really must rewrite it.' };
		}
		if (args.includes('--mirror')) return { type: 'deny', message: 'Introsio: git push --mirror is blocked.' };
		const positional = args.filter((arg) => !arg.startsWith('-'));
		const deleting = args.includes('--delete') || args.includes('-d');
		const refspecs = positional.slice(1);
		if (args.includes('--all') || args.includes('--tags')) continue;
		const targets = refspecs.length === 0 ? [current] : refspecs.map((spec) => {
			const cleaned = spec.replace(/^\+/, '');
			const dest = cleaned.includes(':') ? cleaned.split(':').pop() : cleaned;
			return dest === 'HEAD' || dest === '' ? current : dest;
		});
		if (refspecs.some((spec) => spec.startsWith('+'))) {
			return { type: 'deny', message: 'Introsio: force push (a "+" refspec) is blocked.' };
		}
		const hitsMain = main && targets.some((target) => String(target ?? '').replace(/^refs\/heads\//, '') === main);
		if (hitsMain) {
			return {
				type: 'deny',
				message: deleting
					? `Introsio: deleting the default branch "${main}" is blocked.`
					: `Introsio: pushing to the default branch "${main}" is blocked. Push your own branch (git switch -c <name>; git push -u origin <name>) and open a pull request.`,
			};
		}
	}
	return { type: 'none' };
}

const SECRET_PATTERNS = [
	['private key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/],
	['AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
	['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/],
	['Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{32,}/],
	['OpenAI API key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{40,}/],
	['Stripe live key', /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/],
	['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
	['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
];

const SECRET_FILE = /(^|\/)(\.env(\.[\w-]+)?|id_rsa|id_ed25519|[^/]+\.pem|[^/]+\.p12|credentials\.json)$/;
const SAFE_ENV_FILE = /\.env\.(example|sample|template|defaults?)$/;

/** Secrets in the added lines of a unified diff. Never returns the value — file, line and kind only. */
export function scanDiff(diff) {
	const findings = [];
	let file = null;
	let line = 0;
	for (const raw of String(diff ?? '').split('\n')) {
		if (raw.startsWith('+++ ')) {
			file = raw.slice(4).replace(/^b\//, '');
			if (file !== '/dev/null' && SECRET_FILE.test(file) && !SAFE_ENV_FILE.test(file)) findings.push({ file, line: null, kind: 'secret file' });
			continue;
		}
		const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
		if (hunk) { line = Number(hunk[1]); continue; }
		if (raw.startsWith('+')) {
			for (const [kind, pattern] of SECRET_PATTERNS) {
				if (pattern.test(raw)) { findings.push({ file, line, kind }); break; }
			}
			line += 1;
		} else if (!raw.startsWith('-')) {
			line += 1;
		}
	}
	return findings;
}

export function scanText(file, text) {
	const findings = [];
	if (SECRET_FILE.test(file) && !SAFE_ENV_FILE.test(file)) findings.push({ file, line: null, kind: 'secret file' });
	String(text ?? '').split('\n').forEach((content, index) => {
		for (const [kind, pattern] of SECRET_PATTERNS) {
			if (pattern.test(content)) { findings.push({ file, line: index + 1, kind }); break; }
		}
	});
	return findings;
}

/** `secrets`: scan what a commit / push would publish. `readFile` reads untracked files when the command also stages. */
export function secretsDecision({ command, git, readFile }) {
	const calls = gitInvocations(command);
	const commit = calls.find((call) => call.sub === 'commit');
	const push = calls.find((call) => call.sub === 'push');
	if (!commit && !push) return { type: 'none' };
	const stagesFirst = calls.some((call) => call.sub === 'add') || (commit && commit.args.some((arg) => /^-[a-zA-Z]*a/.test(arg) || arg === '--all'));
	let findings = [];
	if (commit) {
		findings = findings.concat(scanDiff(git.diff(stagesFirst ? ['HEAD'] : ['--cached'])));
		if (calls.some((call) => call.sub === 'add')) {
			const untracked = git.run(['ls-files', '--others', '--exclude-standard']).out.split('\n').filter(Boolean).slice(0, 200);
			for (const file of untracked) findings = findings.concat(scanText(file, readFile(file)));
		}
	}
	if (push) {
		const range = git.upstream() ? ['@{u}..HEAD'] : (() => {
			const main = git.defaultBranch();
			return main && main !== git.branch() ? [`${main}...HEAD`] : null;
		})();
		if (range) findings = findings.concat(scanDiff(git.diff(range)));
	}
	if (findings.length === 0) return { type: 'none' };
	const unique = [...new Map(findings.map((item) => [`${item.file}:${item.line}:${item.kind}`, item])).values()];
	const list = unique.slice(0, 8).map((item) => `  ${item.file}${item.line ? `:${item.line}` : ''} — ${item.kind}`).join('\n');
	return {
		type: 'deny',
		message: `Introsio: this ${commit ? 'commit' : 'push'} would publish what looks like a secret:\n${list}\nMove it to an environment variable or an ignored file, remove it from the change (and from earlier commits if it is already in one), then retry. If it is a false positive: introsio disable secrets.`,
	};
}
