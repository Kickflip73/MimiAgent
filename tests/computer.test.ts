import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunContext } from '@openai/agents';
import { ComputerManager, type ComputerRunAuthority } from '../src/extensions/computer/manager.js';
import { computerLedgerArguments, createComputerTools } from '../src/extensions/computer/tools.js';
import type {
  BackendActionRequest,
  BackendActionResult,
  BackendObservation,
  BackendObserveRequest,
  BackendSession,
  ComputerBackend,
  ComputerConfig,
  ComputerTargetSummary,
} from '../src/extensions/computer/types.js';
import { ExecutionLedger } from '../src/core/execution-ledger.js';
import { FileSession } from '../src/core/session.js';
import { toolsForMode, toolsForPermission } from '../src/runtime/tool-policy.js';
import { withExecutionLedger } from '../src/runtime/tool-ledger.js';
import { prepareComputerHistoryForModelInput } from '../src/runtime/model.js';
import { decideEvent } from '../src/daemon/policy.js';
import { ComputerArtifactStore } from '../src/extensions/computer/artifact-store.js';
import { CuaDriverClient } from '../src/extensions/computer/cua-driver-client.js';
import {
  CuaDriverLifecycle,
  resolveCuaDriverAppBundle,
} from '../src/extensions/computer/cua-driver-lifecycle.js';

const target: ComputerTargetSummary = {
  bundleId: 'com.example.editor', pid: 42, windowId: 7, appName: 'Editor', title: 'Document',
  bounds: { x: 0, y: 0, width: 800, height: 600 }, frontmost: false,
};

class FakeComputerBackend implements ComputerBackend {
  readonly kind = 'cua' as const;
  starts = 0;
  ends = 0;
  actions: BackendActionRequest[] = [];
  nextActionResult: BackendActionResult = { status: 'applied', delivery: 'background' };
  targets = [target];
  observation: BackendObservation = {
    target,
    frontmost: false,
    dimensions: { width: 800, height: 600 },
    elements: [
      { index: 1, role: 'AXButton', label: 'Save', actions: ['press'] },
      { index: 2, role: 'AXTextField', label: 'Password', secure: true, writable: true },
    ],
  };

  async health() { return { ready: true }; }
  async startSession(): Promise<BackendSession> { this.starts += 1; return { id: 'fake-session' }; }
  async listTargets(): Promise<ComputerTargetSummary[]> { return this.targets; }
  async observe(_session: BackendSession, request: BackendObserveRequest): Promise<BackendObservation> {
    if (request.input.scope === 'targets') return { data: [target] };
    return this.observation;
  }
  async act(_session: BackendSession, request: BackendActionRequest): Promise<BackendActionResult> {
    this.actions.push(request);
    return this.nextActionResult;
  }
  async endSession(): Promise<void> { this.ends += 1; }
  async close(): Promise<void> {}
}

function config(overrides: Partial<ComputerConfig> = {}): ComputerConfig {
  return {
    backend: 'cua', driverCommand: '/bin/false', actionTimeoutMs: 15_000,
    maxActionsPerRun: 50, maxScreenshotsPerRun: 12, pauseWhenTargetFrontmost: true,
    defaultAccess: 'background', foregroundLeaseSeconds: 30, artifactMaxBytes: 16 * 1024 * 1024,
    ...overrides,
  };
}

async function fixture(authority: Partial<ComputerRunAuthority> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-computer-'));
  const backend = new FakeComputerBackend();
  const manager = new ComputerManager(config(), backend, root);
  return {
    backend,
    manager,
    authority: { runId: 'run-1', access: 'background', supportsImageInput: true, ...authority } as ComputerRunAuthority,
  };
}

async function observeWindow(manager: ComputerManager, authority: ComputerRunAuthority) {
  return manager.observe(authority, {
    scope: 'window', target: { bundleId: target.bundleId, pid: target.pid, windowId: target.windowId },
    includeScreenshot: false, maxElements: 400, maxDepth: 12,
  }) as Promise<{ observationId: string }>;
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition was not met before timeout');
}

