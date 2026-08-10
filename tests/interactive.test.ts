import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import {
  InteractiveTerminal,
  MIMI_IDLE_BLINK_DURATION_MS,
  MIMI_IDLE_BLINK_INTERVAL_MS,
} from '../src/interactive.js';

class FakeInput extends PassThrough {
  isTTY = true;
  setRawMode(): this { return this; }
}

class FakeOutput extends PassThrough {
  isTTY = true;
  columns = 52;
  rows = 24;
  value = '';

  override write(chunk: string | Uint8Array): boolean {
    this.value += chunk.toString();
    return true;
  }
}

function plainOutput(value: string): string {
  return value.replace(/\x1b\[[?0-9;]*[A-Za-z~]/g, '').replace(/\r/g, '');
}

class AnsiScreen {
  private readonly cells: string[][];
  private row = 0;
  private column = 0;

  constructor(
    private readonly columns: number,
    private readonly rows: number,
  ) {
    this.cells = Array.from({ length: rows }, () => Array<string>(columns).fill(' '));
  }

  write(value: string): void {
    for (let index = 0; index < value.length;) {
      if (value[index] === '\x1b' && value[index + 1] === '[') {
        const match = value.slice(index).match(/^\x1b\[([?0-9;]*)([A-Za-z~])/);
        if (match) {
          this.control(match[1] ?? '', match[2] ?? '');
          index += match[0].length;
          continue;
        }
      }
      const codePoint = value.codePointAt(index);
      if (codePoint === undefined) break;
      const character = String.fromCodePoint(codePoint);
      index += character.length;
      if (character === '\r') {
        this.column = 0;
      } else if (character === '\n') {
        this.nextRow();
      } else {
        this.put(character);
      }
    }
  }

  text(): string {
    return this.cells.map((line) => line.join('').trimEnd()).join('\n');
  }

  private control(parameters: string, command: string): void {
    const values = parameters.replace(/^\?/, '').split(';').map((value) => Number(value || '1'));
    const amount = values[0] ?? 1;
    if (command === 'A') this.row = Math.max(0, this.row - amount);
    else if (command === 'B') this.row = Math.min(this.rows - 1, this.row + amount);
    else if (command === 'C') this.column = Math.min(this.columns - 1, this.column + amount);
    else if (command === 'D') this.column = Math.max(0, this.column - amount);
    else if (command === 'H' || command === 'f') {
      this.row = Math.max(0, Math.min(this.rows - 1, (values[0] ?? 1) - 1));
      this.column = Math.max(0, Math.min(this.columns - 1, (values[1] ?? 1) - 1));
    } else if (command === 'J' && (values[0] ?? 0) === 2) {
      for (const line of this.cells) line.fill(' ');
    } else if (command === 'K' && (values[0] ?? 0) === 2) {
      this.cells[this.row]?.fill(' ');
    }
  }

  private put(character: string): void {
    if (this.column >= this.columns) {
      this.column = 0;
      this.nextRow();
    }
    const width = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/u.test(character) ? 2 : 1;
    this.cells[this.row]![this.column] = character;
    if (width === 2 && this.column + 1 < this.columns) this.cells[this.row]![this.column + 1] = '';
    this.column += width;
  }

  private nextRow(): void {
    this.row += 1;
    if (this.row < this.rows) return;
    this.cells.shift();
    this.cells.push(Array<string>(this.columns).fill(' '));
    this.row = this.rows - 1;
  }
}

test('shows slash commands, navigates them and completes with tab', () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const lines: string[] = [];
  const terminal = new InteractiveTerminal([
    { value: '/status', description: '状态' },
    { value: '/new', description: '新对话' },
  ], input as never, output as never);
  terminal.start({ onLine: (line) => lines.push(line), onEscape: () => undefined, onExit: () => undefined });

  const initial = output.value.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  assert.match(initial, /┊>/);
  assert.doesNotMatch(initial, /你>/);
  assert.match(initial, /\^\._\.\^~/);
  assert.doesNotMatch(initial, /◇ 就绪/);

  input.emit('keypress', '/', { sequence: '/' });
  assert.match(output.value, /\/status/);
  assert.match(output.value, /\/new/);
  assert.match(output.value, /\x1b\[96m›/);
  input.emit('keypress', '', { name: 'down' });
  input.emit('keypress', '\t', { name: 'tab' });
  input.emit('keypress', '\r', { name: 'return' });

  assert.deepEqual(lines, ['/new']);
  terminal.close();
});

test('blinks the idle Mimi every configured interval and restores its open eyes', async () => {
  assert.equal(MIMI_IDLE_BLINK_INTERVAL_MS, 6_000);
  assert.equal(MIMI_IDLE_BLINK_DURATION_MS, 1_000);
  const input = new FakeInput();
  const output = new FakeOutput();
  const terminal = new InteractiveTerminal([], input as never, output as never, {
    idleBlinkIntervalMs: 30,
    idleBlinkDurationMs: 20,
  });
  terminal.start({ onLine: () => undefined, onEscape: () => undefined, onExit: () => undefined });
  output.value = '';

  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.match(output.value.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''), /\^-\.-\^~/);
  output.value = '';
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.match(output.value.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''), /\^\._\.\^~/);
  terminal.close();
});

