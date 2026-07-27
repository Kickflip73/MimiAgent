import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(repositoryRoot, 'skills', 'qq-messenger-skill', 'scripts', 'send_qq.py');
const skillInstructions = path.join(repositoryRoot, 'skills', 'qq-messenger-skill', 'SKILL.md');

const fakeDriverSource = `#!/usr/bin/env node
import fs from 'node:fs';

const stateFile = process.env.FAKE_CUA_STATE;
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const [, , command, tool, rawPayload] = process.argv;
if (command !== 'call') process.exit(10);
const payload = JSON.parse(rawPayload);
state.calls.push({ tool, payload });
if (state.windowVisible === undefined) {
  state.windowVisible = process.env.FAKE_WINDOW_VISIBLE !== 'false';
}

const input = {
  element_index: 121,
  element_token: 'snapshot:input',
  role: 'AXTextArea',
  label: null,
  value: state.draft || null,
  frame: { x: 697, y: 759, w: 679, h: 110 },
};
const elements = [
  {
    element_index: 34,
    element_token: 'snapshot:contact',
    role: 'AXStaticText',
    label: '我的好乖乖',
    value: '我的好乖乖',
    frame: { x: 511, y: 285, w: 70, h: 16 },
  },
  {
    element_index: 60,
    element_token: 'snapshot:title',
    role: 'AXButton',
    label: state.activeTarget === false ? '其他联系人' : '我的好乖乖',
    value: null,
    frame: { x: 713, y: 236, w: 84, h: 22 },
  },
  {
    element_index: 70,
    element_token: 'snapshot:time',
    role: 'AXStaticText',
    label: '18:10',
    value: '18:10',
    frame: { x: 1010, y: 500, w: 40, h: 16 },
  },
  {
    element_index: 71,
    element_token: 'snapshot:incoming',
    role: 'AXStaticText',
    label: '七点下班吗',
    value: '七点下班吗',
    frame: { x: 717, y: 530, w: 84, h: 16 },
  },
  {
    element_index: 72,
    element_token: 'snapshot:outgoing',
    role: 'AXStaticText',
    label: '可能',
    value: '可能',
    frame: { x: 1260, y: 560, w: 28, h: 16 },
  },
  input,
];
if (state.sent) {
  elements.push({
    element_index: 89,
    element_token: 'snapshot:message',
    role: 'AXStaticText',
    label: state.message,
    value: state.message,
    frame: { x: 1250, y: 676, w: 56, h: 16 },
  });
}

let result = {};
let textResult;
if (tool === 'list_apps') {
  result = {
    apps: [{
      active: state.qqActive === true || process.env.FAKE_QQ_ACTIVE === 'true',
      bundle_id: 'com.tencent.qq',
      name: 'QQ',
      pid: 79493,
      running: true,
    }],
  };
} else if (tool === 'list_windows') {
  result = {
    windows: [{
      app_name: 'QQ',
      bounds: { height: 694, width: 989, x: 391, y: 179 },
      is_on_screen: state.windowVisible,
      on_current_space: true,
      pid: 79493,
      title: 'QQ',
      window_id: 2347,
    }],
  };
} else if (tool === 'launch_app') {
  state.windowVisible = true;
  if (process.env.FAKE_LAUNCH_ACTIVATES === 'true') state.qqActive = true;
  result = {
    pid: 79493,
    self_activation_suppressed: process.env.FAKE_LAUNCH_UNSAFE !== 'true',
  };
} else if (tool === 'hotkey') {
  state.windowVisible = false;
  textResult = '✅ Sent background hotkey.';
} else if (tool === 'get_window_state') {
  result = { elements };
} else if (tool === 'type_text') {
  state.draft = payload.text;
  state.message = payload.text;
  textResult = '✅ Typed into [121] AXTextArea.';
} else if (tool === 'press_key') {
  if (process.env.FAKE_SEND_MODE !== 'noop') {
    state.sent = true;
    state.draft = '';
  }
} else if (tool === 'click') {
  state.activeTarget = true;
} else {
  process.exit(11);
}
fs.writeFileSync(stateFile, JSON.stringify(state));
process.stdout.write(textResult ?? JSON.stringify(result));
`;

async function runSkill(
  sendMode = 'send',
  initialDraft = '',
  environment: Record<string, string> = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-qq-skill-'));
  const fakeDriver = path.join(root, 'fake-cua-driver.mjs');
  const stateFile = path.join(root, 'state.json');
  await writeFile(fakeDriver, fakeDriverSource, 'utf8');
  await chmod(fakeDriver, 0o755);
  await writeFile(stateFile, JSON.stringify({
    calls: [], draft: initialDraft, message: '', sent: false,
  }), 'utf8');
  const result = spawnSync('python3', [
    script, '--to', '好乖乖', '--msg', '我七点下',
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      MIMI_CUA_DRIVER: fakeDriver,
      FAKE_CUA_STATE: stateFile,
      FAKE_SEND_MODE: sendMode,
      MIMI_QQ_USE_DRIVER_HIDE: '1',
      MIMI_QQ_ALLOW_VISIBLE_BACKGROUND: '1',
      ...environment,
    },
  });
  const state = JSON.parse(await readFile(stateFile, 'utf8')) as {
    calls: Array<{ tool: string; payload: Record<string, unknown> }>;
    sent: boolean;
  };
  return { result, state };
}

