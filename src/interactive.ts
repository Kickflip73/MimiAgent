import readline from 'node:readline';
import type { ReadStream, WriteStream } from 'node:tty';
import type { PlanStep } from './core/plan.js';
import {
  formatRunDuration,
  MIMI_TAIL_INTERVAL_MS,
  renderMimiFrame,
  renderUserInput,
} from './terminal.js';

export interface CompletionItem {
  value: string;
  description: string;
}

export interface SelectItem {
  value: string;
  label: string;
  detail?: string;
}

export interface RuntimeStatus {
  mode: string;
  model: string;
  contextUsed: number;
  contextWindow: number;
  contextSource?: 'actual' | 'estimate' | 'raw-history';
  compressedFrom?: number;
}

export type InputSubmitIntent = 'enqueue' | 'steer';

export interface QueuedInput {
  text: string;
  intent?: InputSubmitIntent;
}

interface InteractiveTerminalOptions {
  inputRedrawDelayMs?: number;
  singleLineInputViewport?: boolean;
  imeSafeInput?: boolean;
  idleBlinkIntervalMs?: number;
  idleBlinkDurationMs?: number;
}

type Key = { name?: string; ctrl?: boolean; shift?: boolean; meta?: boolean; sequence?: string };

const clearLine = '\r\x1b[2K';
const selectionCursor = '\x1b[96m›\x1b[0m';
const doubleEscapeWindowMs = 350;
const maxVisibleInputRows = 10;
export const MIMI_IDLE_BLINK_INTERVAL_MS = 6_000;
export const MIMI_IDLE_BLINK_DURATION_MS = 1_000;