test('read-only Computer probe observes one allowlisted background window and verifies target stability', async () => {
  const { backend, manager } = await fixture();
  const receipt = await manager.observeStableBackgroundWindow({
    runId: 'probe-1',
    access: 'observe',
    allowedApps: [target.bundleId],
    supportsImageInput: false,
  });
  assert.equal(receipt.boundary, 'computer_manager');
  assert.equal(receipt.effect, 'read');
  assert.equal(receipt.targetVerified, true);
  assert.equal(receipt.actionResult, true);
  assert.equal(backend.actions.length, 0);
  assert.equal(backend.ends, 1);
});

test('read-only Computer probe rejects frontmost, control-plane, denied and drifting targets', async () => {
  const frontmost = await fixture();
  frontmost.backend.targets = [{ ...target, frontmost: true }];
  await assert.rejects(() => frontmost.manager.observeStableBackgroundWindow({
    runId: 'probe-frontmost', access: 'observe', allowedApps: [target.bundleId],
  }), /frontmost|target_in_use/);

  const denied = await fixture();
  await assert.rejects(() => denied.manager.observeStableBackgroundWindow({
    runId: 'probe-denied', access: 'observe', allowedApps: [target.bundleId], deniedApps: [target.bundleId],
  }), /route owner|接管/);

  const control = await fixture();
  control.backend.targets = [{
    ...target, bundleId: 'com.openai.codex', appName: 'Codex',
  }];
  control.backend.observation = {
    ...control.backend.observation,
    target: control.backend.targets[0],
  };
  await assert.rejects(() => control.manager.observeStableBackgroundWindow({
    runId: 'probe-control', access: 'observe', allowedApps: ['com.openai.codex'],
  }), /控制面/);

  const drifting = await fixture();
  let calls = 0;
  drifting.backend.listTargets = async () => {
    calls += 1;
    return calls < 2 ? [target] : [{ ...target, windowId: 8 }];
  };
  await assert.rejects(() => drifting.manager.observeStableBackgroundWindow({
    runId: 'probe-drift', access: 'observe', allowedApps: [target.bundleId],
  }), /drift|漂移|stale/);
});

test('requires a fresh observation for each bounded UI action', async () => {
  const { backend, manager, authority } = await fixture();
  const observed = await observeWindow(manager, authority);
  const result = await manager.act(authority, {
    observationId: observed.observationId,
    action: { type: 'click', elementIndex: 1, button: 'left', dispatch: 'background' },
  });
  assert.equal(result.status, 'applied');
  assert.equal(backend.actions[0]?.target?.windowId, target.windowId);
  await assert.rejects(() => manager.act(authority, {
    observationId: observed.observationId,
    action: { type: 'click', elementIndex: 1, button: 'left', dispatch: 'background' },
  }), /stale_observation/);
  await manager.endRun(authority.runId);
  assert.equal(backend.starts, 1);
  assert.equal(backend.ends, 1);
});

test('background authority rejects a driver-side foreground delivery', async () => {
  const { backend, manager, authority } = await fixture();
  backend.nextActionResult = { status: 'applied', delivery: 'foreground' };
  const observed = await observeWindow(manager, authority);

  await assert.rejects(() => manager.act(authority, {
    observationId: observed.observationId,
    action: { type: 'click', elementIndex: 1, button: 'left', dispatch: 'background' },
  }), /foreground_violation.*升级为前台投递/);
});

test('derives screenshotless window dimensions from the exact target bounds', async () => {
  const { backend, manager, authority } = await fixture();
  backend.observation = { ...backend.observation, dimensions: undefined };
  const observed = await manager.observe(authority, {
    scope: 'window', target: { pid: target.pid, windowId: target.windowId },
    includeScreenshot: false, maxElements: 400, maxDepth: 12,
  }) as { observationId: string; dimensions?: { width: number; height: number } };

  assert.deepEqual(observed.dimensions, { width: 800, height: 600 });
  const result = await manager.act(authority, {
    observationId: observed.observationId,
    action: { type: 'click', elementIndex: 1, button: 'left', dispatch: 'background' },
  });
  assert.equal(result.status, 'applied');
});