test('runs the highlighted slash command directly with enter', () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const lines: string[] = [];
  const terminal = new InteractiveTerminal([
    { value: '/status', description: '状态' },
    { value: '/new', description: '新对话' },
  ], input as never, output as never);
  terminal.start({ onLine: (line) => lines.push(line), onEscape: () => undefined, onExit: () => undefined });

  input.emit('keypress', '/', { sequence: '/' });
  input.emit('keypress', '', { name: 'down' });
  input.emit('keypress', '\r', { name: 'return' });

  assert.deepEqual(lines, ['/new']);
  terminal.close();
});

test('cycles security with shift+tab without changing the input', () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const lines: string[] = [];
  let cycles = 0;
  const terminal = new InteractiveTerminal([], input as never, output as never);
  terminal.start({
    onLine: (line) => lines.push(line),
    onEscape: () => undefined,
    onExit: () => undefined,
    onSecurityCycle: () => { cycles += 1; },
  });

  input.emit('keypress', '', { name: 'tab', shift: true, sequence: '\x1b[Z' });
  input.emit('keypress', '\r', { name: 'return' });

  assert.equal(cycles, 1);
  assert.deepEqual(lines, []);
  terminal.close();
});

test('cycles mode with shift+caps-lock and the terminal-compatible shift+up fallback', () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  let cycles = 0;
  const terminal = new InteractiveTerminal([], input as never, output as never);
  terminal.start({
    onLine: () => undefined,
    onEscape: () => undefined,
    onExit: () => undefined,
    onModeCycle: () => { cycles += 1; },
  });

  input.emit('keypress', '', { name: 'capslock', shift: true });
  input.emit('keypress', '', { name: 'up', shift: true, sequence: '\x1b[1;2A' });

  assert.equal(cycles, 2);
  terminal.close();
});

test('keeps pasted newlines in the editor until a manual enter submits', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const lines: string[] = [];
  const terminal = new InteractiveTerminal([], input as never, output as never);
  terminal.start({ onLine: (line) => lines.push(line), onEscape: () => undefined, onExit: () => undefined });
  output.value = '';

  input.emit('data', Buffer.from('\x1b[200~第一行\n第二行\x1b[201~'));
  assert.deepEqual(lines, []);
  const plain = plainOutput(output.value);
  assert.match(plain, /│ ┊> 第一行\s+│\n│    第二行/);

  await Promise.resolve();
  input.emit('keypress', '\r', { name: 'return' });
  assert.deepEqual(lines, ['第一行\n第二行']);
  terminal.close();
});

test('supports shift-enter newlines and command-arrow line jumps', () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const lines: string[] = [];
  const terminal = new InteractiveTerminal([], input as never, output as never);
  terminal.start({ onLine: (line) => lines.push(line), onEscape: () => undefined, onExit: () => undefined });

  for (const character of 'abc') input.emit('keypress', character, { sequence: character });
  input.emit('keypress', '\r', { name: 'return', shift: true });
  for (const character of 'xyz') input.emit('keypress', character, { sequence: character });
  input.emit('keypress', '', { name: 'left', meta: true, sequence: '\x1b[1;9D' });
  input.emit('keypress', '>', { sequence: '>' });
  input.emit('keypress', '', { name: 'right', meta: true, sequence: '\x1b[1;9C' });
  input.emit('keypress', '<', { sequence: '<' });
  input.emit('keypress', '\r', { name: 'return' });

  assert.deepEqual(lines, ['abc\n>xyz<']);
  terminal.close();
});

