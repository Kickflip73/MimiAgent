import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RunContext, type Tool } from '@openai/agents';
import { test } from 'node:test';
import { AttentionEngine } from '../src/daemon/attention.js';
import { createMimiAttentionRuleTools } from '../src/daemon/attention-rule-tools.js';
import { createMimiBriefingTools } from '../src/daemon/briefing-tools.js';
import { createMimiDeliveryTools } from '../src/daemon/delivery-tools.js';
import { createMimiCommandHostTools, createMimiHostTools } from '../src/daemon/host-tools.js';
import { createMimiPeopleTools } from '../src/daemon/people-tools.js';
import { createMimiScheduleTools } from '../src/daemon/schedule-tools.js';
import { createMimiSessionActivityTools } from '../src/daemon/session-activity-tools.js';
import { createMimiSettingsTools } from '../src/daemon/settings-tools.js';
import { createMimiSourcePolicyTools } from '../src/daemon/source-policy-tools.js';
import { createMimiStandingOrderTools } from '../src/daemon/standing-order-tools.js';
import { MimiStore } from '../src/daemon/store.js';
import type { ImmutableEvent, TaskRecord } from '../src/daemon/types.js';
import type { ConnectorManager } from '../src/daemon/connectors.js';

async function invoke(tools: Tool[], name: string, input: unknown): Promise<unknown> {
  const selected = tools.find((candidate) => candidate.name === name);
  assert.ok(selected && 'invoke' in selected && typeof selected.invoke === 'function', `missing ${name}`);
  return selected.invoke(new RunContext({}), JSON.stringify(input));
}

async function fixture(prefix: string): Promise<{
  root: string;
  store: MimiStore;
  attention: AttentionEngine;
  event: ImmutableEvent;
  task: TaskRecord;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const now = new Date().toISOString();
  const event = store.appendEvent({
    id: '00000000-0000-4000-8000-000000000001',
    externalId: 'owner-authority',
    source: 'local-cli',
    type: 'command.received',
    trust: 'owner',
    payload: {},
    profileId: 'owner',
    occurredAt: now,
    receivedAt: now,
  }).event;
  const task = store.enqueueTask({
    id: '00000000-0000-4000-8000-000000000002',
    type: 'background',
    idempotencyKey: 'owner-task',
    authorityEventId: event.id,
    profileId: 'owner',
    sessionKey: 'session-owner',
    objective: { originSessionId: 'session-origin' },
    executor: 'isolated_worker',
    workspaceAccess: 'write',
    priority: 80,
  });
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  return { root, store, attention, event, task };
}

test('owner policy tool families persist exact bounded mutations and remove them', async () => {
  const { store, attention } = await fixture('mimi-host-policy-tools-');
  try {
    const standing = createMimiStandingOrderTools(attention);
    assert.deepEqual(await invoke(standing, 'list_mimi_standing_orders', {}), []);
    assert.deepEqual(await invoke(standing, 'add_mimi_standing_order', { instruction: '先验证再汇报' }), {
      instruction: '先验证再汇报',
      added: true,
    });
    assert.deepEqual(await invoke(standing, 'remove_mimi_standing_order', { instruction: '先验证再汇报' }), {
      instruction: '先验证再汇报',
      removed: true,
    });

    const people = createMimiPeopleTools(attention);
    assert.deepEqual(await invoke(people, 'list_mimi_people', {}), []);
    const person = await invoke(people, 'upsert_mimi_person', {
      id: 'teammate',
      displayName: 'Teammate',
      aliases: [{ source: 'mail', actor: 'teammate@example.invalid' }],
      context: ['项目协作者'],
    }) as { created: boolean };
    assert.equal(person.created, true);
    assert.deepEqual(await invoke(people, 'remove_mimi_person', { id: 'teammate' }), {
      id: 'teammate',
      removed: true,
    });

    const policies = createMimiSourcePolicyTools(attention);
    assert.deepEqual(await invoke(policies, 'list_mimi_source_policies', {}), []);
    const policy = await invoke(policies, 'upsert_mimi_source_policy', {
      id: 'mail-owner',
      source: 'mail',
      actor: 'owner',
      access: 'reply',
      messageMode: 'draft',
      computerAccess: 'none',
      instructions: ['只处理明确请求'],
    }) as { created: boolean };
    assert.equal(policy.created, true);
    assert.deepEqual(await invoke(policies, 'remove_mimi_source_policy', { id: 'mail-owner' }), {
      id: 'mail-owner',
      removed: true,
    });

    const rules = createMimiAttentionRuleTools(attention);
    const created = await invoke(rules, 'upsert_mimi_attention_rule', {
      id: 'urgent-mail',
      source: 'mail',
      minPriority: 90,
      action: 'run',
      reason: 'urgent',
    }) as { created: boolean; position: number };
    assert.equal(created.created, true);
    assert.ok(created.position >= 0);
    assert.equal((await invoke(rules, 'list_mimi_attention_rules', {}) as unknown[]).some(
      (item) => (item as { id?: string }).id === 'urgent-mail',
    ), true);
    assert.deepEqual(await invoke(rules, 'remove_mimi_attention_rule', { id: 'urgent-mail' }), {
      id: 'urgent-mail',
      removed: true,
    });
  } finally {
    store.close();
  }
});

