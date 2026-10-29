// Runs every agent-kit test file in its own process (plain node:assert, like backend-node/src/tests).
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
let failed = 0;
for (const file of ['features.test.js', 'hook.test.js', 'git.test.js', 'install.test.js']) {
	console.log(file);
	const result = spawnSync(process.execPath, [path.join(dir, file)], { stdio: 'inherit' });
	if (result.status !== 0) failed += 1;
}
if (failed) {
	console.log(`\n${failed} test file(s) failed`);
	process.exitCode = 1;
}