test('distinguishes queued enter from command-enter steering', () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const submissions: Array<{ line: string; intent: string }> = [];
  const terminal = new InteractiveTerminal([], input as never, output as never);
  terminal.start({
    onLine: (line, intent) => submissions.push({ line, intent }),
    onEscape: () => undefined,
    onExit: () => undefined,
  });

  input.emit('keypress', '普通排队', { sequence: '普通排队' });
  input.emit('keypress', '\r', { name: 'return' });
  input.emit('keypress', '立即引导', { sequence: '立即引导' });
  input.emit('keypress', '\r', { name: 'return', meta: true, sequence: '\x1b[13;9u' });

  assert.deepEqual(submissions, [
    { line: '普通排队', intent: 'enqueue' },
    { line: '立即引导', intent: 'steer' },
  ]);
  terminal.close();
});

test('recognizes the command-enter modifier sequence when meta is unavailable', () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const intents: string[] = [];
  const terminal = new InteractiveTerminal([], input as never, output as never);
  terminal.start({
    onLine: (_line, intent) => intents.push(intent),
    onEscape: () => undefined,
    onExit: () => undefined,
  });

  input.emit('keypress', '调整方向', { sequence: '调整方向' });
  input.emit('keypress', '\r', { name: 'return', sequence: '\x1b[27;9;13~' });

  assert.deepEqual(intents, ['steer']);
  terminal.close();
});

test('recognizes raw command-enter sequences before readline splits them', () => {
  for (const sequence of ['\x1b\r', '\x1b[13;9u', '\x1b[27;9;13~']) {
    const input = new FakeInput();
    const output = new FakeOutput();
    const submissions: Array<{ line: string; intent: string }> = [];
    const terminal = new InteractiveTerminal([], input as never, output as never);
    terminal.start({
      onLine: (line, intent) => submissions.push({ line, intent }),
      onEscape: () => undefined,
      onExit: () => undefined,
    });

    input.write('立即调整');
    input.write(sequence);

    assert.deepEqual(submissions, [{ line: '立即调整', intent: 'steer' }], JSON.stringify(sequence));
    terminal.close();
  }
});

test('single escape immediately cancels the active task and preserves editable input', () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const lines: string[] = [];
  let escapes = 0;
  const terminal = new InteractiveTerminal([], input as never, output as never);
  terminal.start({
    onLine: (line) => lines.push(line),
    onEscape: () => { escapes += 1; },
    onExit: () => undefined,
  });

  for (const character of '需要清空') input.emit('keypress', character, { sequence: character });
  input.emit('keypress', '', { name: 'escape' });
  assert.equal(escapes, 1);
  input.emit('keypress', '\r', { name: 'return' });

  assert.deepEqual(lines, ['需要清空']);
  terminal.close();
});

test('keeps editable input history isolated by session', () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const lines: string[] = [];
  const terminal = new InteractiveTerminal([], input as never, output as never);
  terminal.useSession('first');
  terminal.start({ onLine: (line) => lines.push(line), onEscape: () => undefined, onExit: () => undefined });

  for (const character of 'first message') input.emit('keypress', character, { sequence: character });
  input.emit('keypress', '\r', { name: 'return' });
  terminal.useSession('second');
  input.emit('keypress', '', { name: 'up' });
  input.emit('keypress', '\r', { name: 'return' });
  for (const character of 'second message') input.emit('keypress', character, { sequence: character });
  input.emit('keypress', '\r', { name: 'return' });
  terminal.useSession('first');
  input.emit('keypress', '', { name: 'up' });
  input.emit('keypress', '\r', { name: 'return' });

  assert.deepEqual(lines, ['first message', 'second message', 'first message']);
  terminal.close();
});

test('continues browsing history when a recalled entry matches slash command suggestions', () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const lines: string[] = [];
  const terminal = new InteractiveTerminal([
    { value: '/help', description: '帮助' },
    { value: '/history', description: '历史' },
  ], input as never, output as never);
  terminal.start({ onLine: (line) => lines.push(line), onEscape: () => undefined, onExit: () => undefined });

  for (const value of ['普通历史', '/help']) {
    for (const character of value) input.emit('keypress', character, { sequence: character });
    input.emit('keypress', '\r', { name: 'return' });
  }
  output.value = '';
  input.emit('keypress', '', { name: 'up' });
  assert.doesNotMatch(output.value, /帮助|历史/);
  input.emit('keypress', '', { name: 'up' });
  input.emit('keypress', '\r', { name: 'return' });

  assert.deepEqual(lines, ['普通历史', '/help', '普通历史']);
  terminal.close();
});