async function readContext(contact?: string, activeTarget = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-qq-context-'));
  const fakeDriver = path.join(root, 'fake-cua-driver.mjs');
  const stateFile = path.join(root, 'state.json');
  await writeFile(fakeDriver, fakeDriverSource, 'utf8');
  await chmod(fakeDriver, 0o755);
  await writeFile(stateFile, JSON.stringify({
    calls: [], draft: '', message: '', sent: false, activeTarget,
  }), 'utf8');
  const args = [script, '--action', 'context', '--limit', '3'];
  if (contact) args.push('--to', contact);
  const result = spawnSync('python3', args, {
    encoding: 'utf8',
    env: {
      ...process.env,
      MIMI_CUA_DRIVER: fakeDriver,
      FAKE_CUA_STATE: stateFile,
      MIMI_QQ_USE_DRIVER_HIDE: '1',
      MIMI_QQ_ALLOW_VISIBLE_BACKGROUND: '1',
    },
  });
  const state = JSON.parse(await readFile(stateFile, 'utf8')) as {
    calls: Array<{ tool: string; payload: Record<string, unknown> }>;
  };
  return { result, state };
}

async function readStatus(environment: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-qq-status-'));
  const fakeDriver = path.join(root, 'fake-cua-driver.mjs');
  const stateFile = path.join(root, 'state.json');
  await writeFile(fakeDriver, fakeDriverSource, 'utf8');
  await chmod(fakeDriver, 0o755);
  await writeFile(stateFile, JSON.stringify({
    calls: [], draft: '', message: '', sent: false,
  }), 'utf8');
  const result = spawnSync('python3', [script, '--action', 'status'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      MIMI_CUA_DRIVER: fakeDriver,
      FAKE_CUA_STATE: stateFile,
      MIMI_QQ_USE_DRIVER_HIDE: '1',
      MIMI_QQ_ALLOW_VISIBLE_BACKGROUND: '1',
      ...environment,
    },
  });
  const state = JSON.parse(await readFile(stateFile, 'utf8')) as {
    calls: Array<{ tool: string; payload: Record<string, unknown> }>;
  };
  return { result, state };
}

test('QQ skill sends through one deterministic script path and verifies the new message', async () => {
  const { result, state } = await runSkill();

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    status: 'sent',
    target: '我的好乖乖',
    verified: true,
  });
  assert.deepEqual(state.calls.map(({ tool }) => tool), [
    'list_apps',
    'list_windows',
    'get_window_state',
    'list_apps',
    'type_text',
    'get_window_state',
    'list_apps',
    'press_key',
    'list_apps',
    'get_window_state',
  ]);
  const press = state.calls.find(({ tool }) => tool === 'press_key');
  assert.deepEqual(press?.payload, {
    pid: 79493,
    window_id: 2347,
    element_token: 'snapshot:input',
    key: 'return',
    delivery_mode: 'background',
  });
});

test('QQ skill routes an underspecified reply request to QQ context instead of local history', async () => {
  const instructions = await readFile(skillInstructions, 'utf8');

  assert.match(instructions, /回复我的好乖乖QQ消息/);
  assert.match(instructions, /context --to '<联系人>' --limit 20/);
  assert.match(instructions, /不要先查 Session、Activity、Memory、People 或 QQ Connector/);
  assert.match(instructions, /不要因为 Session\/Memory 中没有 QQ 消息就询问/);
  assert.match(instructions, /若为 `outgoing`，说明已经回复/);
});

test('QQ skill reads bounded visible context without any send action', async () => {
  const { result, state } = await readContext();

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    status: 'context',
    target: '我的好乖乖',
    source: 'visible_ax',
    backgroundSafe: true,
    complete: false,
    truncated: false,
    messages: [
      { text: '18:10', kind: 'timestamp', direction: 'unknown' },
      { text: '七点下班吗', kind: 'message', direction: 'incoming' },
      { text: '可能', kind: 'message', direction: 'outgoing' },
    ],
  });
  assert.deepEqual(state.calls.map(({ tool }) => tool), [
    'list_apps',
    'list_windows',
    'get_window_state',
    'list_apps',
  ]);
  assert.equal(state.calls.some(({ tool }) => tool === 'type_text' || tool === 'press_key'), false);
});