test('settings, snooze, delivery and briefing tools expose their real state transitions', async () => {
  const { store, attention, event, task } = await fixture('mimi-host-settings-tools-');
  try {
    const settingsTools = createMimiSettingsTools(attention);
    const settings = await invoke(settingsTools, 'get_mimi_settings', {}) as {
      owner: { displayName: string };
      budgets: { maxRunsPerHour: number };
    };
    const updated = structuredClone(settings) as Record<string, unknown>;
    (updated.owner as { displayName: string }).displayName = 'Local Owner';
    const saved = await invoke(settingsTools, 'update_mimi_settings', updated) as {
      owner: { displayName: string };
    };
    assert.equal(saved.owner.displayName, 'Local Owner');
    assert.deepEqual(await invoke(settingsTools, 'get_mimi_snooze', {}), { active: false });
    const snoozed = await invoke(settingsTools, 'snooze_mimi', { minutes: 5, reason: 'focus' }) as {
      active: boolean;
      reason?: string;
    };
    assert.equal(snoozed.active, true);
    assert.equal(snoozed.reason, 'focus');
    assert.deepEqual(await invoke(settingsTools, 'clear_mimi_snooze', {}), { active: false });

    const control = { suppressed: false, reason: undefined as string | undefined };
    const delivery = createMimiDeliveryTools(task, event, control);
    assert.equal(delivery.length, 1);
    assert.deepEqual(await invoke(delivery, 'finish_mimi_silently', { reason: 'no material change' }), {
      suppressed: true,
      reason: 'no material change',
    });
    assert.equal(control.suppressed, true);
    assert.equal(createMimiDeliveryTools({ ...task, type: 'conversation' }, event, control).length, 0);

    const briefing = createMimiBriefingTools(attention);
    assert.deepEqual(await invoke(briefing, 'request_mimi_briefing', {}), {
      created: false,
      reason: '当前没有待汇总事项',
    });
  } finally {
    store.close();
  }
});

test('schedule and session tools create, list, filter, cancel, and reject unsafe times', async () => {
  const { store, event, task } = await fixture('mimi-host-schedule-tools-');
  try {
    const tools = createMimiScheduleTools(store, task, event, { channel: 'system' }, 'active-session');
    const routine = await invoke(tools, 'schedule_mimi_routine', {
      name: 'routine',
      prompt: 'check a bounded condition',
      everyMinutes: 5,
    }) as { id: string; type: string; sessionKey?: string };
    assert.equal(routine.type, 'interval');
    assert.equal(routine.sessionKey, 'session-origin');
    const watch = await invoke(tools, 'schedule_mimi_watch', {
      name: 'watch',
      check: 'check status',
      stopWhen: 'status is complete',
      everyMinutes: 10,
    }) as { id: string; type: string; prompt: string };
    assert.equal(watch.type, 'watch');
    assert.match(watch.prompt, /结束条件/);
    const followUp = await invoke(tools, 'schedule_mimi_follow_up', {
      name: 'follow-up',
      prompt: 'continue the work',
      runAt: new Date(Date.now() + 60_000).toISOString(),
    }) as { id: string; type: string };
    assert.equal(followUp.type, 'at');
    assert.equal((await invoke(tools, 'list_mimi_schedules', {}) as unknown[]).length, 3);
    assert.match(String(await invoke(tools, 'schedule_mimi_follow_up', {
      name: 'invalid',
      prompt: 'invalid',
      runAt: 'not-a-date',
    })), /有效/);
    assert.match(String(await invoke(tools, 'schedule_mimi_follow_up', {
      name: 'too-soon',
      prompt: 'invalid',
      runAt: new Date().toISOString(),
    })), /5 秒/);
    assert.deepEqual(await invoke(tools, 'cancel_mimi_schedule', { id: followUp.id }), {
      id: followUp.id,
      removed: true,
    });

    const sessionTools = createMimiSessionActivityTools(store, 'session-origin');
    const activity = await invoke(sessionTools, 'inspect_mimi_session_activity', { limit: 10 }) as unknown[];
    assert.ok(Array.isArray(activity));
    const filtered = await invoke(sessionTools, 'inspect_mimi_session_activity', {
      query: 'non-matching-query',
      limit: 10,
    });
    assert.deepEqual(filtered, []);
    assert.deepEqual(await invoke(sessionTools, 'cancel_interrupted_mimi_task', {
      taskId: task.id,
      reason: 'owner changed direction',
    }), {
      taskId: task.id,
      cancelled: false,
    });

    assert.equal(routine.id === watch.id, false);
  } finally {
    store.close();
  }
});