test('keeps queue and a self-updating runtime status around the bottom input box', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  output.columns = 100;
  const terminal = new InteractiveTerminal([], input as never, output as never);
  terminal.setRuntimeStatus({
    mode: '编码',
    model: 'deepseek-chat',
    permissionMode: 'trusted',
    contextUsed: 1200,
    contextWindow: 128000,
  });
  terminal.start({ onLine: () => undefined, onEscape: () => undefined, onExit: () => undefined });
  output.value = '';

  terminal.setBusy(true);
  output.value = '';
  terminal.setQueue([
    { text: '立即调整当前执行方向', intent: 'steer' },
    { text: '排队中的第一条对话内容' },
    { text: '这是一条非常长的排队消息，需要在终端宽度之外使用省略号隐藏多出的内容以保持单行展示，而且无论继续补充多少文字都不能换行破坏底部区域' },
  ]);

  const plain = plainOutput(output.value);
  assert.match(plain, /↯ 引导  1  立即调整当前执行方向\n↳ 排队  2  排队中的第一条对话内容\n↳ 排队  3 .*\.\.\./);
  assert.match(plain, /⌃X 取消排队/);
  assert.ok(plain.indexOf('┊>') < plain.indexOf('^._.^~ 运行中 · 0秒 · 编码 · Full Owner · deepseek-chat'));
  output.value = '';
  await new Promise((resolve) => setTimeout(resolve, 420));
  const animated = plainOutput(output.value);
  assert.match(animated, /\^\._\.\^- 运行中 · 0秒/);
  terminal.close();
});

test('uses the interactive TTY for renderer animation when stderr is redirected', () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const redirected = new FakeOutput();
  redirected.isTTY = false;
  const terminal = new InteractiveTerminal([], input as never, output as never);
  terminal.start({ onLine: () => undefined, onEscape: () => undefined, onExit: () => undefined });

  const writer = terminal.createWriter(redirected as never);
  assert.equal(writer.isTTY, true);
  writer.write('重定向日志\n');
  assert.equal(redirected.value, '重定向日志\n');
  terminal.close();
});

test('preserves the renderer spinner frame and elapsed time in interactive status', () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  output.columns = 100;
  const terminal = new InteractiveTerminal([], input as never, output as never);
  terminal.start({ onLine: () => undefined, onEscape: () => undefined, onExit: () => undefined });
  terminal.setBusy(true);
  output.value = '';

  const writer = terminal.createWriter(output as never);
  writer.write('\r\x1b[2K\x1b[90m^._?^- 模型思考中 · 1分 05秒\x1b[0m');

  const plain = output.value.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  assert.match(plain, /\^\._\?\^- 模型思考中 · 1分 05秒 · 标准 · 未配置/);
  terminal.close();
});

test('shows only current context usage and percentage', () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  output.columns = 140;
  const terminal = new InteractiveTerminal([], input as never, output as never);
  terminal.setRuntimeStatus({
    mode: '标准',
    model: 'test-model',
    permissionMode: 'workspace',
    contextUsed: 200_000,
    contextWindow: 1_000_000,
  });
  terminal.start({ onLine: () => undefined, onEscape: () => undefined, onExit: () => undefined });
  const plain = output.value.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  assert.match(plain, /上下文 200k\/1\.0m（20%）/);
  assert.match(plain, /\^\._\.\^~ · 标准 · Workstation · test-model · 上下文/);
  assert.doesNotMatch(plain, /模式 |权限 /);
  assert.doesNotMatch(plain, /\bactual\b|上下文 ~|已压缩/);
  terminal.close();
});

test('keeps the input cursor away from the right edge for IME composition', () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  output.columns = 32;
  const terminal = new InteractiveTerminal(
    [],
    input as never,
    output as never,
    { singleLineInputViewport: true },
  );
  terminal.start({ onLine: () => undefined, onEscape: () => undefined, onExit: () => undefined });
  output.value = '';

  for (const character of 'a'.repeat(80)) input.emit('keypress', character, { sequence: character });

  const cursorColumns = [...output.value.matchAll(/\x1b\[(\d+)C/g)]
    .map((match) => Number(match[1]));
  assert.ok(cursorColumns.length > 0);
  assert.ok(cursorColumns.every((column) => column <= 16));
  terminal.close();
});