test('QQ skill confirms a requested conversation before reading its context', async () => {
  const { result, state } = await readContext('好乖乖', false);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).target, '我的好乖乖');
  assert.deepEqual(state.calls.map(({ tool }) => tool), [
    'list_apps',
    'list_windows',
    'get_window_state',
    'list_apps',
    'click',
    'get_window_state',
    'list_apps',
  ]);
  assert.deepEqual(state.calls.find(({ tool }) => tool === 'click')?.payload, {
    pid: 79493,
    window_id: 2347,
    element_token: 'snapshot:contact',
    delivery_mode: 'background',
  });
  assert.equal(state.calls.some(({ tool }) => tool === 'type_text' || tool === 'press_key'), false);
});

test('QQ skill exposes a fast readiness probe without changing the UI', async () => {
  const { result, state } = await readStatus();

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    status: 'ready',
    target: '我的好乖乖',
    source: 'visible_ax',
    backgroundSafe: true,
  });
  assert.deepEqual(state.calls.map(({ tool }) => tool), [
    'list_apps',
    'list_windows',
    'get_window_state',
    'list_apps',
  ]);
});

test('QQ skill fails closed while the owner is actively using QQ', async () => {
  const { result, state } = await runSkill('send', '', { FAKE_QQ_ACTIVE: 'true' });

  assert.equal(result.status, 1, result.stderr);
  const output = JSON.parse(result.stdout) as { status: string; error: string };
  assert.equal(output.status, 'failed');
  assert.match(output.error, /前台/);
  assert.deepEqual(state.calls.map(({ tool }) => tool), ['list_apps']);
});

test('QQ skill fails closed for a visible background window by default', async () => {
  const { result, state } = await runSkill('send', '', { MIMI_QQ_ALLOW_VISIBLE_BACKGROUND: '0' });

  assert.equal(result.status, 1, result.stderr);
  const output = JSON.parse(result.stdout) as { status: string; error: string };
  assert.equal(output.status, 'failed');
  assert.match(output.error, /窗口当前可见/);
  assert.equal(state.calls.some(({ tool }) => tool === 'get_window_state'), false);
});

test('QQ skill acquires and restores a hidden window without foreground activation', async () => {
  const { result, state } = await readStatus({ FAKE_WINDOW_VISIBLE: 'false' });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'ready');
  assert.deepEqual(state.calls.map(({ tool }) => tool), [
    'list_apps',
    'list_windows',
    'launch_app',
    'list_apps',
    'list_windows',
    'get_window_state',
    'list_apps',
    'list_apps',
    'hotkey',
    'list_apps',
    'list_windows',
  ]);
  assert.deepEqual(state.calls.find(({ tool }) => tool === 'launch_app')?.payload, {
    bundle_id: 'com.tencent.qq',
    creates_new_application_instance: false,
  });
  assert.deepEqual(state.calls.find(({ tool }) => tool === 'hotkey')?.payload, {
    pid: 79493,
    window_id: 2347,
    keys: ['cmd', 'h'],
    delivery_mode: 'background',
  });
});

test('QQ skill fails closed and restores state when a hidden-window lease cannot prove focus safety', async () => {
  const { result, state } = await readStatus({
    FAKE_WINDOW_VISIBLE: 'false',
    FAKE_LAUNCH_UNSAFE: 'true',
  });

  assert.equal(result.status, 1, result.stderr);
  const output = JSON.parse(result.stdout) as { status: string; error: string };
  assert.equal(output.status, 'failed');
  assert.match(output.error, /无法证明.*没有抢占前台/);
  assert.equal(state.calls.some(({ tool }) => tool === 'get_window_state'), false);
  assert.equal(state.calls.filter(({ tool }) => tool === 'hotkey').length, 1);
});

test('QQ skill does not hide the app if the owner starts using it during lease acquisition', async () => {
  const { result, state } = await readStatus({
    FAKE_WINDOW_VISIBLE: 'false',
    FAKE_LAUNCH_ACTIVATES: 'true',
  });

  assert.equal(result.status, 1, result.stderr);
  const output = JSON.parse(result.stdout) as { status: string; error: string };
  assert.equal(output.status, 'failed');
  assert.match(output.error, /前台/);
  assert.equal(state.calls.some(({ tool }) => tool === 'hotkey'), false);
});

test('QQ skill reports an uncertain send once without retrying', async () => {
  const { result, state } = await runSkill('noop');

  assert.equal(result.status, 2, result.stderr);
  const output = JSON.parse(result.stdout) as { status: string; error: string };
  assert.equal(output.status, 'uncertain');
  assert.match(output.error, /不会自动重试/);
  assert.equal(state.sent, false);
  assert.equal(state.calls.filter(({ tool }) => tool === 'press_key').length, 1);
  assert.equal(state.calls.filter(({ tool }) => tool === 'type_text').length, 1);
});

test('QQ skill preserves a non-empty user draft and refuses to send', async () => {
  const { result, state } = await runSkill('send', '我不');

  assert.equal(result.status, 1, result.stderr);
  const output = JSON.parse(result.stdout) as { status: string; error: string };
  assert.equal(output.status, 'failed');
  assert.match(output.error, /输入框已有内容/);
  assert.equal(state.calls.some(({ tool }) => tool === 'type_text' || tool === 'press_key'), false);
});
