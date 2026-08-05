import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const forbiddenPaths = [
  /^data(?:\/|$)/,
  /^\.playwright-cli(?:\/|$)/,
  /(?:^|\/)\.hallmark(?:\/|$)/,
  /(?:^|\/)\.env$/,
  /(?:^|\/)mcp\.json$/,
  /(?:^|\/)[^/]+\.db(?:-wal|-shm)?$/,
  /(?:^|\/)[^/]+\.(?:key|p12|pfx|pem)$/i,
  /(?:^|\/)(?:id_ed25519|id_rsa)$/,
  /(?:^|\/)(?:screenshots|recordings|computer-artifacts)(?:\/|$)/,
  /(?:^|\/)(?:sessions|traces)(?:\/|$)/,
  /(?:^|\/)[^/]+\.local-identity$/,
];

const secretPatterns = [
  { name: 'private key', pattern: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/ },
  { name: 'OpenAI-style API key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'GitHub token', pattern: /\bgh[opusr]_[A-Za-z0-9]{20,}\b/ },
  { name: 'GitLab token', pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'npm token', pattern: /\bnpm_[A-Za-z0-9]{30,}\b/ },
  { name: 'Hugging Face token', pattern: /\bhf_[A-Za-z0-9]{30,}\b/ },
  { name: 'Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'AWS access key', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { name: 'Google API key', pattern: /\bAIza[A-Za-z0-9_-]{35}\b/ },
  { name: 'Stripe live secret', pattern: /\b(?:r|s)k_live_[A-Za-z0-9]{20,}\b/ },
  {
    name: 'credential in URL',
    pattern: /\bhttps?:\/\/[^\s/:@]+:[^\s/@]+@(?!example\.(?:com|net|org|test)(?:[/:]|$))/i,
  },
  {
    name: 'non-fixture macOS home path',
    pattern: /\/Users\/(?!(?:example|mimi-fixture|owner|test)(?:\/|\b))[^/'"\s]+/,
  },
];

const privateOrganizationPatterns = [
  ['san', 'kuai'],
  ['mei', 'tuan'],
  ['dian', 'ping'],
  ['da', 'xiang'],
].map((parts) => ({
  name: 'private organization marker',
  pattern: new RegExp(`\\b${parts.join('')}\\b`, 'i'),
}));

const tracked = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { encoding: 'utf8' },
)
  .split('\0')
  .filter(Boolean);
const violations = [];

for (const file of tracked) {
  if (!existsSync(file)) continue;
  if (forbiddenPaths.some((pattern) => pattern.test(file))) {
    violations.push(`${file}: forbidden runtime or private artifact`);
    continue;
  }
  const absolute = path.resolve(file);
  let content;
  try {
    const buffer = readFileSync(absolute);
    if (buffer.includes(0) || buffer.length > 2_000_000) continue;
    content = buffer.toString('utf8');
  } catch {
    continue;
  }
  for (const candidate of [...secretPatterns, ...privateOrganizationPatterns]) {
    if (candidate.pattern.test(content)) {
      violations.push(`${file}: possible ${candidate.name}`);
    }
  }
}

if (violations.length > 0) {
  console.error('Repository hygiene check failed:');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(`Repository hygiene check passed (${tracked.length} tracked files).`);