test('defers and coalesces input redraws outside the keypress callback for Apple Terminal safety', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const terminal = new InteractiveTerminal(
    [],
    input as never,
    output as never,
    { inputRedrawDelayMs: 20 },
  );
  terminal.start({ onLine: () => undefined, onEscape: () => undefined, onExit: () => undefined });
  output.value = '';

  for (const character of '输入文字') input.emit('keypress', character, { sequence: character });

  assert.equal(output.value, '', 'keypress dispatch must not synchronously redraw the terminal');
  await new Promise((resolve) => setTimeout(resolve, 35));
  const plain = output.value.replace(/\x1b\[[?0-9;]*[A-Za-z~]/g, '');
  assert.match(plain, /┊> 输入文字/);
  assert.equal((plain.match(/┊> 输入文字/g) ?? []).length, 1);
  terminal.close();
});

test('disables autonomous redraw animation in Apple Terminal IME-safe mode', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const terminal = new InteractiveTerminal(
    [],
    input as never,
    output as never,
    {
      imeSafeInput: true,
      idleBlinkIntervalMs: 20,
      idleBlinkDurationMs: 10,
    },
  );
  terminal.start({ onLine: () => undefined, onEscape: () => undefined, onExit: () => undefined });
  output.value = '';

  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(output.value, '', 'idle animation must not rewrite the screen while the IME may own marked text');

  terminal.setBusy(true);
  output.value = '';
  terminal.createWriter(output as never).write('\r\x1b[2K\x1b[90m^._?^- 模型思考中\x1b[0m');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(output.value, '', 'busy animation must not rewrite the screen while the IME may own marked text');
  terminal.close();
});

test('defers terminal output until an Apple Terminal IME-safe draft is submitted', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const lines: string[] = [];
  const terminal = new InteractiveTerminal(
    [],
    input as never,
    output as never,
    {
      imeSafeInput: true,
      inputRedrawDelayMs: 10,
      singleLineInputViewport: true,
    },
  );
  terminal.start({ onLine: (line) => lines.push(line), onEscape: () => undefined, onExit: () => undefined });

  input.emit('keypress', '第一行', { sequence: '第一行' });
  input.emit('keypress', '', { name: 'return', shift: true });
  input.emit('keypress', '第二行'.repeat(80), { sequence: '第二行'.repeat(80) });
  await new Promise((resolve) => setTimeout(resolve, 20));
  output.value = '';

  terminal.createWriter(output as never).write('任务在输入期间完成\n');
  assert.equal(output.value, '', 'answer output must not disturb an active marked-text input area');

  input.emit('keypress', '\r', { name: 'return' });

  assert.deepEqual(lines, [`第一行\n${'第二行'.repeat(80)}`]);
  assert.match(output.value, /任务在输入期间完成/);
  terminal.close();
});

test('submits buffered input before a deferred redraw fires', () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const lines: string[] = [];
  const terminal = new InteractiveTerminal(
    [],
    input as never,
    output as never,
    { inputRedrawDelayMs: 20 },
  );
  terminal.start({ onLine: (line) => lines.push(line), onEscape: () => undefined, onExit: () => undefined });

  input.emit('keypress', '立即发送', { sequence: '立即发送' });
  input.emit('keypress', '\r', { name: 'return' });

  assert.deepEqual(lines, ['立即发送']);
  terminal.close();
});