test('rejects unsafe target state, coordinates, secure fields, and unapproved escalation', async () => {
  const { backend, manager, authority } = await fixture();
  let observed = await observeWindow(manager, authority);
  await assert.rejects(() => manager.act(authority, {
    observationId: observed.observationId,
    action: { type: 'click', x: 900, y: 5, button: 'left', dispatch: 'background' },
  }), /坐标超出/);
  observed = await observeWindow(manager, authority);
  await assert.rejects(() => manager.act(authority, {
    observationId: observed.observationId,
    action: { type: 'type_text', elementIndex: 2, text: 'secret', dispatch: 'background' },
  }), /secure\/password/);
  await assert.rejects(() => manager.act(authority, {
    action: { type: 'bring_to_front', pid: target.pid, leaseSeconds: 10 },
  }), /approval_required.*foreground/);
  await assert.rejects(() => manager.act(authority, {
    action: { type: 'handoff_to_user', pid: target.pid, windowId: target.windowId },
  }), /approval_required.*foreground/);
  backend.observation = { ...backend.observation, frontmost: true };
  observed = await observeWindow(manager, authority);
  await assert.rejects(() => manager.act(authority, {
    observationId: observed.observationId,
    action: { type: 'click', elementIndex: 1, button: 'left', dispatch: 'background' },
  }), /target_in_use/);
});

test('enforces image capability and application allowlist', async () => {
  const { manager, authority } = await fixture({ supportsImageInput: false, allowedApps: ['com.example.other'] });
  await assert.rejects(() => manager.observe(authority, {
    scope: 'window', target: { bundleId: target.bundleId }, includeScreenshot: true, maxElements: 400, maxDepth: 12,
  }), /vision_unavailable/);
  await assert.rejects(() => observeWindow(manager, authority), /computerApps allowlist/);
  await assert.rejects(
    () => observeWindow(manager, { ...authority, allowedApps: [] }),
    /computerApps allowlist/,
  );
});

test('protects control-plane apps and Connector-owned apps from Computer takeover', async () => {
  const { backend, manager, authority } = await fixture({ deniedApps: ['com.google.Chrome'] });
  const setTarget = (bundleId: string) => {
    const claimed = { ...target, bundleId };
    backend.targets = [claimed];
    backend.observation = { ...backend.observation, target: claimed };
  };

  setTarget('com.apple.Terminal');
  await assert.rejects(
    () => manager.observe(authority, {
      scope: 'window',
      target: { bundleId: 'com.apple.Terminal', pid: target.pid, windowId: target.windowId },
      includeScreenshot: false,
      maxElements: 400,
      maxDepth: 12,
    }),
    /受保护控制面/,
  );

  setTarget('com.google.Chrome');
  await assert.rejects(
    () => manager.observe(authority, {
      scope: 'window',
      target: { bundleId: 'com.google.Chrome', pid: target.pid, windowId: target.windowId },
      includeScreenshot: false,
      maxElements: 400,
      maxDepth: 12,
    }),
    /route owner/,
  );
});

test('computer tools respect mode and deployment permission boundaries', async () => {
  const { manager, authority } = await fixture();
  const tools = createComputerTools(manager, () => authority);
  assert.ok(tools.every((item) => item.type === 'function' && item.strict === false));
  assert.deepEqual(toolsForMode('plan', tools).map((item) => item.name), ['computer_observe']);
  assert.deepEqual(toolsForPermission('workspace', tools).map((item) => item.name), []);
  assert.deepEqual(toolsForPermission('read-only', tools).map((item) => item.name), []);
  assert.deepEqual(toolsForPermission('trusted', tools).map((item) => item.name), ['computer_observe', 'computer_act']);
});