test('Host composition exposes one catalog and suppresses only a confirmed same-route Connector reply', async () => {
  const { store, attention, event, task } = await fixture('mimi-host-composition-');
  try {
    const commandTools = createMimiCommandHostTools(store, attention, undefined, 'command-session');
    assert.ok(commandTools.some((tool) => tool.name === 'inspect_mimi_activity'));
    assert.ok(commandTools.some((tool) => tool.name === 'schedule_mimi_follow_up'));
    assert.equal(commandTools.some((tool) => tool.name === 'finish_mimi_silently'), false);

    const manager = {
      configPath: '/fixture/connectors.json',
      size: 1,
      listCapabilities: () => [{
        id: 'mail',
        enabled: true,
        online: true,
        readiness: { inbound: 'ready', outbound: 'ready', deliveryConfirmed: true },
        source: 'fixture:mail',
        trust: 'owner',
        actions: [{ name: 'send_message', description: 'send' }],
      }],
      setEnabled: async () => ({ ok: true }),
      reload: async () => [],
      executeAction: async () => ({ outcome: 'confirmed', messageId: 'message-1' }),
    } as unknown as ConnectorManager;
    const control = { suppressed: false, reason: undefined as string | undefined };
    const connectorTools = createMimiHostTools({
      store,
      attention,
      task,
      event,
      deliveryControl: control,
      sessionId: 'session-owner',
      connectors: manager,
      replyRoute: { channel: 'connector:mail', target: 'owner' },
    });
    await invoke(connectorTools, 'connector_action', {
      connector: 'mail',
      action: 'send_message',
      target: 'owner',
      payloadJson: '{}',
    });
    assert.equal(control.suppressed, true);
    assert.match(control.reason ?? '', /抑制重复/);

    const mismatched = { suppressed: false, reason: undefined as string | undefined };
    const mismatchTools = createMimiHostTools({
      store,
      attention,
      task,
      event,
      deliveryControl: mismatched,
      sessionId: 'session-owner',
      connectors: manager,
      replyRoute: { channel: 'connector:mail', target: 'another-target' },
    });
    await invoke(mismatchTools, 'connector_action', {
      connector: 'mail',
      action: 'send_message',
      target: 'owner',
      payloadJson: '{}',
    });
    assert.equal(mismatched.suppressed, false);

    const runtimeTools = createMimiHostTools({
      store,
      attention,
      task,
      event,
      deliveryControl: { suppressed: false },
      sessionId: 'session-owner',
      connectorRuntime: {
        inspectCapabilities: async () => ({
          configFile: '/fixture/connectors.json',
          catalogTotal: 0,
          catalogActions: 0,
          total: 0,
          enabled: 0,
          online: 0,
          inboundReady: 0,
          outboundReady: 0,
          stale: 0,
          actions: 0,
          filterMatched: false,
          availableCapabilities: [],
          truncated: false,
          connectors: [],
        }),
        executeAction: async () => ({ outcome: 'accepted' }),
      },
    });
    assert.equal(runtimeTools.some((tool) => tool.name === 'inspect_mimi_capabilities'), true);
    assert.equal(runtimeTools.some((tool) => tool.name === 'reload_mimi_connectors'), false);
  } finally {
    store.close();
  }
});
