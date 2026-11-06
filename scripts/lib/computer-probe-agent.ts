import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { BACKGROUND_DEFAULTS_VERSION } from '../../src/daemon/background-defaults.js';

const exec = promisify(execFile);
const repository = fileURLToPath(new URL('../../', import.meta.url));
const entry = path.join(repository, 'dist/index.js');

// Real CLI → daemon → configured model → Computer tools. No scripted action substitutes.
export async function runProbeAgent(root: string, driver: string, prompt: string, timeoutMs = 180_000) {
  const session = `click-probe-${process.pid}`;
  const env = { ...process.env, MIMI_DATA_DIR: path.join(root, 'agent'),
    MIMI_DAEMON_DATA_DIR: path.join(root, 'daemon'), MIMI_WORKSPACE: root,
    MIMI_DAEMON_SUPERVISOR: 'foreground', MIMI_COMPUTER_BACKEND: 'cua',
    MIMI_CUA_DRIVER_COMMAND: driver, MIMI_COMPUTER_DEFAULT_ACCESS: process.env.MIMI_PROBE_ACCESS ?? 'background', MIMI_SESSION: session,
    MIMI_CONNECTORS_CONFIG: path.join(root, 'daemon/connectors.json'),
    MIMI_ASSISTANT_CONFIG: path.join(root, 'daemon/assistant.json') };
  // Disable unrelated inbound events before startup, not after they can run.
  await mkdir(path.join(root, 'daemon'), { recursive: true });
  const template = JSON.parse(await readFile(path.join(repository, 'mimi.connectors.example.json'), 'utf8')) as {
    connectors: Record<string, Record<string, unknown>>;
  };
  await writeFile(env.MIMI_CONNECTORS_CONFIG, JSON.stringify({ backgroundDefaultsVersion: BACKGROUND_DEFAULTS_VERSION,
    connectors: Object.fromEntries(Object.entries(template.connectors).map(([id, connector]) => [id, { ...connector, enabled: false }])) }));
  // Daemon conversation access comes from source policy, independently of the
  // runtime default. This policy belongs only to this isolated test directory.
  await writeFile(env.MIMI_ASSISTANT_CONFIG, JSON.stringify({ version: 1,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    quietHours: { enabled: false }, budgets: {}, thresholds: {}, briefings: { enabled: false },
    decisionPolicy: { sourcePolicies: [{ id: 'computer-probe', source: 'local-cli',
      computerAccess: env.MIMI_COMPUTER_DEFAULT_ACCESS,
      ...(process.env.MIMI_PROBE_APPS ? { computerApps: process.env.MIMI_PROBE_APPS.split(',') } : {}),
      instructions: ['仅执行本次用户请求的电脑回归测试。'] }] } }));
  const command = (args: string[], timeout = 15_000) => exec(process.execPath, [entry, ...args], {
    env, cwd: repository, timeout, maxBuffer: 8 * 1024 * 1024,
  });
  const daemon = spawn(process.execPath, [entry, 'daemon', 'run'], { env, cwd: repository, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise<void>(resolve => daemon.once('exit', () => resolve()));
  let logs = '';
  daemon.stdout?.on('data', data => { logs = (logs + String(data)).slice(-20_000); });
  daemon.stderr?.on('data', data => { logs = (logs + String(data)).slice(-20_000); });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 60 && daemon.exitCode === null; attempt++) {
      try { const status = await command(['daemon', 'status', '--json'], 1000); ready = typeof JSON.parse(status.stdout).pid === 'number'; } catch { /* startup */ }
      if (ready) break;
      await delay(100);
    }
    if (!ready) throw new Error(`Isolated MimiAgent did not start: ${logs}`);
    const catalog = JSON.parse((await command(['daemon', 'connectors'])).stdout) as { id: string; enabled: boolean }[];
    for (const item of catalog) if (item.enabled) await command(['daemon', 'connectors', 'disable', item.id]);
    const started = Date.now();
    const result = await command([prompt], timeoutMs);
    const transcript = JSON.parse(await readFile(path.join(root, 'agent/sessions', `${session}.json`), 'utf8')) as {
      items: { type?: string; name?: string; arguments?: string; output?: unknown }[];
    };
    const calls = transcript.items.filter(item => item.type === 'function_call');
    const trace = (await readFile(path.join(root, 'agent/traces', `${session}.jsonl`), 'utf8'))
      .trim().split('\n').map(line => JSON.parse(line) as { type: string; data?: { outcome?: string } });
    const outcome = [...trace].reverse().find(item => item.type === 'run_finalization')?.data?.outcome;
    if (outcome !== 'completed' || !calls.length || !result.stdout.trim()) {
      throw new Error(`Computer probe did not complete (finalization=${outcome ?? 'missing'}, calls=${calls.length}); retained evidence: ${root}`);
    }
    return { durationMs: Date.now() - started, output: result.stdout, calls: calls.map(item => ({ name: item.name, arguments: item.arguments })),
      results: transcript.items.filter(item => item.type === 'function_call_result').map(item => item.output) };
  } finally {
    await writeFile(path.join(root, 'mimi-daemon.log'), logs);
    try { await command(['daemon', 'stop']); } catch { daemon.kill('SIGTERM'); }
    await Promise.race([exited, delay(5000)]);
    if (daemon.exitCode === null && daemon.signalCode === null) { daemon.kill('SIGKILL'); await exited; }
  }
}