test('redacts type_text plaintext from semantic and persisted ledger arguments', async () => {
  const raw = JSON.stringify({
    observationId: 'b9c5b354-88d8-4bee-9135-9e550dfca2ab',
    authorizationId: 'authorization-type-text',
    action: { type: 'type_text', text: 'private value' },
  });
  const redacted = computerLedgerArguments(raw);
  assert.doesNotMatch(redacted, /private value/);
  assert.doesNotMatch(redacted, /authorization-type-text/);
  assert.match(redacted, /textSha256/);
  assert.match(redacted, /textLength/);

  const { manager, authority } = await fixture();
  const observed = await observeWindow(manager, authority);
  const executionRaw = JSON.stringify({
    observationId: observed.observationId,
    authorizationId: 'authorization-type-text',
    action: { type: 'type_text', elementIndex: 1, text: 'private value', dispatch: 'background' },
  });
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-computer-ledger-'));
  const ledger = new ExecutionLedger(path.join(root, 'ledger.json'));
  const act = createComputerTools(manager, () => authority).find((item) => item.name === 'computer_act')!;
  const [wrapped] = withExecutionLedger([act], ledger, () => ({
    sessionId: 's',
    runId: 'r',
    guardedActionContext: {
      ownerAuthenticated: true,
      exactTarget: true,
      lowRisk: false,
      reversible: false,
      boundedLocal: true,
    },
  }));
  assert.ok(wrapped && 'invoke' in wrapped);
  const actionResult = await wrapped.invoke(
    new RunContext({}),
    executionRaw,
    { toolCall: { callId: 'c' } } as never,
  ) as Record<string, unknown>;
  const actionEvidence = actionResult.mimiActionIntent as Record<string, unknown>;
  assert.match(String(actionEvidence.ref), /^action-intent:/);
  assert.equal(actionEvidence.outcome, 'confirmed');
  assert.match(String(actionEvidence.actionFamily), /^computer\./);
  const calls = await ledger.listCalls('s', 'r');
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0]!.argumentsJson, /private value/);
});

test('production ledger wiring keeps exact low-risk owner launch on the guarded fast path', async () => {
  const { backend, manager, authority } = await fixture({
    allowedApps: [target.bundleId],
  });
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-computer-owner-fast-path-'));
  const ledger = new ExecutionLedger(path.join(root, 'ledger.json'));
  const act = createComputerTools(manager, () => authority).find((item) => item.name === 'computer_act')!;
  const run = {
    sessionId: 'owner',
    runId: 'owner-run',
    guardedActionContext: {
      ownerAuthenticated: true,
      exactTarget: true,
      lowRisk: true,
      reversible: false,
    },
  };
  const [wrapped] = withExecutionLedger([act], ledger, () => run);
  assert.ok(wrapped && 'invoke' in wrapped);
  const input = JSON.stringify({
    action: { type: 'launch_app', bundleId: target.bundleId, urls: [], newInstance: false },
  });
  const first = await wrapped.invoke(new RunContext({}), input, { toolCall: { callId: 'launch-1' } } as never);
  const replay = await wrapped.invoke(new RunContext({}), input, { toolCall: { callId: 'launch-1' } } as never);
  assert.equal((first as Record<string, unknown>).status, 'applied');
  assert.equal(JSON.stringify(replay), JSON.stringify(first));
  assert.equal(backend.actions.length, 1);

  const untrustedLedger = new ExecutionLedger(path.join(root, 'untrusted-ledger.json'));
  const [untrusted] = withExecutionLedger([act], untrustedLedger, () => ({
    ...run,
    runId: 'external-run',
    guardedActionContext: { ...run.guardedActionContext, ownerAuthenticated: false },
  }));
  assert.ok(untrusted && 'invoke' in untrusted);
  await assert.rejects(
    untrusted.invoke(new RunContext({}), input, { toolCall: { callId: 'launch-external' } } as never),
    /当前 Security 或精确目标校验未授权/,
  );
  const [urlLaunch] = withExecutionLedger(
    [act],
    new ExecutionLedger(path.join(root, 'url-ledger.json')),
    () => run,
  );
  assert.ok(urlLaunch && 'invoke' in urlLaunch);
  const urlResult = await urlLaunch.invoke(new RunContext({}), JSON.stringify({
    action: {
      type: 'launch_app',
      bundleId: target.bundleId,
      urls: ['https://example.invalid/action'],
      newInstance: false,
    },
  }), { toolCall: { callId: 'launch-url' } } as never) as Record<string, unknown>;
  assert.equal(urlResult.status, 'applied');
  assert.equal(backend.actions.length, 2);
});

