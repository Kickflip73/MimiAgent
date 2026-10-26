// Optional browser check: use a locally installed Playwright, never real user data or a model.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { MimiWebServer } from '../dist/web/server.js';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.MIMI_PLAYWRIGHT_PATH || 'playwright');
const now = new Date().toISOString();
const sessions = [
  {
    id: 'session-existing',
    title: '一份清晰的调研报告',
    preview: '整理项目资料',
    updatedAt: now,
    turns: 2,
  },
];
const conversations = new Map([
  [
    'session-existing',
    [
      { role: 'user', content: '整理项目资料' },
      {
        role: 'assistant',
        content: '报告已整理。\n\n- 保留来源\n- 标注待核实内容',
      },
    ],
  ],
]);
const tasks = [
  {
    taskId: 'background-1',
    status: 'running',
    objective: '整理资料并准备交付',
    updatedAt: now,
    checkpoint: { nextAction: '正在核对来源', updatedAt: now },
    originSessionId: 'session-existing',
  },
  {
    taskId: 'completed-1',
    status: 'completed',
    objective: '检查项目变更',
    updatedAt: now,
    result: { answer: '已核对 3 个来源。' },
  },
];
const requests = new Map();
let finish = false,
  fail = false,
  offline = false,
  mode = 'general',
  selectedModel = null;
