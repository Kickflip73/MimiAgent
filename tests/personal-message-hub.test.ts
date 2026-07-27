import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PersonalMessageHub, type PersonalMessageScope } from '../src/runtime/personal-message-hub.js';

const accountFingerprint = `sha256:${'a'.repeat(64)}`;
const latestFingerprint = `sha256:${'b'.repeat(64)}`;

function scope(overrides: Partial<PersonalMessageScope> = {}): PersonalMessageScope {
  return {
    eventId: 'event-1',
    channel: 'daxiang',
    accountFingerprint,
    conversationId: 'daxiang:account:123',
    messageMode: 'auto',
    capability: {
      accountVerified: true,
      inboundCoverage: 'bounded',
      contextRead: 'stable',
      sendRoute: 'connector',
      deliveryConfirmed: false,
      backgroundSafe: true,
      changesReadState: 'unknown',
      stableConversationId: true,
      stableMessageId: true,
      probedAt: new Date().toISOString(),
    },
    getContext: async () => ({
      channel: 'daxiang',
      accountFingerprint,
      conversationId: 'daxiang:account:123',
      coverage: 'bounded',
      observedAt: new Date().toISOString(),
      latestFingerprint,
      messages: [{ id: '1', direction: 'incoming', text: 'hello' }],
      truncated: false,
    }),
    send: async () => ({
      status: 'observed',
      route: 'browser',
      deliveryConfirmed: false,
      accountVerified: true,
      targetVerified: true,
    }),
    ...overrides,
  };
}

async function call(tool: { invoke: Function }, input: unknown): Promise<unknown> {
  return tool.invoke(undefined, JSON.stringify(input));
}

test('context tokens bind run and target and are consumed once', async () => {
  let sends = 0;
  const hub = new PersonalMessageHub();
  const tools = hub.createTools(scope({ send: async () => {
    sends += 1;
    return {
      status: 'observed', route: 'browser', deliveryConfirmed: false,
      accountVerified: true, targetVerified: true,
    };
  } }), 'run-1') as Array<{ name: string; invoke: Function }>;
  const contextTool = tools.find((tool) => tool.name === 'get_personal_message_context')!;
  const sendTool = tools.find((tool) => tool.name === 'send_personal_message')!;
  const context = await call(contextTool, { limit: 30 }) as Record<string, unknown>;
  assert.equal(typeof context.contextToken, 'string');
  const sent = await call(sendTool, { contextToken: context.contextToken, text: '收到，谢谢' }) as Record<string, unknown>;
  assert.equal(sent.status, 'observed');
  const replay = await call(sendTool, { contextToken: context.contextToken, text: '收到，谢谢' });
  assert.match(JSON.stringify(replay), /已消费/);
  assert.equal(sends, 1);
});

test('draft scopes receive context but no send tool', () => {
  const names = new PersonalMessageHub().createTools(scope({ messageMode: 'draft' }), 'run-1')
    .map((tool) => tool.name);
  assert.deepEqual(names, ['get_personal_message_context']);
});

test('confirm scopes send only the exact owner-approved text', async () => {
  let sends = 0;
  const tools = new PersonalMessageHub().createTools(scope({
    messageMode: 'confirm',
    approvedText: '唯一确认文本',
    send: async () => {
      sends += 1;
      return {
        status: 'observed', route: 'browser', deliveryConfirmed: false,
        accountVerified: true, targetVerified: true,
      };
    },
  }), 'run-confirm') as Array<{ name: string; invoke: Function }>;
  const context = await call(
    tools.find((tool) => tool.name === 'get_personal_message_context')!,
    { limit: 1 },
  ) as Record<string, unknown>;
  const mismatch = await call(tools.find((tool) => tool.name === 'send_personal_message')!, {
    contextToken: context.contextToken,
    text: '被改写的文本',
  });
  assert.match(JSON.stringify(mismatch), /最终文本不一致/);
  assert.equal(sends, 0);
  const sent = await call(tools.find((tool) => tool.name === 'send_personal_message')!, {
    contextToken: context.contextToken,
    text: '唯一确认文本',
  }) as Record<string, unknown>;
  assert.equal(sent.status, 'observed');
  assert.equal(sends, 1);
});

test('high-risk auto text is not executed', async () => {
  let sends = 0;
  const tools = new PersonalMessageHub().createTools(scope({ send: async () => {
    sends += 1;
    throw new Error('must not execute');
  } }), 'run-1') as Array<{ name: string; invoke: Function }>;
  const context = await call(tools.find((tool) => tool.name === 'get_personal_message_context')!, { limit: 1 }) as Record<string, unknown>;
  const result = await call(tools.find((tool) => tool.name === 'send_personal_message')!, {
    contextToken: context.contextToken,
    text: '我承诺今天上线生产',
  }) as Record<string, unknown>;
  assert.equal(result.status, 'not_executed');
  assert.equal(sends, 0);
});