test('production ledger wiring permits an authenticated owner bounded background UI action', async () => {
  const { backend, manager, authority } = await fixture({
    allowedApps: [target.bundleId],
  });
  const observed = await observeWindow(manager, authority);
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-computer-owner-bounded-ui-'));
  const ledger = new ExecutionLedger(path.join(root, 'ledger.json'));
  const act = createComputerTools(manager, () => authority).find((item) => item.name === 'computer_act')!;
  const [wrapped] = withExecutionLedger([act], ledger, () => ({
    sessionId: 'owner',
    runId: authority.runId,
    guardedActionContext: {
      ownerAuthenticated: true,
      exactTarget: true,
      lowRisk: true,
      reversible: false,
      boundedLocal: true,
    },
  }));
  assert.ok(wrapped && 'invoke' in wrapped);

  const result = await wrapped.invoke(
    new RunContext({}),
    JSON.stringify({
      observationId: observed.observationId,
      action: { type: 'click', elementIndex: 1, button: 'left', dispatch: 'background' },
    }),
    { toolCall: { callId: 'bounded-background-click' } } as never,
  ) as Record<string, unknown>;

  assert.equal(result.status, 'applied');
  assert.equal(result.delivery, 'background');
  assert.equal(backend.actions.length, 1);
  assert.equal(backend.actions[0]?.target?.bundleId, target.bundleId);
  assert.equal(backend.actions[0]?.element?.index, 1);
});

test('Full Owner uses a fresh Computer observation without a second approval layer', async () => {
  const { backend, manager, authority } = await fixture();
  const observed = await observeWindow(manager, authority);
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-computer-evidence-only-'));
  const ledger = new ExecutionLedger(path.join(root, 'ledger.json'));
  const act = createComputerTools(manager, () => authority).find((item) => item.name === 'computer_act')!;
  const [wrapped] = withExecutionLedger([act], ledger, () => ({
    sessionId: 'owner',
    runId: 'high-risk-run',
    guardedActionContext: {
      ownerAuthenticated: true,
      exactTarget: true,
      lowRisk: false,
      reversible: false,
    },
  }));
  assert.ok(wrapped && 'invoke' in wrapped);

  const result = await wrapped.invoke(new RunContext({}), JSON.stringify({
    observationId: observed.observationId,
    action: { type: 'click', elementIndex: 1, button: 'left', dispatch: 'background' },
  }), { toolCall: { callId: 'high-risk-click' } } as never) as Record<string, unknown>;
  assert.equal(result.status, 'applied');
  assert.equal(backend.actions.length, 1);
});

test('removes completed Computer screenshots from later model history without splitting tool pairs', () => {
  const items = [
    { type: 'function_call', name: 'computer_observe', callId: 'observe-1', arguments: '{}' },
    { type: 'function_call_result', name: 'computer_observe', callId: 'observe-1', output: [
      { type: 'text', text: '{"observationId":"old"}' },
      { type: 'image', image: { data: 'private-base64', mediaType: 'image/png' } },
    ] },
  ] as never[];
  const prepared = prepareComputerHistoryForModelInput(items) as unknown as Array<Record<string, unknown>>;
  assert.equal(prepared.length, 2);
  assert.equal(prepared[0]?.type, 'function_call');
  assert.doesNotMatch(JSON.stringify(prepared), /private-base64/);
  assert.match(JSON.stringify(prepared), /历史 Computer Observation 图片已省略/);
});

test('Daemon source policy grants Computer access explicitly and keeps it off by default', () => {
  const now = new Date().toISOString();
  const event = {
    id: 'event-1', externalId: 'external-1', source: 'connector:owner', kind: 'command' as const,
    trust: 'external' as const, payload: 'Edit the open document', profileId: 'owner',
    occurredAt: now, receivedAt: now, priority: 80,
  };
  const denied = decideEvent(event, [], undefined, 'work');
  assert.equal(denied.options?.computerAccess, undefined);
  assert.ok(!denied.options?.policy?.allowedTools?.includes('computer_observe'));

  const allowed = decideEvent(event, [], undefined, 'work', false, undefined, undefined, 'background', ['com.example.editor']);
  assert.equal(allowed.options?.computerAccess, 'background');
  assert.deepEqual(allowed.options?.computerApps, ['com.example.editor']);
  assert.ok(allowed.options?.policy?.allowedCapabilities.includes('computer-read'));
  assert.ok(allowed.options?.policy?.allowedCapabilities.includes('computer-write'));
  assert.ok(allowed.options?.policy?.allowedTools?.includes('computer_observe'));
  assert.ok(allowed.options?.policy?.allowedSideEffectTools?.includes('computer_act'));

  const localOwner = decideEvent({ ...event, source: 'local-cli', trust: 'owner' }, []);
  assert.equal(localOwner.options?.computerAccess, 'background');
  assert.equal(localOwner.options?.policy, undefined);
});