const backend = {
  status: async () => {
    if (offline) throw new Error('测试后台离线');
    return {
      buildVersion: 'browser-test',
      securityProfile: {id: 'full-owner'},
      tasks: {},
      enabledSchedules: 0,
      connectorCount: 0,
      workspaceRoot: '/test-workspace',
    };
  },
  sessions: async () => sessions,
  session: async (id, draft) => ({
    sessionId: id,
    draft,
    provider: 'test',
    model: 'test-model',
    mode: { general: '通用', plan: 'Plan', ultra: 'Ultra Team' }[mode],
    items: conversations.get(id) || [],
    plan: [],
    contextUsed: 10,
    contextWindow: 1000,
    workspaceRoot: '/test-workspace',
  }),
  context: async () => ({ contextWindow: 1000, lastRequestInputTokens: 200, estimatedTokens: 180, inputBudget: 800, outputReserve: 200, rawTokens: 300, effectiveTokens: 100, archiveTokens: 40, historyItems: 6, compressionCount: 1, sections: [{id:'base-instructions',estimatedTokens:40},{id:'recent-history',estimatedTokens:100},{id:'tool-schemas',estimatedTokens:40}] }),
  history: async (id) => conversations.get(id) || [],
  submit: async (id, input, requestId) => {
    if (!requests.has(requestId)) {
      requests.set(requestId, { id, input });
      conversations.set(id, [
        ...(conversations.get(id) || []),
        { role: 'user', content: input },
      ]);
    }
    return { eventId: requestId, inserted: true };
  },
  stream: async (id, after) => {
    const req = requests.get(id);
    if (!req) return { events: [] };
    if (finish) {
      if (!conversations.get(req.id).some((i) => i.content === '任务完成。'))
        conversations
          .get(req.id)
          .push({ role: 'assistant', content: '任务完成。' });
      return {
        events: [],
        task: {
          id,
          status: fail ? 'failed' : 'completed',
          result: { answer: fail ? undefined : '任务完成。' },
          error: fail ? '测试失败原因' : undefined,
        },
      };
    }
    return {
      events:
        after < 1
          ? [
              {
                sequence: 1,
                eventId: id,
                kind: 'answer',
                text: '正在整理内容…',
              },
            ]
          : [],
      nextSequence: 1,
      task: { id, status: 'running' },
    };
  },
  tasks: async () => tasks,
  task: async (id) => tasks.find((t) => t.taskId === id),
  taskAction: async (id, action) => {
    const t = tasks.find((t) => t.taskId === id);
    if (t)
      t.status = { pause: 'paused', resume: 'queued', cancel: 'cancelled' }[
        action
      ];
    else {
      finish = true;
      fail = true;
    }
    return {
      state: { pause: 'paused', resume: 'resumed', cancel: 'cancelled' }[
        action
      ],
    };
  },
  memory: async () => [
    {
      ref: { id: 'memory-1', scope: 'private' },
      title: '偏好先看结论',
      summary: '清晰简洁，保留依据。',
    },
  ],
  memoryRead: async () => ({
    metadata: { title: '偏好先看结论', status: 'active', updatedAt: now },
    body: '先给结论，再说明依据。',
  }),
  manageRead: async (area) => area === 'settings' ? { mode: 'general', outputLevel: 'tools', expandExecution: false } : { status: { buildVersion: 'browser-test' }, runtime: {} },
  models: async () => ({ choices: [{ kind: 'agent', capabilities: { toolCalling: true }, target: { providerId: 'test', modelId: 'test-model' }, provider: { label: 'Test' }, configured: true }], current: { sessionTarget: selectedModel, next: { target: selectedModel || { providerId: 'test', modelId: 'test-model' } } } }),
  model: async (_id, target) => { selectedModel = target; return { effective: 'next_run' }; },
  mode: async (_id, next) => {
    mode = next;
  },
};
const server = new MimiWebServer(backend, 0);
await server.start();
const browser = await chromium.launch({
  headless: true,
  ...(process.env.MIMI_BROWSER_EXECUTABLE
    ? { executablePath: process.env.MIMI_BROWSER_EXECUTABLE }
    : {}),
});
const errors = [];
let checks = 0;
const pass = (name) => {
  checks++;
  console.log(`PASS ${name}`);
};
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(server.launchUrl);
  await page.waitForFunction(() =>
    document.querySelector('#connection').textContent.includes('已连接'),
  );
  assert.equal(new URL(page.url()).hash, '');
  assert.equal(await page.evaluate(() => document.cookie), '');
  pass('opens directly without credentials or a session cookie');
  assert.equal(await page.locator('[data-prompt]').count(), 0);
  pass('home has no fixed suggestion buttons');
  await page.locator('[data-session="session-existing"]').click();
  await page.getByText('报告已整理。', { exact: false }).waitFor();
  pass('session switching restores canonical history');
  await page.locator('#new-chat').click();
  await page.waitForFunction(() => !document.querySelector('#mode').disabled);
  await page.getByRole('button', { name: '工作模式', exact: true }).click();
  await page.getByRole('option', { name: '只读规划 先分析与规划，不修改内容' }).click();
  await page.waitForFunction(() =>
    document.querySelector('.picker-mode .picker-trigger').getAttribute('aria-busy') === 'false',
  );
  assert.equal(mode, 'plan');
  pass('mode switch reaches daemon adapter');
  await page.getByRole('button', { name: '选择模型', exact: true }).click();
  await page.getByRole('option', { name: 'test-model · Test', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.picker-model .picker-trigger').getAttribute('aria-busy') === 'false');
  assert.deepEqual(selectedModel, { providerId: 'test', modelId: 'test-model' });
  pass('model switch persists the provider-aware target');
  assert.ok(await page.locator('#message-input').evaluate(el => el.getBoundingClientRect().height <= 30));
  await page.locator('#message-input').fill(Array.from({ length: 20 }, () => '多行输入').join('\n'));
  assert.ok(await page.locator('#message-input').evaluate(el => el.clientHeight <= 200 && el.scrollHeight > el.clientHeight));
  await page.locator('#message-input').fill('短消息');
  assert.ok(await page.locator('#message-input').evaluate(el => el.getBoundingClientRect().height <= 30));
  pass('composer grows to a scrollable cap and shrinks with content');
  await page
    .locator('#message-input')
    .fill('<img src=x onerror="window.__xss=1">');
  await page.locator('#send').click();
  await page.getByText('正在整理内容…', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  assert.equal(requests.size, 1);
  pass('message submit and streaming; untrusted markup rendered as text');
  assert.equal(await page.locator('#run-status').count(), 0);
  assert.equal(await page.locator('#send').getAttribute('aria-label'), '停止生成');
  assert.equal(await page.locator('#send').isEnabled(), true);
  assert.equal(await page.locator('#composer-cat').evaluate(el => el.classList.contains('is-running')), true);
  assert.match(await page.locator('#run-elapsed').innerText(), /s$/);
  assert.equal(await page.locator('.composer-actions #context-indicator').isVisible(), true);
  const userBox = await page.locator('.message.user .message-content').last().boundingBox();
  const assistantBox = await page.locator('.message.assistant .message-content').last().boundingBox();
  assert.ok(userBox.x > assistantBox.x);
  pass('right-aligned owner message; run activity exists only in the composer');
  await page.reload();
  await page.getByText('正在整理内容…', { exact: true }).waitFor();
  assert.equal(requests.size, 1);
  pass('refresh resumes stream without submitting again');
  finish = true;
  await page.getByText('任务完成。', { exact: true }).waitFor();
  await page.waitForFunction(
    () => document.querySelector('#send').getAttribute('aria-label') === '发送消息',
  );
  assert.equal(await page.locator('#composer-cat').evaluate(el => el.classList.contains('is-running')), false);
  assert.equal(await page.locator('#run-elapsed').isVisible(), false);
  const copy = page.getByRole('button', { name: '复制回答', exact: true }).last();
  assert.equal(await copy.innerText(), '');
  assert.equal(await copy.locator('svg').count(), 1);
  pass('terminal receipt settles chat and restores the send arrow; copy is icon-only');
  await page.locator('[data-view="tasks"]').click();
  await page.locator('[data-task="background-1"]').click();
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await page.getByRole('button', { name: '继续处理', exact: true }).waitFor();
  assert.equal(tasks[0].status, 'paused');
  await page.locator('#resume-context').fill('请继续核对');
  await page.getByRole('button', { name: '继续处理', exact: true }).click();
  await page.getByRole('button', { name: '暂停', exact: true }).waitFor();
  assert.equal(tasks[0].status, 'queued');
  await page.getByRole('button', { name: '取消任务', exact: true }).click();
  await page.getByRole('button', { name: '确认取消任务', exact: true }).click();
  await page
    .locator('#detail-content')
    .getByText('已取消', { exact: true })
    .waitFor();
  assert.equal(tasks[0].status, 'cancelled');
  await page.locator('#close-dialog').click();
  pass('task detail, pause, resume with context, and cancel');
  await page.locator('[data-filter="completed"]').click();
  assert.equal(await page.locator('.task-row').count(), 1);
  await page.locator('[data-task="completed-1"]').click();
  await page.getByText('已核对 3 个来源。', { exact: true }).waitFor();
  await page.locator('#close-dialog').click();
  pass('task filtering and real result view');
  await page.locator('[data-view="memory"]').click();
  await page.locator('[data-memory="memory-1"]').click();
  await page.getByText('先给结论，再说明依据。', { exact: true }).waitFor();
  await page.locator('#close-dialog').click();
  pass('memory list and canonical detail');
  await page.locator('[data-view="status"]').click();
  await page.getByText('browser-test', { exact: true }).waitFor();
  pass('workspace status');
  offline = true;
  await page.locator('#refresh').click();
  await page.waitForFunction(() =>
    document.querySelector('#connection').textContent.includes('后台暂不可用'),
  );
  assert.ok((await page.locator('#banner').innerText()).includes('离线'));
  pass('offline is visible, not a fake online state');
  offline = false;
  await page.locator('#refresh').click();
  await page.waitForFunction(() =>
    document.querySelector('#connection').textContent.includes('已连接'),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#mobile-menu').click();
  await page.locator('#new-chat').click();
  await page.locator('#welcome').waitFor();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  assert.equal(
    await page
      .locator('#sidebar')
      .evaluate((el) => el.classList.contains('open')),
    false,
  );
  pass('mobile navigation and no horizontal overflow');
  if (process.env.MIMI_WEB_SCREENSHOT_DIR) {
    await page.waitForFunction(
      () =>
        document.querySelector('#sidebar').getBoundingClientRect().right <= 0,
    );
    await page.waitForTimeout(500);
    await page.locator('#toast').evaluate((el) => {
      el.hidden = true;
    });
    await page.screenshot({
      path: `${process.env.MIMI_WEB_SCREENSHOT_DIR}/Mimi-Web-手机.png`,
      fullPage: true,
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({
      path: `${process.env.MIMI_WEB_SCREENSHOT_DIR}/Mimi-Web-桌面-测试数据.png`,
      fullPage: true,
    });
  }
  assert.deepEqual(errors, []);
  pass('no browser JavaScript errors');
  console.log(`${checks} browser checks passed`);
} finally {
  await browser.close();
  await server.close();
}
