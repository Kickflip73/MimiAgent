import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileSession } from '../src/core/session.js';
import { PlanStore } from '../src/core/plan.js';

const transcript = (id: string, text: string, time = '2026-01-01T00:00:00Z') => ({
  id, createdAt: time, updatedAt: time, items: [{ role: 'user', content: text }],
});

test('inspecting missing, active, and corrupt sessions never initializes or repairs files', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-readonly-session-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(await new FileSession(root, 'missing').readSnapshot(), undefined);
  assert.deepEqual(await readdir(root), []);
  const file = path.join(root, 'active.json');
  const record = { ...transcript('active', 'actual history'), preferences: { mode: 'plan' },
    checkpoint: { runId: 'r', status: 'running', input: 'in progress', phase: 'tools', startedAt: '2026-01-01', updatedAt: '2026-01-01', ownerPid: 99999999 },
  };
  await writeFile(file, JSON.stringify(record));
  await chmod(file, 0o644);
  const before = await stat(file);
  const snapshot = await new FileSession(root, 'active').readSnapshot();
  assert.equal(snapshot?.checkpoint?.status, 'running');
  assert.equal(snapshot?.preferences?.mode, 'plan');
  assert.deepEqual(snapshot?.items, record.items);
  assert.equal((await stat(file)).mode, before.mode);
  assert.equal(await readFile(file, 'utf8'), JSON.stringify(record));
  await writeFile(path.join(root, 'broken.json'), '{broken');
  await assert.rejects(new FileSession(root, 'broken').readSnapshot(), SyntaxError);
  assert.deepEqual((await readdir(root)).sort(), ['active.json', 'broken.json']);
  assert.equal(await readFile(path.join(root, 'broken.json'), 'utf8'), '{broken');
});

test('summary index tracks external atomic replacements, additions, removal and corruption markers', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-summary-index-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'one.json'), JSON.stringify(transcript('one', 'first')));
  const first = await FileSession.listSummaries(root);
  assert.equal(first[0]?.title, 'first');
  first[0]!.title = 'caller mutation';
  assert.equal((await FileSession.listSummaries(root))[0]?.title, 'first');
  await writeFile(path.join(root, 'new.tmp'), JSON.stringify(transcript('one', 'changed', '2026-02-01')));
  await rename(path.join(root, 'new.tmp'), path.join(root, 'one.json'));
  await writeFile(path.join(root, 'two.json'), JSON.stringify(transcript('two', 'second')));
  await writeFile(path.join(root, 'broken.json'), 'invalid json');
  const [a, b] = await Promise.all([FileSession.listSummaries(root), FileSession.listSummaries(root)]);
  assert.deepEqual(a, b);
  assert.equal(a[0]?.title, 'changed');
  assert.equal(a.length, 2);
  await writeFile(path.join(root, 'one.json.corrupt-state'), '{}');
  assert.deepEqual((await FileSession.listSummaries(root)).map(s => s.id), ['two']);
  await rm(path.join(root, 'two.json'));
  assert.deepEqual(await FileSession.listSummaries(root), []);
  assert.equal(await readFile(path.join(root, 'broken.json'), 'utf8'), 'invalid json');
});

test('plan inspection preserves both legacy and current formats without creating or repairing data', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-plan-inspect-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'plans.json');
  const store = new PlanStore(file, 'history');
  assert.deepEqual(await store.readSnapshot(), []);
  assert.deepEqual(await readdir(root), []);
  const step = { id: 's', description: 'history plan', status: 'pending' };
  await writeFile(file, JSON.stringify({ history: [step], other: { steps: [] } }));
  assert.deepEqual(await store.readSnapshot(), [step]);
  await writeFile(file, '{broken');
  await assert.rejects(store.readSnapshot(), SyntaxError);
  assert.equal(await readFile(file, 'utf8'), '{broken');
});

test('cold Agent inspection uses the requested transcript, preferences and plan without primary context leakage', async (t) => {
  const { MimiAgent } = await import('../src/runtime/mimi-agent.js');
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-agent-inspect-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = { providerId: 'history-provider', modelId: 'history-model' };
  const tool = { type: 'function_call', callId: 'call-1', name: 'read_file', arguments: '{}' };
  const record = { ...transcript('history', 'historical question'),
    items: [{ role: 'user', content: 'historical question' }, tool],
    preferences: { mode: 'plan', outputLevel: 'tools', modelTarget: target },
  };
  await writeFile(path.join(root, 'history.json'), JSON.stringify(record));
  const planFile = path.join(root, 'plans.json');
  const step = { id: 'step', description: 'historical plan', status: 'pending' };
  await writeFile(planFile, JSON.stringify({ history: [step] }));
  const agent = Object.assign(Object.create(MimiAgent.prototype), {
    sessionId: 'primary', defaultMode: 'general', defaultOutputLevel: 'normal',
    runtimeSecurity: { permissionMode: 'trusted' },
    lastContextManifest: { sessionId: 'primary', estimatedInputTokens: 999999 },
    components: {
      state: {
        sessions: { open: (id: string) => new FileSession(root, id) },
        goalsAndPlans: { open: (id: string) => new PlanStore(planFile, id) },
      },
      modelGateway: { provider: () => ({ transport: 'chat_completions' }) },
    },
    targetRuntime: (selected: unknown) => {
      assert.deepEqual(selected, target);
      return { name: 'history-model', profile: { contextWindow: 128000 } };
    },
    refreshModelConfiguration: () => assert.fail('inspection cannot refresh mutable runtime configuration'),
  }) as import('../src/runtime/mimi-agent.js').MimiAgent;
  const snapshot = await agent.sessionSnapshot('history');
  assert.deepEqual(snapshot.items, record.items);
  assert.deepEqual(snapshot.plan, [step]);
  assert.equal(snapshot.runtime.mode.id, 'plan');
  assert.deepEqual(snapshot.runtime.modelTarget, target);
  assert.equal(snapshot.context.manifest, undefined);
  assert.equal(snapshot.context.status.source, 'raw-history');
  assert.ok(snapshot.context.status.value < 999999);
  assert.equal(agent.sessionId, 'primary');
  assert.equal(await readFile(path.join(root, 'history.json'), 'utf8'), JSON.stringify(record));
});