test('foreground lease restores the previous app on explicit release', async () => {
  const { backend, manager, authority } = await fixture({ access: 'foreground' });
  const previous = {
    ...target, bundleId: 'com.example.terminal', pid: 99, windowId: 11, appName: 'Terminal',
    title: 'Shell', frontmost: true,
  };
  backend.targets = [{ ...target, frontmost: false }, previous];
  await manager.act(authority, { action: { type: 'bring_to_front', pid: target.pid, windowId: target.windowId, leaseSeconds: 30 } });
  await manager.act(authority, { action: { type: 'release_foreground' } });
  assert.equal(backend.actions.length, 2);
  assert.equal(backend.actions[0]?.input.action.type, 'bring_to_front');
  assert.equal(backend.actions[1]?.target?.bundleId, previous.bundleId);
  assert.equal(manager.status().foregroundLeaseActive, false);
});

test('user handoff retains the requested window after the run ends', async () => {
  const { backend, manager, authority } = await fixture({ access: 'foreground' });
  const previous = {
    ...target, bundleId: 'com.example.terminal', pid: 99, windowId: 11, appName: 'Terminal',
    title: 'Shell', frontmost: true,
  };
  backend.targets = [{ ...target, frontmost: false }, previous];

  const result = await manager.act(authority, {
    action: { type: 'handoff_to_user', pid: target.pid, windowId: target.windowId },
  });
  await manager.endRun(authority.runId);

  assert.ok('foregroundDisposition' in result);
  assert.equal(result.foregroundDisposition, 'retained_for_user');
  assert.equal(result.verified, false);
  assert.equal(result.requiresObservation, true);
  assert.equal(backend.actions.length, 1);
  assert.equal(backend.actions[0]?.input.action.type, 'handoff_to_user');
  assert.equal(manager.status().foregroundLeaseActive, false);
});

test('user handoff converts an active foreground lease without restoring it', async () => {
  const { backend, manager, authority } = await fixture({ access: 'foreground' });
  const previous = {
    ...target, bundleId: 'com.example.terminal', pid: 99, windowId: 11, appName: 'Terminal',
    title: 'Shell', frontmost: true,
  };
  backend.targets = [{ ...target, frontmost: false }, previous];

  await manager.act(authority, {
    action: { type: 'bring_to_front', pid: target.pid, windowId: target.windowId, leaseSeconds: 30 },
  });
  await manager.act(authority, {
    action: { type: 'handoff_to_user', pid: target.pid, windowId: target.windowId },
  });
  await manager.endRun(authority.runId);

  assert.deepEqual(backend.actions.map((action) => action.input.action.type), [
    'bring_to_front', 'handoff_to_user',
  ]);
  assert.equal(manager.status().foregroundLeaseActive, false);
});

test('admin driver configuration is restricted to the tested allowlist', async () => {
  const { manager, authority } = await fixture({ access: 'admin' });
  await assert.rejects(() => manager.act(authority, {
    action: { type: 'set_driver_config', values: { experimental_pip: true } },
  }), /只允许 max_image_dimension/);
});

test('Computer artifacts are private, hash-bound, and reject unstable replay steps', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-computer-artifact-'));
  const store = new ComputerArtifactStore(path.join(root, 'artifacts'), 1024 * 1024);
  const pending = await store.create('run-artifact');
  assert.equal((await stat(pending.directory)).mode & 0o777, 0o700);
  const turn = path.join(pending.directory, 'turn-00001');
  await mkdir(turn);
  await writeFile(path.join(turn, 'action.json'), JSON.stringify({ tool: 'click', arguments: { x: 10, y: 20 } }));
  const manifest = await store.seal(pending.artifactId, 'run-artifact');
  const opened = await store.openReplay(pending.artifactId, manifest.manifestSha256);
  assert.equal(opened.directory, pending.directory);
  await assert.rejects(() => store.openReplay(pending.artifactId, '0'.repeat(64)), /hash 不匹配/);
  await writeFile(path.join(turn, 'action.json'), JSON.stringify({ tool: 'click', arguments: { x: 11, y: 20 } }));
  await assert.rejects(() => store.openReplay(pending.artifactId, manifest.manifestSha256), /文件内容已变化/);

  const unstable = await store.create('run-artifact');
  const unstableTurn = path.join(unstable.directory, 'turn-00001');
  await mkdir(unstableTurn);
  await writeFile(path.join(unstableTurn, 'action.json'), JSON.stringify({ tool: 'click', arguments: { element_index: 3 } }));
  const unstableManifest = await store.seal(unstable.artifactId, 'run-artifact');
  await assert.rejects(() => store.openReplay(unstable.artifactId, unstableManifest.manifestSha256), /element index\/token/);

  const linked = await store.create('run-artifact');
  await symlink('/etc/hosts', path.join(linked.directory, 'outside'));
  await assert.rejects(() => store.seal(linked.artifactId, 'run-artifact'), /不允许符号链接/);
});