test('keeps Apple Terminal input on one physical row past the wide-character wrap boundary', () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  output.columns = 52;
  const lines: string[] = [];
  const terminal = new InteractiveTerminal(
    [],
    input as never,
    output as never,
    { inputRedrawDelayMs: 0, singleLineInputViewport: true },
  );
  terminal.start({ onLine: (line) => lines.push(line), onEscape: () => undefined, onExit: () => undefined });
  output.value = '';
  const value = '这是用于验证苹果终端输入法安全视窗的一段较长中文文字，长度已经明显超过原来的自动换行边界';

  input.emit('keypress', value, { sequence: value });

  const plain = output.value.replace(/\x1b\[[?0-9;]*[A-Za-z~]/g, '');
  assert.doesNotMatch(plain, /\n┊\s{2}/);
  const cursorColumns = [...output.value.matchAll(/\x1b\[(\d+)C/g)]
    .map((match) => Number(match[1]));
  assert.ok(cursorColumns.every((column) => column <= output.columns - 16));
  input.emit('keypress', '\r', { name: 'return' });
  assert.deepEqual(lines, [value]);
  terminal.close();
});

test('soft-wraps long editable input to the current terminal width', () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  output.columns = 32;
  const terminal = new InteractiveTerminal([], input as never, output as never);
  terminal.start({ onLine: () => undefined, onEscape: () => undefined, onExit: () => undefined });

  for (const character of 'abcdefghijklmnopqrstuvwxyzabcdefghijklmn') {
    input.emit('keypress', character, { sequence: character });
  }
  output.value = '';
  terminal.setRuntimeStatus({ mode: '标准', model: 'test', contextUsed: 0, contextWindow: 0 });

  const plain = plainOutput(output.value);
  assert.match(plain, /│ ┊> abcdefghijklmnopqrstuvwxyz[ ]*│\n│    abcdefghijklmn/);
  assert.match(output.value, /\x1b\[19C$/);

  output.value = '';
  output.columns = 52;
  output.emit('resize');
  const resized = plainOutput(output.value);
  assert.match(resized, /┊> abcdefghijklmnopqrstuvwxyzabcdefghijklmn/);
  assert.doesNotMatch(resized, /│    abcdefghijklmn/);
  terminal.close();
});

test('grows the input box across multiple rows and reflows it after resize', () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  output.columns = 40;
  const terminal = new InteractiveTerminal([], input as never, output as never);
  terminal.start({ onLine: () => undefined, onEscape: () => undefined, onExit: () => undefined });

  const value = 'a'.repeat(80);
  input.emit('keypress', value, { sequence: value });
  output.value = '';
  terminal.setRuntimeStatus({ mode: '标准', model: 'test', contextUsed: 0, contextWindow: 0 });

  let plain = plainOutput(output.value);
  let content = [...plain.matchAll(/^│(?: ┊> |    )(a*)[ ]*│$/gm)].map((match) => match[1] ?? '');
  assert.deepEqual(content.map((line) => line.length), [34, 34, 12]);
  assert.equal(content.join(''), value);
  assert.doesNotMatch(plain, /已隐藏/);

  output.value = '';
  output.columns = 60;
  output.emit('resize');
  plain = plainOutput(output.value);
  content = [...plain.matchAll(/^│(?: ┊> |    )(a*)[ ]*│$/gm)].map((match) => match[1] ?? '');
  assert.deepEqual(content.map((line) => line.length), [54, 26]);
  assert.equal(content.join(''), value);
  terminal.close();
});

