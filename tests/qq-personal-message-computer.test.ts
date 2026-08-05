import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ComputerManager } from '../src/extensions/computer/manager.js';
import {
  QqPersonalMessageComputerAdapter,
  qqVisibleAccountFingerprint,
  qqVisibleConversationId,
} from '../src/extensions/computer/qq-personal-message.js';
import type {
  BackendActionRequest,
  BackendObservation,
  BackendObserveRequest,
  BackendSession,
  ComputerAppSummary,
  ComputerBackend,
  ComputerConfig,
  ComputerElement,
  ComputerTargetSummary,
} from '../src/extensions/computer/types.js';
import { PersonalMessageHub, type PersonalMessageScope } from '../src/runtime/personal-message-hub.js';

const account = 'fixture-owner';
const conversation = 'fixture-contact';
const target: ComputerTargetSummary = {
  bundleId: 'com.tencent.qq',
  pid: 42,
  windowId: 7,
  appName: 'QQ',
  title: 'QQ',
  bounds: { x: 0, y: 0, width: 1_000, height: 800 },
  frontmost: false,
};

class FakeQqBackend implements ComputerBackend {
  readonly kind = 'cua' as const;
  readonly actions: BackendActionRequest[] = [];
  observations = 0;
  draft = '';
  sent = false;
  sendNoop = false;
  frontmost = false;
  compositeSurfaces = false;
  independentSurface = false;

  async health() { return { ready: true }; }
  async startSession(): Promise<BackendSession> { return { id: 'fake-qq-session' }; }
  async listApps(): Promise<ComputerAppSummary[]> {
    return [{ bundleId: target.bundleId, name: target.appName, running: true }];
  }
  async listTargets(): Promise<ComputerTargetSummary[]> {
    const primary = { ...target, frontmost: this.frontmost };
    return this.compositeSurfaces ? [
      primary,
      {
        ...primary,
        windowId: 8,
        bounds: { x: 50, y: 40, width: 900, height: 700 },
      },
      {
        ...primary,
        windowId: 9,
        bounds: this.independentSurface
          ? { x: 1_500, y: 80, width: 800, height: 620 }
          : { x: 100, y: 80, width: 800, height: 620 },
      },
    ] : [primary];
  }
  async observe(_session: BackendSession, request: BackendObserveRequest): Promise<BackendObservation> {
    const windowId = request.input.scope === 'window' ? request.input.target.windowId : undefined;
    if (windowId !== target.windowId) {
      throw new Error(`ax_window_unresolved: ${windowId ?? 'none'}`);
    }
    this.observations += 1;
    const elements: ComputerElement[] = [
      {
        index: 10,
        role: 'AXStaticText',
        label: account,
        frame: { x: 80, y: 60, width: 120, height: 20 },
      },
      {
        index: 20,
        role: 'AXButton',
        label: conversation,
        frame: { x: 320, y: 100, width: 180, height: 24 },
      },
      {
        index: 11,
        role: 'AXButton',
        label: account,
        frame: { x: 82, y: 62, width: 118, height: 20 },
      },
      {
        index: 30,
        role: 'AXStaticText',
        label: 'incoming fixture',
        frame: { x: 320, y: 360, width: 140, height: 24 },
      },
      {
        index: 31,
        role: 'AXStaticText',
        label: 'outgoing fixture',
        frame: { x: 760, y: 400, width: 150, height: 24 },
      },
      {
        index: 40,
        role: 'AXTextArea',
        value: this.draft,
        writable: true,
        frame: { x: 300, y: 650, width: 650, height: 100 },
      },
    ];
    if (this.sent) {
      elements.splice(-1, 0, {
        index: 32,
        role: 'AXStaticText',
        label: 'confirmed fixture reply',
        frame: { x: 740, y: 450, width: 190, height: 24 },
      });
    }
    return {
      target: { ...target, frontmost: this.frontmost },
      frontmost: this.frontmost,
      dimensions: { width: 1_000, height: 800 },
      elements,
    };
  }
  async act(_session: BackendSession, request: BackendActionRequest) {
    this.actions.push(request);
    if (request.input.action.type === 'type_text') this.draft = request.input.action.text;
    if (request.input.action.type === 'keypress' && !this.sendNoop) {
      this.sent = true;
      this.draft = '';
    }
    return { status: 'applied' as const, delivery: 'background' as const };
  }
  async endSession(): Promise<void> {}
  async close(): Promise<void> {}
}