test('recording paths stay behind opaque artifact identifiers', async () => {
  const { backend, manager, authority } = await fixture({ access: 'admin' });
  const started = await manager.act(authority, { action: { type: 'start_recording', recordVideo: false } }) as Record<string, unknown>;
  assert.match(String(started.artifactId), /^artifact-/);
  const driverPath = backend.actions[0]?.artifactPath;
  assert.ok(driverPath && path.isAbsolute(driverPath));
  assert.doesNotMatch(JSON.stringify(started), new RegExp(driverPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const stopped = await manager.act(authority, { action: { type: 'stop_recording' } }) as Record<string, unknown>;
  assert.equal(stopped.trajectoryId, started.artifactId);
  assert.match(String(stopped.manifestSha256), /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(stopped), /computer-artifacts/);
});

test('Cua CLI adapter validates the pinned version and MCP result envelope', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-cua-cli-'));
  const command = path.join(root, 'cua-driver');
  await writeFile(command, [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then printf "cua-driver 0.8.3\\n"; exit 0; fi',
    'if [ "$2" = "health_report" ]; then printf \'%s\\n\' \'{"content":[{"type":"text","text":"ok"}],"structuredContent":{"ready":true}}\'; exit 0; fi',
    'if [ "$2" = "check_permissions" ]; then printf \'%s\\n\' \'{"content":[],"structuredContent":{"accessibility":true}}\'; exit 0; fi',
    'exit 2',
  ].join('\n'));
  await chmod(command, 0o700);
  const client = new CuaDriverClient(command, 2_000);
  assert.deepEqual(await client.diagnostics(), {
    health: { version: '0.8.3', ready: true },
    permissions: { accessibility: true },
  });

  const incompatible = path.join(root, 'cua-driver-new');
  await writeFile(incompatible, '#!/bin/sh\nprintf "cua-driver 0.9.1\\n"\n');
  await chmod(incompatible, 0o700);
  await assert.rejects(() => new CuaDriverClient(incompatible, 2_000).health(), /不在已测试兼容范围/);
});

test('Cua CLI adapter accepts 0.9 raw JSON results and extracts screenshots', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-cua-raw-'));
  const fixture = path.join(root, 'cua-driver');
  await writeFile(fixture, `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'cua-driver 0.9.0\\n'; exit 0; fi
printf '{"elements":[],"screenshot_png_b64":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB","screenshot_mime_type":"image/png"}\\n'
`, { mode: 0o700 });
  const client = new CuaDriverClient(fixture, 2_000);
  const session = await client.startSession({ sessionId: 'raw-json', captureScope: 'auto' });
  const result = await client.observe(session, { input: { scope: 'desktop', includeScreenshot: true } });
  assert.equal(result.screenshot?.mediaType, 'image/png');
  assert.equal(result.screenshot?.data, 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB');
  assert.deepEqual(result.data, { elements: [] });
});

test('Cua CLI adapter accepts the installed 0.12.3 driver version', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-cua-current-'));
  const fixture = path.join(root, 'cua-driver');
  await writeFile(fixture, `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'cua-driver 0.12.3\\n'; exit 0; fi
printf '{"content":[],"structuredContent":{"ready":true}}\\n'
`, { mode: 0o700 });
  const client = new CuaDriverClient(fixture, 2_000);

  assert.equal((await client.health()).version, '0.12.3');
});

