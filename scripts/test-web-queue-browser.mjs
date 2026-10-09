// Optional browser check: use a locally installed Playwright, never real user data or a model.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { MimiWebServer } from '../src/web/server.ts';
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

// Queue regression fixture. No user data, daemon or model calls.
let brokenStream = false;
const cancellations = [];
const originalStream = backend.stream;
backend.stream = async (id, after) => {
  if (brokenStream) throw new Error('event.stream fixture timeout');
  return originalStream(id, after);
};
backend.taskAction = async (id, action) => { cancellations.push({id,action}); return {state:'cancelled'}; };
conversations.set('session-existing', [
  {role:'user',content:'整理项目资料',timestamp:now,timestampSource:'run-start',timelineRunId:'saved-run'},
  {role:'assistant',content:'报告已整理。',timestamp:now,timestampSource:'run-end',timelineRunId:'saved-run',duration:65000,execution:{id:'saved-run',status:'completed',truncated:true,steps:[{kind:'reasoning',text:'先核对来源'},{kind:'status',tone:'tool',title:'read_file',fullDetail:'已读取测试文件'}]}},
  {role:'user',content:'已中断的任务',execution:{id:'cancelled-run',status:'cancelled',steps:[{kind:'status',tone:'tool',title:'list_directory',fullDetail:'已列出目录'}]}}
]);
const server = new MimiWebServer(backend, 0);
await server.start();
const browser = await chromium.launch({ headless:true, ...(process.env.MIMI_BROWSER_EXECUTABLE ? {executablePath:process.env.MIMI_BROWSER_EXECUTABLE} : {}) });
try {
  const page = await browser.newPage({viewport:{width:1440,height:1000}});
  const errors=[]; page.on('pageerror',error=>errors.push(error.message));
  page.on('dialog',()=>{throw new Error('Queue must use inline editing');});
  await page.goto(server.launchUrl);
  await page.waitForFunction(()=>document.querySelector('#connection').textContent.includes('已连接'));
  await page.locator('[data-session="session-existing"]').click();
  await page.getByText('报告已整理。',{exact:true}).waitFor();
  assert.equal(await page.locator('.execution').count(),2);
  assert.equal(await page.locator('.orphan-execution .execution').count(),1);
  await page.locator('.message.assistant .execution summary').click();
  await page.getByText('先核对来源',{exact:true}).waitFor();
  await page.getByText('部分执行过程未完整加载',{exact:true}).waitFor();
  assert.match(await page.locator('.message.assistant .message-footer').innerText(),/1m 05s/);
  assert.match(await page.locator('.message.assistant .message-footer time').getAttribute('title'),/本轮结束/);
  console.log('PASS canonical history time, duration, reasoning and interrupted tool steps without browser cache');
  await page.locator('#new-chat').click();
  await page.waitForFunction(()=>!document.querySelector('#mode').disabled);
  await page.locator('#message-input').fill('正在执行的测试任务');
  await page.locator('#send').click();
  await page.getByText('正在整理内容…',{exact:true}).waitFor();
  await page.locator('#message-input').fill('这是一条需要等待前一个任务结束后自动发送的消息，文字很长时保持单行省略。');
  await page.locator('#send').click();
  await page.locator('.queued-message').waitFor();
  assert.ok((await page.locator('#message-queue').boundingBox()).height < 85);
  await page.getByRole('button',{name:'编辑待发送消息',exact:true}).click();
  await page.getByRole('textbox',{name:'编辑待发送消息',exact:true}).fill('修改后的待发送消息');
  assert.equal(await page.getByRole('textbox',{name:'编辑待发送消息',exact:true}).evaluate(el=>getComputedStyle(el).borderRadius),'8px');
  if(process.env.MIMI_WEB_SCREENSHOT_DIR) await page.screenshot({path:process.env.MIMI_WEB_SCREENSHOT_DIR+'/queue-edit.png'});
  await page.getByRole('button',{name:'保存修改',exact:true}).click();
  await page.locator('.queued-message p').filter({hasText:'修改后的待发送消息'}).waitFor();
  assert.equal(requests.size,1);
  if(process.env.MIMI_WEB_SCREENSHOT_DIR) await page.screenshot({path:process.env.MIMI_WEB_SCREENSHOT_DIR+'/queue-compact.png'});
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  if(process.env.MIMI_WEB_SCREENSHOT_DIR) await page.screenshot({path:process.env.MIMI_WEB_SCREENSHOT_DIR+'/queue-mobile.png'});
  console.log('PASS compact inline queue, editing, saving and mobile width');
  // Observation fails, but cancellation and submission still work immediately.
  brokenStream=true;
  await page.getByRole('button',{name:'立即发送',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#message-queue').hidden,{},{timeout:3000});
  assert.equal(cancellations.length,1); assert.equal(requests.size,2);
  assert.equal([...requests.values()].at(-1).input,'修改后的待发送消息');
  assert.equal(await page.locator('.queue-error').count(),0);
  await page.reload();
  await page.waitForFunction(()=>document.querySelector('#connection').textContent.includes('已连接'));
  assert.equal(requests.size,2);
  assert.deepEqual(errors,[]);
  console.log('PASS send-now ignores failed event.stream observation; reload never resubmits accepted request');
} finally {await browser.close(); await server.close();}