test('erases terminal-reflowed queue rows before redrawing after resize', () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  output.columns = 140;
  output.rows = 10;
  const terminal = new InteractiveTerminal(
    [],
    input as never,
    output as never,
    { idleBlinkIntervalMs: 60_000 },
  );
  terminal.start({ onLine: () => undefined, onEscape: () => undefined, onExit: () => undefined });
  terminal.setQueue([{ text: 'm'.repeat(300), intent: 'enqueue' }]);

  output.value = '';
  output.columns = 70;
  output.emit('resize');

  const nextQueue = output.value.indexOf('\x1b[2m↳');
  assert.ok(nextQueue > 0);
  const erase = output.value.slice(0, nextQueue);
  assert.match(erase, /^\r\x1b\[4B\x1b\[2K/);
  assert.equal((erase.match(/\x1b\[1A\r\x1b\[2K/g) ?? []).length, 13);
  assert.equal((plainOutput(output.value).match(/↳ 排队/g) ?? []).length, 1);
  terminal.close();
});

test('uses a readable fallback width while the TTY reports zero columns', () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  output.columns = 0;
  const terminal = new InteractiveTerminal([], input as never, output as never);
  terminal.start({ onLine: () => undefined, onEscape: () => undefined, onExit: () => undefined });
  output.value = '';

  for (const character of 'abcdefghijklmnopqrstuvwxyz') {
    input.emit('keypress', character, { sequence: character });
  }

  const plain = output.value.replace(/\x1b\[[?0-9;]*[A-Za-z~]/g, '');
  assert.match(plain, /┊> abcdefghijklmnopqrstuvwxyz/);
  assert.doesNotMatch(plain, /\n┊  /);
  terminal.close();
});

test('wraps wide characters without splitting explicit input lines', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  output.columns = 32;
  const lines: string[] = [];
  const terminal = new InteractiveTerminal([], input as never, output as never);
  terminal.start({ onLine: (line) => lines.push(line), onEscape: () => undefined, onExit: () => undefined });
  output.value = '';

  input.emit('data', Buffer.from('\x1b[200~甲乙丙丁戊己庚\n辛壬癸\x1b[201~'));

  const plain = plainOutput(output.value);
  assert.match(plain, /│ ┊> 甲乙丙丁戊己庚\s+│\n│    辛壬癸/);
  await Promise.resolve();
  input.emit('keypress', '\r', { name: 'return' });
  assert.deepEqual(lines, ['甲乙丙丁戊己庚\n辛壬癸']);
  terminal.close();
});

test('keeps long pasted input in a bounded viewport and submits the full text', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  output.columns = 52;
  const lines: string[] = [];
  const terminal = new InteractiveTerminal([], input as never, output as never);
  terminal.start({ onLine: (line) => lines.push(line), onEscape: () => undefined, onExit: () => undefined });
  output.value = '';
  const pasted = Array.from({ length: 400 }, (_, index) => `第 ${index + 1} 行长文本`).join('\n');

  input.emit('data', Buffer.from(`\x1b[200~${pasted}\x1b[201~`));

  const plain = output.value.replace(/\x1b\[[?0-9;]*[A-Za-z~]/g, '');
  assert.match(plain, /上方 \d+ 行已隐藏/);
  assert.ok(output.value.length < 5_000, `redraw output must stay bounded, received ${output.value.length} bytes`);
  await Promise.resolve();
  input.emit('keypress', '\r', { name: 'return' });
  assert.deepEqual(lines, [pasted]);
  terminal.close();
});

test('preserves a bracketed-paste end marker split across data chunks', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const lines: string[] = [];
  const terminal = new InteractiveTerminal([], input as never, output as never);
  terminal.start({ onLine: (line) => lines.push(line), onEscape: () => undefined, onExit: () => undefined });

  input.emit('data', Buffer.from('\x1b[200~完整长文本\x1b[20'));
  input.emit('data', Buffer.from('1~'));
  await Promise.resolve();
  input.emit('keypress', '\r', { name: 'return' });

  assert.deepEqual(lines, ['完整长文本']);
  terminal.close();
});

test('shows the current plan above the input and hides it after completion', () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  output.columns = 44;
  const terminal = new InteractiveTerminal([], input as never, output as never);
  terminal.start({ onLine: () => undefined, onEscape: () => undefined, onExit: () => undefined });
  output.value = '';

  terminal.setTasks([
    { id: 'inspect', description: '检查现有任务规划和终端渲染机制', status: 'completed' },
    { id: 'build', description: '实现一个非常长的任务进度展示区域并确保内容不会破坏输入框布局', status: 'running' },
    { id: 'test', description: '运行完整测试', status: 'pending' },
  ]);
  let plain = plainOutput(output.value);
  assert.match(plain, /任务 1\/3\n/);
  assert.doesNotMatch(plain, /当前：/);
  assert.match(plain, /✓ 检查现有任务规划和终端渲染机制/);
  assert.match(plain, /● 实现一个非常长的任务进度展示区域.*\.\.\./);
  assert.match(plain, /○ 运行完整测试/);
  assert.ok(plain.indexOf('○ 运行完整测试') < plain.indexOf('┊>'));
  assert.ok(plain.indexOf('┊>') < plain.indexOf('^._.^~'));

  output.value = '';
  terminal.setTasks([
    { id: 'inspect', description: '检查机制', status: 'completed' },
    { id: 'build', description: '实现任务面板', status: 'completed' },
  ]);
  plain = plainOutput(output.value);
  assert.doesNotMatch(plain, /任务 2\/2|检查机制|实现任务面板|●|○/);
  terminal.close();
});

test('selects a conversation with arrow keys and enter', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const terminal = new InteractiveTerminal([], input as never, output as never);
  terminal.start({ onLine: () => undefined, onEscape: () => undefined, onExit: () => undefined });
  const selected = terminal.select([
    { value: 'first', label: '第一个对话' },
    { value: 'second', label: '第二个对话', detail: '最近内容' },
  ]);

  input.emit('keypress', '', { name: 'down' });
  input.emit('keypress', '\r', { name: 'return' });
  assert.equal(await selected, 'second');
  terminal.close();
});

