import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { runProbeAgent } from './lib/computer-probe-agent.js';
import { CuaDriverClient } from '../src/extensions/computer/cua-driver-client.js';

const exec = promisify(execFile);
const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-grounding-probe-'));
const driver = process.env.MIMI_CUA_DRIVER_COMMAND ?? path.join(os.homedir(), '.local/bin/cua-driver');
const session = `mimi-probe-${process.pid}`;
async function call(name: string, args: object): Promise<Record<string, any>> {
  const { stdout } = await exec(driver, ['call', name, JSON.stringify(args)], { timeout: 15_000, maxBuffer: 16 * 1024 * 1024 });
  const raw = JSON.parse(stdout);
  assert.notEqual(raw.isError, true, `${name} failed: ${JSON.stringify(raw.content)}`);
  return raw.structuredContent ?? raw;
}
async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await delay(50);
  }
  throw new Error('Probe condition timed out');
}
const bundle = path.join(root, 'MimiGroundingProbe.app');
const binary = path.join(bundle, 'Contents/MacOS/MimiGroundingProbe');
const receipt = path.join(root, 'receipt.json');
const command = path.join(root, 'command');
let child: ReturnType<typeof spawn> | undefined;
try {
  await mkdir(path.dirname(binary), { recursive: true });
  await writeFile(path.join(bundle, 'Contents/Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.mimi.grounding-probe</string><key>CFBundleName</key><string>MimiGroundingProbe</string><key>CFBundleExecutable</key><string>MimiGroundingProbe</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>');
  await exec('xcrun', ['swiftc', fileURLToPath(new URL('../tests/fixtures/computer-grounding-probe.swift', import.meta.url)), '-o', binary], { timeout: 60_000 });
  child = spawn(binary, [receipt, command], { stdio: 'ignore' });
  const pid = child.pid;
  assert.ok(pid);
  await until(async () => {
    const value = await readFile(receipt, 'utf8').then(JSON.parse).catch(() => undefined);
    return value?.ready ? value : undefined;
  });
  const window = await until(async () => {
    const result = await call('list_windows', { on_screen_only: false });
    return (Array.isArray(result) ? result : result.windows ?? []).find((item: any) => item.pid === pid && item.title === 'Mimi Grounding Probe');
  });
  if (process.env.MIMI_PROBE_AGENT === '1') {
    await until(async () => {
      const result = await call('list_apps', {});
      return (result.apps ?? []).find((item: {pid?: number; bundle_id?: string}) => item.pid === pid && item.bundle_id === 'dev.mimi.grounding-probe');
    });
  }
  await writeFile(command, 'control');
  const control = await until(async () => { const value = JSON.parse(await readFile(receipt, 'utf8')); return value.hits > 0 ? value : undefined; });
  assert.equal(control.hits, 1, 'One calibration event must count exactly once');
  process.stderr.write(JSON.stringify({ stage: 'control', method: process.env.MIMI_PROBE_SURFACE === 'web' ? 'DOM dispatchEvent' : 'NSApplication.sendEvent', receipt: control }) + '\n');
  await call('start_session', { session, capture_scope: 'window' });
  const evidence = [];
  const iterations = Number(process.env.MIMI_PROBE_ITERATIONS ?? 10);
  assert.ok(Number.isInteger(iterations) && iterations >= 2 && iterations <= 50);
  for (let iteration = 0; iteration < iterations; iteration++) {
    const moved = iteration >= Math.floor(iterations / 2);
    if (iteration === Math.floor(iterations / 2)) {
      await writeFile(command, 'move');
      await until(async () => {
        const result = await call('list_windows', { on_screen_only: false });
        const now = (Array.isArray(result) ? result : result.windows ?? []).find((item: any) => item.pid === pid && item.window_id === window.window_id);
        return now?.bounds?.x !== window.bounds.x ? now : undefined;
      });
    }
    const before = JSON.parse(await readFile(receipt, 'utf8'));
    const shot = await call('get_window_state', { session, pid, window_id: window.window_id, include_screenshot: true });
    const png = Buffer.from(shot.screenshot_png_b64 ?? '', 'base64');
    assert.equal(png.subarray(1, 4).toString(), 'PNG', `Probe needs a proven window screenshot: ${JSON.stringify(shot.screenshot_error ?? shot.error ?? shot).slice(0, 8000)}`);
    const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
    assert.ok(Math.abs(width / before.width - height / before.height) < 0.01,
      'Screenshot geometry must match the fixture window before any click');
    // Only the oracle knows the fixture's logical geometry. Production uses image pixels directly.
    const x = before.x * width / before.width, y = before.y * height / before.height;
    const delivery = await call('click', { session, pid, window_id: window.window_id, x, y, delivery_mode: 'background' });
    process.stderr.write(JSON.stringify({ stage: 'click', iteration, beforeHits: before.hits, width, height, x, y, delivery }) + '\n');
    const after = await until(async () => {
      const value = JSON.parse(await readFile(receipt, 'utf8'));
      return value.hits > before.hits ? value : undefined;
    }).catch(async error => { process.stderr.write(await readFile(receipt, 'utf8') + '\n'); throw error; });
    await delay(150);
    const settled = JSON.parse(await readFile(receipt, 'utf8'));
    process.stderr.write(JSON.stringify({ stage: 'events', events: settled.events.slice(before.events.length) }) + '\n');
    evidence.push({ moved, imageSize: { width, height }, scale: width / before.width, x, y, hits: settled.hits, deliveredMouseDowns: settled.hits - before.hits,
      deliveredMouseUps: settled.events.slice(before.events.length).filter((event: {stage: string}) => event.stage === 'view_up').length });
  }
  const singleDeliveryPassed = evidence.every(item => item.deliveredMouseDowns === 1 && item.deliveredMouseUps === 1);
  const nativeEvidence = [];
  for (let index = 0; index < 3; index++) {
    const before = JSON.parse(await readFile(receipt, 'utf8'));
    const shot = await call('get_window_state', { session, pid, window_id: window.window_id, include_screenshot: true });
    const png = Buffer.from(shot.screenshot_png_b64, 'base64');
    await call('click', { session, pid, window_id: window.window_id, x: 310 * png.readUInt32BE(16) / before.width,
      y: before.y * png.readUInt32BE(20) / before.height, delivery_mode: 'background' });
    await until(async () => { const now = JSON.parse(await readFile(receipt, 'utf8')); return now.buttonHits > before.buttonHits ? now : undefined; });
    await delay(150);
    const after = JSON.parse(await readFile(receipt, 'utf8'));
    nativeEvidence.push({ callbacks: after.buttonHits - before.buttonHits });
  }
  const nativeButtonPassed = nativeEvidence.every(item => item.callbacks === 1);
  let keyboardResult;
  if (process.env.MIMI_PROBE_KEYBOARD === '1') {
    assert.notEqual(process.env.MIMI_PROBE_SURFACE, 'web', 'Keyboard fixture currently uses an AppKit input');
    const client = new CuaDriverClient(driver, 15_000);
    const target = { bundleId: 'dev.mimi.grounding-probe', pid, windowId: window.window_id,
      appName: 'MimiGroundingProbe', title: 'Mimi Grounding Probe', bounds: window.bounds };
    const read = async () => JSON.parse(await readFile(receipt, 'utf8'));
    const shot = await call('get_window_state', { session, pid, window_id: window.window_id, include_screenshot: true });
    const png = Buffer.from(shot.screenshot_png_b64, 'base64');
    const before = await read();
    const x = 220 * png.readUInt32BE(16) / before.width;
    const y = (before.y - 100 + 285) * png.readUInt32BE(20) / before.height;
    await call('click', { session, pid, window_id: window.window_id, x, y, delivery_mode: 'background' });
    let invalidShortcutError = '';
    try {
      const response = await exec(driver, ['call', 'press_key', JSON.stringify({ session, pid, window_id: window.window_id,
        key: 'cmd+a', delivery_mode: 'background' })], { timeout: 15_000 });
      invalidShortcutError = response.stdout;
    } catch (error) {
      invalidShortcutError = String((error as {stderr?: string}).stderr ?? error);
    }
    process.stderr.write(JSON.stringify({ stage: 'invalid_shortcut', response: invalidShortcutError }) + '\n');
    assert.match(invalidShortcutError, /Unknown key name: cmd\+a/);
    assert.equal((await read()).textValue, 'Eminem');
    for (const keys of [['cmd+a'], ['Backspace']]) {
      await client.act({ id: session }, { target, input: { observationId: '00000000-0000-4000-8000-000000000000',
        action: { type: 'keypress', keys, dispatch: 'background' } } });
    }
    await until(async () => (await read()).textValue === '' ? true : undefined)
      .catch(async error => { process.stderr.write(JSON.stringify(await read()) + '\n'); throw error; });
    await client.act({ id: session }, { target, input: { observationId: '00000000-0000-4000-8000-000000000000',
      action: { type: 'type_text', text: '薛之谦', x, y, dispatch: 'background' } } });
    await until(async () => (await read()).textValue === '薛之谦' ? true : undefined);
    await client.act({ id: session }, { target, input: { observationId: '00000000-0000-4000-8000-000000000000',
      action: { type: 'keypress', keys: ['Enter'], dispatch: 'background' } } });
    await until(async () => (await read()).submissions > before.submissions ? true : undefined);
    const after = await read();
    keyboardResult = { invalidShortcutRejected: true, textValue: after.textValue, submissions: after.submissions - before.submissions };
    assert.equal(keyboardResult.textValue, '薛之谦');
    assert.equal(keyboardResult.submissions, 1);
  }
  let agentResult;
  if (process.env.MIMI_PROBE_AGENT === '1') {
    await call('end_session', { session });
    const before = JSON.parse(await readFile(receipt, 'utf8'));
    agentResult = await runProbeAgent(root, driver,
      '这是电脑操作回归测试：仅操作已打开的 MimiGroundingProbe（bundleId=dev.mimi.grounding-probe）测试窗口。请观察实际截图，找到蓝色方块并单击一次，然后读回确认结果并汇报。只允许使用 computer_observe/computer_act；不要启动应用，不要 Shell/Connector，不要重复点击。');
    await delay(200);
    const after = JSON.parse(await readFile(receipt, 'utf8'));
    const clicks = agentResult.calls.filter(call => call.name === 'computer_act' && JSON.parse(call.arguments ?? '{}').action?.type === 'click');
    const deliveredMouseUps = after.events.slice(before.events.length).filter((event: {stage: string}) => event.stage === 'view_up').length;
    const buttonCallbacks = after.buttonHits - before.buttonHits;
    const passed = clicks.length === 1 && after.hits - before.hits === 1 && deliveredMouseUps === 1
      && buttonCallbacks === 0 && agentResult.calls.every(call => call.name?.startsWith('computer_'));
    agentResult = { ...agentResult, passed, deliveredMouseDowns: after.hits - before.hits, deliveredMouseUps, buttonCallbacks };
    if (!passed) process.exitCode = 1;
  }
  const report = { surface: process.env.MIMI_PROBE_SURFACE ?? 'native', groundingPassed: true, singleDeliveryPassed, nativeButtonPassed, nativeEvidence, coordinateSpace: 'image_px', evidence, keyboardResult, agentResult };
  console.log(JSON.stringify(report));
  if (process.env.MIMI_PROBE_REPORT) await writeFile(process.env.MIMI_PROBE_REPORT, JSON.stringify(report, null, 2));
  if (!singleDeliveryPassed || !nativeButtonPassed) process.exitCode = 1;
} catch (error) {
  if (process.env.MIMI_PROBE_REPORT) {
    await writeFile(process.env.MIMI_PROBE_REPORT, JSON.stringify({ passed: false,
      error: error instanceof Error ? error.message : String(error), artifacts: process.env.MIMI_PROBE_KEEP === '1' ? root : undefined }, null, 2));
  }
  throw error;
} finally {
  await call('end_session', { session }).catch(() => undefined);
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>(resolve => child!.once('exit', () => resolve()));
    child.kill('SIGTERM');
    await exited;
  }
  if (process.env.MIMI_PROBE_KEEP === '1') process.stderr.write(`Probe artifacts: ${root}\n`);
  else await rm(root, { recursive: true, force: true });
}