function computerConfig(): ComputerConfig {
  return {
    backend: 'cua',
    driverCommand: '/bin/false',
    actionTimeoutMs: 15_000,
    maxActionsPerRun: 20,
    maxScreenshotsPerRun: 12,
    pauseWhenTargetFrontmost: true,
    defaultAccess: 'background',
    foregroundLeaseSeconds: 30,
    artifactMaxBytes: 16 * 1024 * 1024,
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-qq-personal-'));
  const backend = new FakeQqBackend();
  const manager = new ComputerManager(computerConfig(), backend, root);
  const adapter = new QqPersonalMessageComputerAdapter(manager, root);
  const authorization = {
    eventId: 'event-qq-1',
    channel: 'qq' as const,
    accountFingerprint: qqVisibleAccountFingerprint(account),
    conversationId: qqVisibleConversationId(conversation),
    mode: 'auto' as const,
  };
  return { adapter, authorization, backend, manager };
}

async function scope(): Promise<{
  scope: PersonalMessageScope;
  backend: FakeQqBackend;
  manager: ComputerManager;
}> {
  const { adapter, authorization, backend, manager } = await fixture();
  const probe = await adapter.probe(authorization);
  assert.equal(probe.ready, true);
  return {
    backend,
    manager,
    scope: {
      ...authorization,
      messageMode: authorization.mode,
      capability: probe.capability,
      getContext: (limit, signal) => adapter.getContext(authorization, limit, signal),
      send: ({ text, latestFingerprint }, signal) => adapter.send(
        authorization,
        text,
        latestFingerprint,
        signal,
      ),
    },
  };
}

async function call(tool: { invoke: Function }, input: unknown): Promise<unknown> {
  return tool.invoke(undefined, JSON.stringify(input));
}

test('QQ personal message route reads a bounded stable context without UI actions', async () => {
  const { scope: bound, backend } = await scope();
  const context = await bound.getContext(20);

  assert.equal(context.channel, 'qq');
  assert.equal(context.accountFingerprint, bound.accountFingerprint);
  assert.equal(context.conversationId, bound.conversationId);
  assert.equal(context.coverage, 'bounded');
  assert.deepEqual(context.messages.map((message) => message.direction), ['incoming', 'outgoing']);
  assert.equal(context.truncated, true);
  assert.equal(backend.actions.length, 0);
});

test('QQ personal message route selects one semantic window from contained compositor surfaces', async () => {
  const { adapter, authorization, backend } = await fixture();
  backend.compositeSurfaces = true;

  const context = await adapter.getContext(authorization, 20);

  assert.equal(context.conversationId, authorization.conversationId);
  assert.equal(context.messages.length, 2);
  assert.equal(backend.actions.length, 0);
});

test('QQ personal message route rejects an independent unresolved window', async () => {
  const { adapter, authorization, backend } = await fixture();
  backend.compositeSurfaces = true;
  backend.independentSurface = true;

  await assert.rejects(() => adapter.getContext(authorization, 20), /ambiguous|独立/iu);
  assert.equal(backend.actions.length, 0);
});

test('PersonalMessageHub sends QQ through ComputerManager with fresh observations and post-read', async () => {
  const { scope: bound, backend } = await scope();
  const tools = new PersonalMessageHub().createTools(bound, 'run-qq-1') as Array<{
    name: string;
    invoke: Function;
  }>;
  const context = await call(
    tools.find((candidate) => candidate.name === 'get_personal_message_context')!,
    { limit: 20 },
  ) as Record<string, unknown>;
  const result = await call(
    tools.find((candidate) => candidate.name === 'send_personal_message')!,
    { contextToken: context.contextToken, text: 'confirmed fixture reply' },
  ) as Record<string, unknown>;

  assert.equal(result.status, 'confirmed', JSON.stringify(result));
  assert.equal(result.route, 'computer');
  assert.equal(result.deliveryConfirmed, true);
  assert.deepEqual(backend.actions.map((action) => action.input.action.type), [
    'type_text',
    'keypress',
  ]);
  assert.notEqual(
    'observationId' in backend.actions[0]!.input ? backend.actions[0]!.input.observationId : undefined,
    'observationId' in backend.actions[1]!.input ? backend.actions[1]!.input.observationId : undefined,
  );
  assert.ok(backend.observations >= 6);
});

test('QQ Computer route marks an unconfirmed send uncertain and never replays Return', async () => {
  const { adapter, authorization, backend } = await fixture();
  backend.sendNoop = true;
  const context = await adapter.getContext(authorization, 10);
  const result = await adapter.send(
    authorization,
    'unconfirmed fixture reply',
    context.latestFingerprint,
  );

  assert.equal(result.status, 'uncertain');
  assert.equal(result.deliveryConfirmed, false);
  assert.equal(backend.actions.filter((action) => action.input.action.type === 'keypress').length, 1);
  assert.equal(backend.actions.filter((action) => action.input.action.type === 'type_text').length, 1);
});

test('QQ Computer route protects drafts and owner activity before sending', async () => {
  const draft = await fixture();
  draft.backend.draft = 'owner draft';
  const context = await draft.adapter.getContext(draft.authorization, 10);
  const result = await draft.adapter.send(
    draft.authorization,
    'do not send',
    context.latestFingerprint,
  );
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /draft|草稿/iu);
  assert.equal(draft.backend.actions.length, 0);

  const active = await fixture();
  active.backend.frontmost = true;
  await assert.rejects(
    () => active.adapter.probe(active.authorization),
    /target_in_use|前台/,
  );
  assert.equal(active.backend.actions.length, 0);
});

test('QQ Computer route rejects account and conversation drift without fallback', async () => {
  const { adapter, authorization, backend } = await fixture();
  await assert.rejects(
    () => adapter.probe({
      ...authorization,
      accountFingerprint: qqVisibleAccountFingerprint('another-account'),
    }),
    /account|账号/iu,
  );
  await assert.rejects(
    () => adapter.probe({
      ...authorization,
      conversationId: qqVisibleConversationId('another-conversation'),
    }),
    /conversation|会话/iu,
  );
  assert.equal(backend.actions.length, 0);
});