test('Cua lifecycle starts a missing daemon and restores it after a crash', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-cua-lifecycle-'));
  const state = path.join(root, 'daemon-ready');
  const command = path.join(root, 'cua-driver.mjs');
  await writeFile(command, `#!/usr/bin/env node
import { existsSync } from 'node:fs';
if (process.argv[2] === '--version') {
  process.stdout.write('cua-driver 0.12.3\\n');
  process.exit(0);
}
if (!existsSync(${JSON.stringify(state)})) {
  process.stderr.write('Cua Driver daemon is not running on cua-driver.sock\\n');
  process.exit(1);
}
process.stdout.write('{"content":[],"structuredContent":{"overall":"ok"}}\\n');
`, { mode: 0o700 });
  const lifecycle = new CuaDriverLifecycle(command, 500, {
    monitorIntervalMs: 20,
    startupTimeoutMs: 500,
    probeIntervalMs: 10,
    launcher: () => writeFile(state, 'ready'),
  });

  assert.equal((await lifecycle.start()).ready, true);
  assert.equal(lifecycle.status().launchAttempts, 1);
  assert.equal(lifecycle.status().recoveries, 1);

  await rm(state);
  await waitUntil(() => lifecycle.status().recoveries === 2);
  assert.equal(lifecycle.status().ready, true);
  assert.equal(lifecycle.status().launchAttempts, 2);
  lifecycle.stop();
  assert.equal(lifecycle.status().state, 'stopped');
});

test('Cua lifecycle resolves the application bundle through the installed CLI symlink', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-cua-app-bundle-'));
  const executable = path.join(root, 'CuaDriver.app', 'Contents', 'MacOS', 'cua-driver');
  const command = path.join(root, 'bin', 'cua-driver');
  await mkdir(path.dirname(executable), { recursive: true });
  await mkdir(path.dirname(command), { recursive: true });
  await writeFile(executable, '#!/bin/sh\n', { mode: 0o700 });
  await symlink(executable, command);

  assert.equal(
    resolveCuaDriverAppBundle(command),
    path.join(await realpath(root), 'CuaDriver.app'),
  );
});

test('Cua client recovers read calls but never replays an uncertain action', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-cua-recovery-'));
  const state = path.join(root, 'daemon-ready');
  const calls = path.join(root, 'calls.log');
  const command = path.join(root, 'cua-driver.mjs');
  await writeFile(command, `#!/usr/bin/env node
import { appendFileSync, existsSync } from 'node:fs';
if (process.argv[2] === '--version') {
  process.stdout.write('cua-driver 0.12.3\\n');
  process.exit(0);
}
const name = process.argv[3] || '';
appendFileSync(${JSON.stringify(calls)}, name + '\\n');
if (!existsSync(${JSON.stringify(state)})) {
  process.stderr.write('Cua Driver daemon is not running on cua-driver.sock\\n');
  process.exit(1);
}
process.stdout.write('{"content":[],"structuredContent":{"status":"applied"}}\\n');
`, { mode: 0o700 });
  const lifecycle = new CuaDriverLifecycle(command, 500, {
    startupTimeoutMs: 500,
    probeIntervalMs: 10,
    launcher: () => writeFile(state, 'ready'),
  });
  const client = new CuaDriverClient(command, 500, lifecycle);

  assert.equal((await client.health()).version, '0.12.3');
  assert.equal(lifecycle.status().recoveries, 1);
  await rm(state);
  await assert.rejects(
    () => client.act(
      { id: 'action-session' },
      { input: { action: { type: 'wait', milliseconds: 1 } } },
    ),
    /结果不确定；不会自动重试/,
  );
  await waitUntil(() => lifecycle.status().ready);
  const actionCalls = (await readFile(calls, 'utf8'))
    .split('\n')
    .filter((name) => name === 'wait');
  assert.equal(actionCalls.length, 1);
});

test('FileSession never persists computer type_text plaintext', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-computer-session-'));
  const session = new FileSession(root, 'computer-redaction');
  await session.addItems([{
    type: 'function_call', name: 'computer_act', callId: 'call-secret',
    arguments: JSON.stringify({ observationId: 'obs', action: { type: 'type_text', text: 'session secret' } }),
  } as never]);
  const serialized = JSON.stringify(await session.getItems());
  assert.doesNotMatch(serialized, /session secret/);
  assert.match(serialized, /REDACTED sha256/);
});