function displayWidth(value: string): number {
  const plain = value.replace(/\x1b\[[0-9;]*m/g, '');
  return Array.from(plain).reduce((width, character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    const wide = codePoint >= 0x1f300 || /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/u.test(character);
    return width + (wide ? 2 : 1);
  }, 0);
}

function usableTerminalWidth(value: number | undefined): number {
  return Number.isFinite(value) && value! >= 20 ? Math.floor(value!) : 80;
}

function isAppleTerminal(): boolean {
  return process.platform === 'darwin' && process.env.TERM_PROGRAM === 'Apple_Terminal';
}

export class InteractiveTerminal {
  private buffer: string[] = [];
  private cursor = 0;
  private history: string[] = [];
  private histories = new Map<string, string[]>();
  private sessionId = '';
  private historyIndex = 0;
  private completionIndex = 0;
  private busy = false;
  private busyStartedAt = 0;
  private busyFrame = 0;
  private busyTimer?: NodeJS.Timeout;
  private idleBlink = false;
  private idleBlinkTimer?: NodeJS.Timeout;
  private idleBlinkResetTimer?: NodeJS.Timeout;
  private transient = '';
  private runtime: RuntimeStatus = { mode: '标准', model: '未配置', contextUsed: 0, contextWindow: 0 };
  private queued: QueuedInput[] = [];
  private tasks: PlanStep[] = [];
  private outputOpen = false;
  private outputOpenWidth = 0;
  private renderedRows = 0;
  private started = false;
  private closed = false;
  private bracketPaste = false;
  private pastePending = '';
  private suppressPasteKeypress = false;
  private pasteDataListener?: (chunk: Buffer | string) => void;
  private resizeListener?: () => void;
  private escapeTimer?: NodeJS.Timeout;
  private inputRedrawTimer?: NodeJS.Timeout;
  private readonly inputRedrawDelayMs: number;
  private readonly singleLineInputViewport: boolean;
  private readonly imeSafeInput: boolean;
  private readonly idleBlinkIntervalMs: number;
  private readonly idleBlinkDurationMs: number;
  private deferredWrites: Array<{ chunk: string; stream: WriteStream }> = [];
  private selectState?: {
    items: SelectItem[];
    index: number;
    title: string;
    resolve: (value?: string) => void;
  };

  constructor(
    private readonly completions: CompletionItem[],
    private readonly input: ReadStream = process.stdin,
    private readonly output: WriteStream = process.stdout,
    options: InteractiveTerminalOptions = {},
  ) {
    const appleTerminal = isAppleTerminal();
    this.inputRedrawDelayMs = options.inputRedrawDelayMs ?? (appleTerminal ? 24 : 0);
    this.singleLineInputViewport = options.singleLineInputViewport ?? appleTerminal;
    this.imeSafeInput = options.imeSafeInput ?? appleTerminal;
    this.idleBlinkIntervalMs = options.idleBlinkIntervalMs ?? MIMI_IDLE_BLINK_INTERVAL_MS;
    this.idleBlinkDurationMs = options.idleBlinkDurationMs ?? MIMI_IDLE_BLINK_DURATION_MS;
  }

  start(handlers: {
    onLine: (line: string, intent: InputSubmitIntent) => void;
    onEscape: () => void;
    onExit: () => void;
    onModeCycle?: () => void;
  }): void {
    this.started = true;
    this.pasteDataListener = (chunk) => this.handlePasteData(chunk);
    this.input.prependListener('data', this.pasteDataListener);
    this.resizeListener = () => this.redraw();
    this.output.on('resize', this.resizeListener);
    readline.emitKeypressEvents(this.input);
    if (this.input.isTTY) {
      this.input.setRawMode(true);
      this.output.write('\x1b[?2004h');
    }
    this.input.resume();
    this.input.on('keypress', (text: string, key: Key) => {
      if (this.suppressPasteKeypress || this.bracketPaste) return;
      if (key.name !== 'escape' && this.escapeTimer) {
        clearTimeout(this.escapeTimer);
        this.escapeTimer = undefined;
      }
      if (key.ctrl && (key.name === 'c' || key.name === 'd')) {
        handlers.onExit();
        return;
      }
      if ((key.name === 'tab' && key.shift) || key.sequence === '\x1b[Z') {
        handlers.onModeCycle?.();
        return;
      }
      if (this.selectState) {
        this.handleSelection(key);
        return;
      }
      if (key.name === 'escape') {
        if (!this.buffer.length) {
          handlers.onEscape();
          return;
        }
        if (this.escapeTimer) {
          clearTimeout(this.escapeTimer);
          this.escapeTimer = undefined;
          this.buffer = [];
          this.cursor = 0;
          this.completionIndex = 0;
          this.cancelInputRedraw();
          if (!this.flushDeferredWrites()) this.redrawAfterInput();
          return;
        }
        this.escapeTimer = setTimeout(() => {
          this.escapeTimer = undefined;
          handlers.onEscape();
        }, doubleEscapeWindowMs);
        this.escapeTimer.unref();
        return;
      }
      const shiftedEnter = ((key.name === 'return' || key.name === 'enter') && key.shift)
        || key.sequence === '\x1b[13;2u' || key.sequence === '\x1b[27;2;13~';
      if (shiftedEnter) {
        this.insertText('\n');
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        const intent = key.meta
          || key.sequence === '\x1b[13;9u'
          || key.sequence === '\x1b[27;9;13~'
          ? 'steer'
          : 'enqueue';
        const line = (this.suggestions[this.completionIndex]?.value ?? this.buffer.join('')).trim();
        this.cancelInputRedraw();
        this.eraseUi();
        this.output.write('\n');
        this.outputOpen = false;
        this.buffer = [];
        this.cursor = 0;
        this.completionIndex = 0;
        if (line) {
          this.history.push(line);
          this.historyIndex = this.history.length;
        }
        if (!this.flushDeferredWrites()) this.draw();
        if (line) handlers.onLine(line, intent);
        return;
      }
      if (key.name === 'tab' && this.suggestions.length) {
        this.setBuffer(`${this.suggestions[this.completionIndex]?.value ?? ''} `);
        return;
      }
      if ((key.name === 'up' || key.name === 'down') && this.suggestions.length) {
        const direction = key.name === 'up' ? -1 : 1;
        this.completionIndex = (this.completionIndex + direction + this.suggestions.length) % this.suggestions.length;
        this.redrawAfterInput();
        return;
      }
      if ((key.name === 'up' || key.name === 'down') && this.buffer.includes('\n')) {
        this.moveVertical(key.name === 'up' ? -1 : 1);
        return;
      }
      if (key.name === 'up' || key.name === 'down') {
        if (!this.history.length) return;
        this.historyIndex = Math.max(0, Math.min(this.history.length, this.historyIndex + (key.name === 'up' ? -1 : 1)));
        this.setBuffer(this.history[this.historyIndex] ?? '');
        return;
      }
      const commandLeft = (key.meta && key.name === 'left') || key.sequence === '\x1b[1;9D';
      const commandRight = (key.meta && key.name === 'right') || key.sequence === '\x1b[1;9C';
      if (commandLeft) this.cursor = this.lineStart(this.cursor);
      else if (commandRight) this.cursor = this.lineEnd(this.cursor);
      else if (key.name === 'left') this.cursor = Math.max(0, this.cursor - 1);
      else if (key.name === 'right') this.cursor = Math.min(this.buffer.length, this.cursor + 1);
      else if (key.name === 'backspace' && this.cursor > 0) {
        this.buffer.splice(--this.cursor, 1);
        this.completionIndex = 0;
      } else if (key.name === 'delete' && this.cursor < this.buffer.length) {
        this.buffer.splice(this.cursor, 1);
        this.completionIndex = 0;
      } else if (text && !key.ctrl && !key.meta && text >= ' ') {
        this.buffer.splice(this.cursor, 0, ...Array.from(text));
        this.cursor += Array.from(text).length;
        this.completionIndex = 0;
      } else return;
      this.redrawAfterInput();
    });
    this.draw();
    this.scheduleIdleBlink();
  }

  createWriter(stream: WriteStream): { isTTY: boolean; write: (chunk: string) => void } {
    return { isTTY: Boolean(this.output.isTTY), write: (chunk) => this.write(chunk, stream) };
  }

  write(chunk: string, stream: WriteStream = this.output): void {
    if (this.closed) return;
    if (chunk.startsWith(clearLine) && !chunk.includes('\n')) {
      const plain = chunk.slice(clearLine.length).replace(/\x1b\[[0-9;]*m/g, '').trim();
      this.transient = chunk === clearLine ? '' : plain;
      if (!this.imeSafeInput) this.redraw();
      return;
    }
    if (this.imeSafeInput && this.buffer.length > 0) {
      this.deferredWrites.push({ chunk, stream });
      return;
    }
    this.writeNow(chunk, stream);
  }

  private writeNow(chunk: string, stream: WriteStream): void {
    this.eraseUi();
    const wasOpen = this.outputOpen;
    if (wasOpen) {
      const width = Math.max(1, this.output.columns ?? 80);
      const column = this.outputOpenWidth % width;
      this.output.write(`\x1b[1A\r${column ? `\x1b[${column}C` : ''}`);
    }
    stream.write(chunk);
    this.outputOpen = !chunk.endsWith('\n');
    if (this.outputOpen) {
      const lastLine = chunk.slice(Math.max(chunk.lastIndexOf('\n'), chunk.lastIndexOf('\r')) + 1);
      this.outputOpenWidth = (wasOpen && !chunk.includes('\n') ? this.outputOpenWidth : 0) + displayWidth(lastLine);
      this.output.write('\n');
    } else {
      this.outputOpenWidth = 0;
    }
    this.draw();
  }

  notify(message: string): void {
    this.write(`${message}\n`);
  }

  recordInput(input: string): void {
    const text = input.replace(/\x1b/g, '').replace(/\s+/g, ' ').trim();
    if (!text) return;
    this.write(`${renderUserInput(text, Boolean(this.output.isTTY))}\n`);
  }

  setBusy(value: boolean): void {
    if (this.busy === value) return;
    this.busy = value;
    if (value) {
      this.stopIdleBlink();
      this.busyStartedAt = Date.now();
      this.busyFrame = 0;
      this.scheduleBusyRedraw();
    } else {
      if (this.busyTimer) clearTimeout(this.busyTimer);
      this.busyTimer = undefined;
      this.transient = '';
      this.scheduleIdleBlink();
    }
    this.redraw();
  }

  setRuntimeStatus(status: RuntimeStatus): void {
    this.runtime = status;
    this.redraw();
  }

  useSession(sessionId: string): void {
    if (sessionId === this.sessionId) return;
    if (this.sessionId) this.histories.set(this.sessionId, [...this.history]);
    this.sessionId = sessionId;
    this.history = [...(this.histories.get(sessionId) ?? [])];
    this.historyIndex = this.history.length;
    this.buffer = [];
    this.cursor = 0;
    this.completionIndex = 0;
    this.cancelInputRedraw();
    if (!this.flushDeferredWrites()) this.redraw();
  }

  setQueue(items: QueuedInput[]): void {
    this.queued = items.map((item) => ({ ...item }));
    this.redraw();
  }

  setTasks(tasks: PlanStep[]): void {
    this.tasks = tasks.map((task) => ({ ...task }));
    this.redraw();
  }

  clearScreen(content = ''): void {
    this.cancelInputRedraw();
    this.outputOpen = false;
    this.outputOpenWidth = 0;
    this.output.write('\x1b[2J\x1b[H');
    if (content) this.output.write(`${content}\n\n`);
    this.draw();
  }

  async select(
    items: SelectItem[],
    title = '选择',
    initialValue?: string,
  ): Promise<string | undefined> {
    if (!items.length) return undefined;
    this.cancelInputRedraw();
    this.eraseUi();
    return new Promise((resolve) => {
      const initialIndex = initialValue === undefined
        ? -1
        : items.findIndex((item) => item.value === initialValue);
      this.selectState = { items, index: Math.max(0, initialIndex), title, resolve };
      this.draw();
    });
  }

  close(): void {
    if (this.closed) return;
    if (this.busyTimer) clearTimeout(this.busyTimer);
    this.busyTimer = undefined;
    this.stopIdleBlink();
    if (this.escapeTimer) clearTimeout(this.escapeTimer);
    this.escapeTimer = undefined;
    this.cancelInputRedraw();
    this.eraseUi();
    const selection = this.selectState;
    this.selectState = undefined;
    selection?.resolve();
    this.closed = true;
    if (this.pasteDataListener) this.input.removeListener('data', this.pasteDataListener);
    if (this.resizeListener) this.output.removeListener('resize', this.resizeListener);
    if (this.input.isTTY) this.output.write('\x1b[?2004l');
    this.output.write('\n');
    if (this.input.isTTY) this.input.setRawMode(false);
    this.input.pause();
  }

  private get suggestions(): CompletionItem[] {
    if (this.browsingHistory) return [];
    const value = this.buffer.join('');
    if (!value.startsWith('/') || value.includes(' ')) return [];
    return this.completions.filter((item) => item.value.startsWith(value));
  }

  private get browsingHistory(): boolean {
    return this.historyIndex < this.history.length;
  }

  private handleSelection(key: Key): void {
    const state = this.selectState!;
    if (key.name === 'up' || key.name === 'down') {
      const direction = key.name === 'up' ? -1 : 1;
      state.index = (state.index + direction + state.items.length) % state.items.length;
      this.redraw();
      return;
    }
    if (key.name !== 'return' && key.name !== 'enter' && key.name !== 'escape') return;
    const value = key.name === 'escape' ? undefined : state.items[state.index]?.value;
    this.eraseUi();
    this.selectState = undefined;
    state.resolve(value);
    this.draw();
  }

  private setBuffer(value: string): void {
    this.buffer = Array.from(value);
    this.cursor = this.buffer.length;
    this.completionIndex = 0;
    this.redrawAfterInput();
  }

  private insertText(value: string): void {
    this.insertRawText(value);
    this.redrawAfterInput();
  }

  private insertRawText(value: string): void {
    const characters = Array.from(value.replace(/\r\n?/g, '\n').replace(/\x1b/g, ''));
    if (!characters.length) return;
    this.buffer.splice(this.cursor, 0, ...characters);
    this.cursor += characters.length;
    this.completionIndex = 0;
  }

  private handlePasteData(chunk: Buffer | string): void {
    const value = this.pastePending + chunk.toString();
    this.pastePending = '';
    const startMarker = '\x1b[200~';
    const endMarker = '\x1b[201~';
    if (!this.bracketPaste && !value.includes(startMarker)) return;
    this.suppressPasteKeypress = true;
    queueMicrotask(() => { this.suppressPasteKeypress = false; });
    let offset = 0;
    let changed = false;
    while (offset < value.length) {
      if (!this.bracketPaste) {
        const start = value.indexOf(startMarker, offset);
        if (start < 0) {
          this.insertRawText(value.slice(offset));
          changed = offset < value.length;
          break;
        }
        if (start > offset) {
          this.insertRawText(value.slice(offset, start));
          changed = true;
        }
        this.bracketPaste = true;
        offset = start + startMarker.length;
      } else {
        const end = value.indexOf(endMarker, offset);
        if (end < 0) {
          const remainder = value.slice(offset);
          const pendingLength = this.markerPrefixLength(remainder, endMarker);
          const content = remainder.slice(0, remainder.length - pendingLength);
          this.pastePending = remainder.slice(remainder.length - pendingLength);
          if (content) {
            this.insertRawText(content);
            changed = true;
          }
          break;
        }
        const content = value.slice(offset, end);
        if (content) {
          this.insertRawText(content);
          changed = true;
        }
        this.bracketPaste = false;
        offset = end + endMarker.length;
      }
    }
    if (changed) this.redrawAfterInput();
  }

  private markerPrefixLength(value: string, marker: string): number {
    const limit = Math.min(value.length, marker.length - 1);
    for (let length = limit; length > 0; length -= 1) {
      if (marker.startsWith(value.slice(-length))) return length;
    }
    return 0;
  }

  private lineStart(position: number): number {
    let index = Math.max(0, Math.min(position, this.buffer.length));
    while (index > 0 && this.buffer[index - 1] !== '\n') index -= 1;
    return index;
  }

  private lineEnd(position: number): number {
    let index = Math.max(0, Math.min(position, this.buffer.length));
    while (index < this.buffer.length && this.buffer[index] !== '\n') index += 1;
    return index;
  }

  private moveVertical(direction: -1 | 1): void {
    const start = this.lineStart(this.cursor);
    const column = this.cursor - start;
    if (direction < 0) {
      if (start === 0) return;
      const previousEnd = start - 1;
      const previousStart = this.lineStart(previousEnd);
      this.cursor = Math.min(previousStart + column, previousEnd);
    } else {
      const end = this.lineEnd(this.cursor);
      if (end === this.buffer.length) return;
      const nextStart = end + 1;
      this.cursor = Math.min(nextStart + column, this.lineEnd(nextStart));
    }
    this.redrawAfterInput();
  }

  private redraw(inputSafePoint = false): void {
    if (this.closed || !this.started) return;
    if (this.inputRedrawTimer) return;
    if (this.imeSafeInput && this.buffer.length > 0 && !inputSafePoint) return;
    this.eraseUi();
    this.draw();
  }

  private redrawAfterInput(): void {
    if (this.closed || !this.started) return;
    if (this.imeSafeInput && this.buffer.length === 0 && this.deferredWrites.length > 0) {
      this.cancelInputRedraw();
      this.flushDeferredWrites();
      return;
    }
    if (this.inputRedrawDelayMs <= 0) {
      this.redraw(true);
      return;
    }
    this.cancelInputRedraw();
    this.inputRedrawTimer = setTimeout(() => {
      this.inputRedrawTimer = undefined;
      this.redraw(true);
    }, this.inputRedrawDelayMs);
    this.inputRedrawTimer.unref();
  }

  private cancelInputRedraw(): void {
    if (this.inputRedrawTimer) clearTimeout(this.inputRedrawTimer);
    this.inputRedrawTimer = undefined;
  }

  private flushDeferredWrites(): boolean {
    if (!this.deferredWrites.length) return false;
    const writes = this.deferredWrites;
    this.deferredWrites = [];
    for (const { chunk, stream } of writes) this.writeNow(chunk, stream);
    return true;
  }

  private eraseUi(): void {
    if (this.closed || !this.started) return;
    this.output.write(clearLine);
    for (let row = 1; row < this.renderedRows; row += 1) this.output.write('\x1b[1A\r\x1b[2K');
    this.renderedRows = 0;
  }

  private draw(): void {
    if (this.closed || !this.started) return;
    const rows: string[] = [];
    rows.push(...this.queued.map((item) => item.intent === 'steer'
      ? `\x1b[93m↯ 引导  ${this.compactQueueItem(item.text)}\x1b[0m`
      : `\x1b[2m↳ 排队  ${this.compactQueueItem(item.text)}\x1b[0m`));

    if (this.selectState) {
      const state = this.selectState;
      const visible = this.window(state.items, state.index, 7);
      rows.push(this.truncateDisplay(
        `${state.title} · ↑↓ 移动，Enter 确认，Esc 取消`,
        Math.max(4, (this.output.columns ?? 80) - 1),
      ));
      for (const { item, index } of visible) {
        const marker = index === state.index ? selectionCursor : ' ';
        rows.push(this.selectionLine(marker, item));
      }
      rows.push(...this.taskRows());
      rows.push(this.statusLine());
      const input = this.inputBox();
      rows.push(...input.lines);
      this.output.write(rows.join('\n'));
      this.renderedRows = this.physicalRows(rows);
      this.placeInputCursor(input);
      return;
    }

    const suggestions = this.suggestions;
    const visible = this.window(suggestions, this.completionIndex, 7);
    for (const { item, index } of visible) {
      const active = index === this.completionIndex;
      rows.push(`${active ? selectionCursor : ' '} ${item.value.padEnd(12)} \x1b[2m${item.description}\x1b[0m`);
    }
    rows.push(...this.taskRows());
    rows.push(this.statusLine());
    const input = this.inputBox();
    rows.push(...input.lines);
    this.output.write(rows.join('\n'));
    this.renderedRows = this.physicalRows(rows);
    this.placeInputCursor(input);
  }

  private physicalRows(rows: string[]): number {
    const width = Math.max(1, this.output.columns ?? 80);
    return rows.reduce((total, row) => total + Math.max(1, Math.ceil(displayWidth(row) / width)), 0);
  }

  private inputBox(): { lines: string[]; cursorRow: number; cursorColumn: number } {
    const prefix = '┊> ';
    const prefixWidth = displayWidth(prefix);
    const terminalWidth = usableTerminalWidth(this.output.columns);
    // Terminal.app 2.15 on macOS 26 can crash when IME marked text wraps. The
    // marked text is owned by the terminal and is invisible to this editor, so
    // keep enough blank columns after the cursor for an in-progress conversion.
    const compositionMargin = Math.min(16, Math.max(4, terminalWidth - 8));
    const width = terminalWidth - compositionMargin;
    const available = Math.max(2, width - prefixWidth);
    if (this.singleLineInputViewport) {
      return this.singleLineInputBox(prefixWidth, available);
    }
    const value = this.buffer.join('');
    const logicalLines = value.split('\n');
    const beforeCursor = this.buffer.slice(0, this.cursor).join('');
    const logicalCursorRow = beforeCursor.split('\n').length - 1;
    const cursorOffset = Array.from(beforeCursor.split('\n').at(-1) ?? '').length;
    let cursorRow = 0;
    let cursorColumn = prefixWidth;
    let cursorPlaced = false;
    const allLines: string[] = [];
    for (const [logicalRow, line] of logicalLines.entries()) {
      const characters = Array.from(line);
      const wrapped: Array<{ start: number; end: number; text: string }> = [];
      let start = 0;
      let used = 0;
      for (const [index, character] of characters.entries()) {
        const characterWidth = displayWidth(character);
        if (used > 0 && used + characterWidth > available) {
          wrapped.push({ start, end: index, text: characters.slice(start, index).join('') });
          start = index;
          used = 0;
        }
        used += characterWidth;
      }
      wrapped.push({ start, end: characters.length, text: characters.slice(start).join('') });

      for (const [wrappedRow, segment] of wrapped.entries()) {
        const linePrefix = logicalRow === 0 && wrappedRow === 0
          ? '\x1b[90m┊\x1b[0m> '
          : '\x1b[90m┊\x1b[0m  ';
        allLines.push(`${linePrefix}${segment.text}`);
        if (
          !cursorPlaced && logicalRow === logicalCursorRow &&
          cursorOffset >= segment.start && cursorOffset <= segment.end
        ) {
          cursorRow = allLines.length - 1;
          cursorColumn = prefixWidth + displayWidth(characters.slice(segment.start, cursorOffset).join(''));
          cursorPlaced = true;
        }
      }
    }
    const start = Math.max(
      0,
      Math.min(cursorRow - Math.floor(maxVisibleInputRows / 2), allLines.length - maxVisibleInputRows),
    );
    const end = Math.min(allLines.length, start + maxVisibleInputRows);
    const lines = allLines.slice(start, end);
    if (start > 0) {
      lines.unshift(`\x1b[90m┊\x1b[0m  \x1b[2m… 上方 ${start} 行已隐藏\x1b[0m`);
    }
    if (end < allLines.length) {
      lines.push(`\x1b[90m┊\x1b[0m  \x1b[2m… 下方 ${allLines.length - end} 行已隐藏\x1b[0m`);
    }
    return {
      lines,
      cursorRow: cursorRow - start + (start > 0 ? 1 : 0),
      cursorColumn,
    };
  }

  private singleLineInputBox(
    prefixWidth: number,
    available: number,
  ): { lines: string[]; cursorRow: number; cursorColumn: number } {
    const lineStart = this.lineStart(this.cursor);
    const lineEnd = this.lineEnd(this.cursor);
    const characters = this.buffer.slice(lineStart, lineEnd);
    const cursorOffset = this.cursor - lineStart;
    let visibleStart = cursorOffset;
    let usedBeforeCursor = 0;
    while (visibleStart > 0) {
      const characterWidth = displayWidth(characters[visibleStart - 1] ?? '');
      if (usedBeforeCursor + characterWidth > available) break;
      visibleStart -= 1;
      usedBeforeCursor += characterWidth;
    }
    const visible: string[] = [];
    let used = 0;
    for (const character of characters.slice(visibleStart)) {
      const characterWidth = displayWidth(character);
      if (used + characterWidth > available) break;
      visible.push(character);
      used += characterWidth;
    }
    return {
      lines: [`\x1b[90m┊\x1b[0m> ${visible.join('')}`],
      cursorRow: 0,
      cursorColumn: prefixWidth + usedBeforeCursor,
    };
  }

  private placeInputCursor(input: { lines: string[]; cursorRow: number; cursorColumn: number }): void {
    this.output.write('\r');
    const rowsUp = input.lines.length - 1 - input.cursorRow;
    if (rowsUp > 0) this.output.write(`\x1b[${rowsUp}A`);
    this.output.write(`\x1b[${input.cursorColumn}C`);
  }

  private compactQueueItem(value: string): string {
    const clean = value.replace(/\s+/g, ' ').trim();
    const width = Math.max(20, (this.output.columns ?? 80) - 14);
    if (displayWidth(clean) <= width) return clean;
    const visible: string[] = [];
    let used = 0;
    for (const character of Array.from(clean)) {
      const characterWidth = displayWidth(character);
      if (used + characterWidth > width - 3) break;
      visible.push(character);
      used += characterWidth;
    }
    return `${visible.join('')}...`;
  }

  private selectionLine(marker: string, item: SelectItem): string {
    const width = Math.max(4, (this.output.columns ?? 80) - 1);
    const prefix = `${marker} `;
    const available = Math.max(1, width - displayWidth(prefix));
    const label = item.label.replace(/\s+/g, ' ').trim();
    const detail = item.detail?.replace(/\s+/g, ' ').trim();
    if (!detail || displayWidth(label) + displayWidth(detail) + 2 > available) {
      const shortLabel = this.truncateDisplay(label, available);
      const remaining = available - displayWidth(shortLabel) - 2;
      if (!detail || remaining < 4) return `${prefix}${shortLabel}`;
      return `${prefix}${shortLabel}  \x1b[2m${this.truncateDisplay(detail, remaining)}\x1b[0m`;
    }
    return `${prefix}${label}  \x1b[2m${detail}\x1b[0m`;
  }

  private statusLine(): string {
    const busyElapsed = Date.now() - this.busyStartedAt;
    const fallbackFrame = renderMimiFrame('running', busyElapsed, this.busyFrame);
    const fallbackElapsed = formatRunDuration(busyElapsed);
    const state = this.busy
      ? (this.transient || `${fallbackFrame} 运行中 · ${fallbackElapsed}`)
      : this.idleBlink ? '^-.-^~' : '^._.^~';
    const model = this.truncateDisplay(this.runtime.model, 24);
    const contextLabel = this.runtime.contextSource === 'estimate'
      ? '上下文 ~'
      : this.runtime.contextSource === 'raw-history' ? '历史 ~' : '上下文 ';
    const sourceLabel = this.runtime.contextSource === 'actual'
      ? ' actual'
      : this.runtime.contextSource === 'estimate'
        ? ' est'
        : this.runtime.contextSource === 'raw-history' ? ' raw' : '';
    const compression = this.runtime.compressedFrom
      ? ` · 已压缩 ${this.formatTokens(this.runtime.compressedFrom)}→${this.formatTokens(this.runtime.contextUsed)}`
      : '';
    const text = `${state} · 模式 ${this.runtime.mode} · 模型 ${model} · ${contextLabel}${this.formatTokens(this.runtime.contextUsed)}${sourceLabel}/${this.formatTokens(this.runtime.contextWindow)}${compression}`;
    return `\x1b[90m${this.truncateDisplay(text, Math.max(24, (this.output.columns ?? 80) - 1))}\x1b[0m`;
  }

  private scheduleBusyRedraw(): void {
    if (this.imeSafeInput) return;
    this.busyTimer = setTimeout(() => {
      if (!this.busy) return;
      this.busyFrame += 1;
      if (!this.transient) this.redraw();
      this.scheduleBusyRedraw();
    }, MIMI_TAIL_INTERVAL_MS);
    this.busyTimer.unref();
  }

  private scheduleIdleBlink(): void {
    if (this.imeSafeInput || this.busy || this.closed || this.idleBlinkTimer) return;
    this.idleBlinkTimer = setTimeout(() => {
      this.idleBlinkTimer = undefined;
      if (this.busy || this.closed) return;
      this.idleBlink = true;
      this.redraw();
      this.idleBlinkResetTimer = setTimeout(() => {
        this.idleBlinkResetTimer = undefined;
        if (this.busy || this.closed) return;
        this.idleBlink = false;
        this.redraw();
        this.scheduleIdleBlink();
      }, this.idleBlinkDurationMs);
      this.idleBlinkResetTimer.unref();
    }, this.idleBlinkIntervalMs);
    this.idleBlinkTimer.unref();
  }

  private stopIdleBlink(): void {
    if (this.idleBlinkTimer) clearTimeout(this.idleBlinkTimer);
    if (this.idleBlinkResetTimer) clearTimeout(this.idleBlinkResetTimer);
    this.idleBlinkTimer = undefined;
    this.idleBlinkResetTimer = undefined;
    this.idleBlink = false;
  }

  private taskRows(): string[] {
    if (!this.tasks.length) return [];
    const completed = this.tasks.filter((task) => task.status === 'completed').length;
    const width = Math.max(4, (this.output.columns ?? 80) - 1);
    if (completed === this.tasks.length) {
      return [`\x1b[92m${this.truncateDisplay(`✓ 任务 ${completed}/${this.tasks.length} · 已全部完成`, width)}\x1b[0m`];
    }
    const runningIndex = this.tasks.findIndex((task) => task.status === 'running');
    const pendingIndex = this.tasks.findIndex((task) => task.status !== 'completed');
    const activeIndex = runningIndex >= 0 ? runningIndex : Math.max(0, pendingIndex);
    const rows = [`\x1b[90m任务 ${completed}/${this.tasks.length}\x1b[0m`];
    for (const { item } of this.window(this.tasks, activeIndex, 5)) {
      const style = item.status === 'completed' ? '\x1b[92m✓'
        : item.status === 'running' ? '\x1b[96m●'
          : item.status === 'failed' ? '\x1b[91m×' : '\x1b[90m○';
      rows.push(`${style}\x1b[0m ${this.truncateDisplay(item.description.replace(/\s+/g, ' ').trim(), width - 2)}`);
    }
    if (this.tasks.length > 5) rows.push(`\x1b[90m${this.truncateDisplay(`… 其余 ${this.tasks.length - 5} 项`, width)}\x1b[0m`);
    return rows;
  }

  private formatTokens(value: number): string {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}m`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
    return String(value);
  }

  private truncateDisplay(value: string, width: number): string {
    if (displayWidth(value) <= width) return value;
    if (width <= 3) return '.'.repeat(Math.max(0, width));
    const visible: string[] = [];
    let used = 0;
    for (const character of Array.from(value)) {
      const characterWidth = displayWidth(character);
      if (used + characterWidth > width - 3) break;
      visible.push(character);
      used += characterWidth;
    }
    return `${visible.join('')}...`;
  }

  private window<T>(items: T[], selected: number, size: number): Array<{ item: T; index: number }> {
    const start = Math.max(0, Math.min(selected - Math.floor(size / 2), items.length - size));
    return items.slice(start, start + size).map((item, offset) => ({ item, index: start + offset }));
  }
}