test('starts a selection on the supplied current value', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const terminal = new InteractiveTerminal([], input as never, output as never);
  terminal.start({ onLine: () => undefined, onEscape: () => undefined, onExit: () => undefined });
  const selected = terminal.select([
    { value: 'safe', label: 'Safe' },
    { value: 'workstation', label: 'Workstation' },
    { value: 'full-owner', label: 'Full Owner' },
  ], '选择安全档位', 'full-owner');

  input.emit('keypress', '\r', { name: 'return' });

  assert.equal(await selected, 'full-owner');
  terminal.close();
});

test('cancels an active selection when the terminal closes', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const terminal = new InteractiveTerminal([], input as never, output as never);
  terminal.start({ onLine: () => undefined, onEscape: () => undefined, onExit: () => undefined });
  const selected = terminal.select([{ value: 'history', label: '历史对话' }]);

  terminal.close();

  assert.equal(await selected, undefined);
});

test('keeps every selection item on one terminal row and truncates overflow', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  output.columns = 24;
  const terminal = new InteractiveTerminal([], input as never, output as never);
  terminal.start({ onLine: () => undefined, onEscape: () => undefined, onExit: () => undefined });
  const selected = terminal.select([
    { value: 'first', label: '很长的第一个对话标题', detail: '这是一段同样很长的最近内容预览' },
    { value: 'second', label: '第二个对话', detail: '另一段很长的最近内容预览' },
  ]);
  output.value = '';

  input.emit('keypress', '', { name: 'down' });

  const plain = plainOutput(output.value);
  assert.match(plain, /很长的第一个对话标题\n/);
  assert.match(plain, /第二个对话  另一段\.\.\./);
  assert.doesNotMatch(output.value, /这是一段同样很长的最近内容预览/);
  input.emit('keypress', '\r', { name: 'return' });
  assert.equal(await selected, 'second');
  terminal.close();
});

test('records submitted user input as a permanent conversation line', () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const terminal = new InteractiveTerminal([], input as never, output as never);
  terminal.start({ onLine: () => undefined, onEscape: () => undefined, onExit: () => undefined });
  output.value = '';

  terminal.recordInput('  帮我检查\n当前项目  ');
  const plain = plainOutput(output.value);
  assert.match(output.value, /\x1b\[96m▸\x1b\[0m\x1b\[100;97m 帮我检查 当前项目 \x1b\[0m/);
  assert.match(plain, /▸ 帮我检查 当前项目 \n/);
  assert.ok(plain.indexOf('▸ 帮我检查 当前项目') < plain.indexOf('┊>'));
  assert.ok(plain.indexOf('┊>') < plain.indexOf('^._.^~'));
  terminal.close();
});

test('appends streamed chunks at the real text column without padding to the terminal edge', () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  output.columns = 120;
  const terminal = new InteractiveTerminal([], input as never, output as never);
  terminal.start({ onLine: () => undefined, onEscape: () => undefined, onExit: () => undefined });
  const writer = terminal.createWriter(output as never);
  output.value = '';

  writer.write('从此');
  writer.write(' 7×24 自动接单');

  assert.doesNotMatch(output.value, /\x1b\[999C/);
  assert.match(output.value, /\x1b\[1A\r\x1b\[4C/);
  terminal.close();
});

test('keeps streamed output aligned and the bottom panel singular after scrolling', () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  output.columns = 60;
  output.rows = 18;
  const terminal = new InteractiveTerminal([], input as never, output as never);
  terminal.clearScreen('MimiAgent');
  terminal.start({ onLine: () => undefined, onEscape: () => undefined, onExit: () => undefined });
  const writer = terminal.createWriter(output as never);

  writer.write(`${Array.from({ length: 35 }, (_, index) => `第 ${index + 1} 行内容`).join('\n')}\n`);
  writer.write('最终回答第一行\n最终回答第二行\n');

  assert.match(output.value, /最终回答第一行\r\n最终回答第二行\r\n/);
  const screen = new AnsiScreen(output.columns, output.rows);
  screen.write(output.value);
  const rendered = screen.text();
  assert.match(rendered, /^最终回答第一行\n最终回答第二行/m);
  assert.equal((rendered.match(/┌─/g) ?? []).length, 1);
  assert.equal((rendered.match(/└─/g) ?? []).length, 1);
  assert.equal((rendered.match(/┊>/g) ?? []).length, 1);
  terminal.close();
});
