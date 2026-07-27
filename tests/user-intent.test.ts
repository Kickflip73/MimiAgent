import assert from 'node:assert/strict';
import test from 'node:test';
import {
  capabilityDisclosureForInput,
  explicitlyRequestsMemory,
  explicitlyRequestsSessionAccess,
  explicitlyRequestsSessionClear,
} from '../src/core/user-intent.js';
import { decideEvent } from '../src/daemon/policy.js';

test('requires affirmative long-term memory write intent', () => {
  for (const input of ['请记住我喜欢简洁输出', 'remember this for later', 'I want you to remember my preference']) {
    assert.equal(explicitlyRequestsMemory(input), true, input);
  }
  for (const input of [
    '不要记住我的密码', '我不想让你记住我的密码', '你还记住我什么？',
    'please do not remember this password', "I don't want you to remember my password",
    "please don't ever remember this",
  ]) assert.equal(explicitlyRequestsMemory(input), false, input);
});

test('rejects negated Session access and destructive clear intent', () => {
  for (const input of ['查看会话列表', 'switch session to demo', '/sessions']) {
    assert.equal(explicitlyRequestsSessionAccess(input), true, input);
  }
  for (const input of ['不要查看其他会话', '不要切换会话', "don't show sessions", 'do not switch sessions']) {
    assert.equal(explicitlyRequestsSessionAccess(input), false, input);
  }
  for (const input of ['请清空当前会话', 'please clear the current session', '/clear']) {
    assert.equal(explicitlyRequestsSessionClear(input), true, input);
  }
  for (const input of [
    '我不想让你清空当前会话', "I don't want you to clear the current session",
    "please don't ever delete this chat",
  ]) assert.equal(explicitlyRequestsSessionClear(input), false, input);
});

test('progressively discloses capabilities for owner conversation input', () => {
  assert.equal(capabilityDisclosureForInput('咋样了？'), 'status');
  assert.equal(capabilityDisclosureForInput('为什么天空是蓝色的？'), 'lightweight');
  assert.equal(capabilityDisclosureForInput('为什么 Computer Use 工具当前不可用？'), 'runtime');
  assert.equal(capabilityDisclosureForInput('搜索一下今天上海的天气'), 'web');
  assert.equal(capabilityDisclosureForInput('切换到上一个会话'), 'session');
  assert.equal(capabilityDisclosureForInput('我们上次开发的游戏怎么样了？'), 'full');
  assert.equal(capabilityDisclosureForInput('上次那个后台任务到哪了？'), 'full');
  for (const input of [
    '修复这个问题',
    '读取 src/index.ts 并分析调用链',
    '打开计算器并点击 AC',
    '给 Alice 发一封邮件',
    '请记住我喜欢简洁输出',
    '回顾之前会话里我们确定的方案',
    '继续刚才的任务',
    '看看 README',
    '帮我看看这个报错',
    '把它弄好',
    '查下这个 bug',
    '暂停刚才的后台任务',
    '搜索代码里的 TODO',
    '解释 src/index.ts 的逻辑',
    '总结 https://example.com/report',
    '为什么GitHub直连不通？你试一下。',
    'Mail Connector 失败，你不会检查一下运行状态么？',
    '帮我看看有哪些未读邮件',
    '查看修复进度并继续修改代码',
    '切换到上个会话，然后修复这个问题',
  ]) assert.equal(capabilityDisclosureForInput(input), 'full', input);
  for (const input of [
    '如何修复 TypeScript 类型错误？',
    '怎么配置 Git？',
    '解释为什么执行测试很慢',
    '你试着解释一下这个概念',
  ]) assert.equal(capabilityDisclosureForInput(input), 'lightweight', input);
  assert.equal(capabilityDisclosureForInput('你现在用的什么模型？'), 'session');
  assert.equal(capabilityDisclosureForInput('列出后台任务'), 'status');
});

test('owner status questions expose only background inspection tools to the model', () => {
  const now = new Date().toISOString();
  const decision = decideEvent({
    id: 'event-status', externalId: 'external-status', source: 'local-cli', kind: 'command',
    trust: 'owner', payload: '咋样了？', profileId: 'owner', occurredAt: now, receivedAt: now,
    priority: 100,
  });

  assert.deepEqual(decision.options?.policy?.allowedTools, [
    'list_background_tasks', 'inspect_background_task',
  ]);
  assert.equal(decision.options?.policy?.allowSideEffects, false);
  assert.equal(decision.options?.policy?.allowMcp, false);
});

test('runtime capability questions can inspect the actual runtime without broad tool access', () => {
  const now = new Date().toISOString();
  const decision = decideEvent({
    id: 'event-runtime', externalId: 'external-runtime', source: 'local-cli', kind: 'command',
    trust: 'owner', payload: '为什么 Computer Use 工具当前不可用？', profileId: 'owner',
    occurredAt: now, receivedAt: now, priority: 100,
  });

  assert.deepEqual(decision.options?.policy?.allowedTools, ['runtime_status']);
  assert.equal(decision.options?.policy?.allowSideEffects, false);
  assert.equal(decision.options?.policy?.allowMcp, false);
});
