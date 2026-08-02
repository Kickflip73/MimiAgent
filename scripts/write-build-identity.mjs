import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageManifest = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const packageVersion = typeof packageManifest.version === 'string'
  ? packageManifest.version
  : 'unknown';

function gitOutput(args) {
  return execFileSync('git', ['-C', projectRoot, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

let commitSha = 'unknown';
let dirty = true;
try {
  const candidate = gitOutput(['rev-parse', '--verify', 'HEAD']).toLowerCase();
  if (/^[0-9a-f]{40}$/.test(candidate)) {
    commitSha = candidate;
    dirty = gitOutput(['status', '--porcelain=v1', '--untracked-files=normal']).length > 0;
  }
} catch {
  // Source archives without Git metadata remain usable, but fail closed as dirty.
}

const output = path.join(projectRoot, 'dist', 'build-identity.json');
mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify({
  schemaVersion: 1,
  packageVersion,
  commitSha,
  dirty,
}, null, 2)}\n`);
