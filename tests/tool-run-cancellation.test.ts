import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunContext } from '@openai/agents';
import { MimiAgent } from '../src/runtime/mimi-agent.js';
import { toolResultStatus } from '../src/core/tool-result.js';
import { tool, withToolRunSignal } from '../src/tool-factory.js';
import { HostCapabilityRegistry } from '../src/runtime/pipeline/capability-registry.js';
import { z } from 'zod';

test('Run signal binding combines invocation timeout, isolates Runs and reaches lazy gateway tools', async () => {
  const owner = new AbortController();
  const other = new AbortController();
  const invocation = new AbortController();
  const signals: AbortSignal[] = [];
  let calls = 0;
  const candidate = tool({ name: 'mcp_fixture__probe', description: 'fixture', parameters: z.object({}), execute: async (_args, _context, details) => { calls += 1; signals.push(details!.signal!); return 'ok'; } });
  const context = new RunContext({});
  const [first] = withToolRunSignal([candidate], owner.signal) as Array<typeof candidate>;
  const [second] = withToolRunSignal([candidate], other.signal) as Array<typeof candidate>;
  await first!.invoke(context, '{}', { signal: invocation.signal });
  await second!.invoke(context, '{}');
  invocation.abort();
  assert.equal(signals[0]!.aborted, true);
  assert.equal(signals[1]!.aborted, false);
  owner.abort();
  assert.throws(() => first!.invoke(context, '{}'), /abort/i);
  assert.equal(calls, 2);

  const registry = new HostCapabilityRegistry([], undefined, undefined, { statuses: () => [{ name: 'fixture', state: 'configured', tools: 0 }], load: async () => [candidate] });
  const gateway = withToolRunSignal(registry.gatewayTools([]), other.signal) as Array<typeof candidate>;
  await gateway[0]!.invoke(context, JSON.stringify({ source: 'mcp', name: candidate.name }));
  await gateway[1]!.invoke(context, JSON.stringify({ name: candidate.name, argumentsJson: '{}' }));
  other.abort();
  assert.equal(signals[2]!.aborted, true, 'late materialized tool inherited gateway Run signal');
});

test('Host cancellation reaches a real shell child when SDK invocation details omit signal', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-run-cancel-'));
  const marker = path.join(root, 'child.pid');
  const script = path.join(root, 'child.cjs');
  await writeFile(script, "require('node:fs').writeFileSync(process.argv[2], String(process.pid)); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);");
  const agent = await MimiAgent.create({ provider: 'openai', workspaceRoot: root, dataRoot: path.join(root, '.mimi-agent'), skillsRoot: path.join(root, 'skills'), mcpConfig: path.join(root, 'mcp.json'), historyLimit: 20, maxTurns: 5 }, 'cancel-fixture');
  const controller = new AbortController();
  let pid: number | undefined;
  let result: any;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  (agent as any).runner.run = async (runtime: any) => {
    const shell = runtime.tools.find((candidate: any) => candidate.name === 'run_shell');
    assert.ok(shell);
    result = await shell.invoke(new RunContext({}), JSON.stringify({ command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)} ${JSON.stringify(marker)}`, timeoutSeconds: 10 }), { toolCall: { callId: 'cancel-shell' } });
    return {};
  };
  const running = agent.stream('run local fixture', controller.signal, { securityProfile: 'full-owner' });
  try {
    const deadline = Date.now() + 5_000;
    while (!pid && Date.now() < deadline) {
      try { pid = Number(await readFile(marker, 'utf8')); } catch { await new Promise(resolve => setTimeout(resolve, 10)); }
    }
    assert.ok(pid, 'child reached its ready marker');
    controller.abort(new Error('fixture owner stopped'));
    await Promise.race([running, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('child did not stop after Host cancellation')), 1_500); })]);
    assert.throws(() => process.kill(pid!, 0), { code: 'ESRCH' });
    assert.notEqual(result?.exitCode, 0);
    const calls = await agent.components.state.executionLedger.store.listCalls(agent.currentSessionId, agent.activeRunId!);
    const call = calls.find(call => call.toolName === 'run_shell');
    assert.ok(call);
    // A settled invocation receipt is not a claim that its shell command succeeded.
    assert.equal(toolResultStatus(call.output), 'failed');
    assert.equal(result.termination?.reason, 'aborted');
  } finally {
    clearTimeout(timeout);
    if (pid) { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} } }
    await running.catch(() => undefined);
    await agent.failRun(new Error('fixture stopped'), true);
    await agent.close();
    await rm(root, { recursive: true, force: true });
  }
});
