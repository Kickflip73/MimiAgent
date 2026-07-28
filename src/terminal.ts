import type { AgentInputItem, RunStreamEvent } from '@openai/agents';
import type { RunCheckpoint } from './core/session.js';
import type { RuntimeEvent } from './runtime/hooks.js';

type Writable = {
  write(chunk: string): unknown;
  isTTY?: boolean;
};

type StatusTone = 'agent' | 'thinking' | 'tool' | 'success' | 'failure';
export type RunMotion = 'thinking' | 'running';

export const OUTPUT_LEVELS = [
  { id: 'answer', label: '答案', description: '只显示最终答案', rank: 0 },
  { id: 'thinking', label: '思考', description: '显示思考过程和最终答案', rank: 1 },
  { id: 'tools', label: '工具', description: '显示工具调用和简要结果', rank: 2 },
  { id: 'trace', label: '详细', description: '显示输入、工具参数和完整结果', rank: 3 },
] as const;

export type OutputLevel = typeof OUTPUT_LEVELS[number]['id'];

export function normalizeOutputLevel(value?: string): OutputLevel {
  return OUTPUT_LEVELS.some((level) => level.id === value) ? value as OutputLevel : 'tools';
}

export type DisplayEvent =
  | { kind: 'answer'; text: string }
  | { kind: 'reasoning'; text: string }
  | {
      kind: 'status';
      tone: StatusTone;
      title: string;
      detail?: string;
      fullDetail?: string;
      next: string;
      nextMotion?: RunMotion;
    };

const ansi = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  code: '\x1b[38;2;148;166;173m',
  gray: '\x1b[90m',
};

const badges: Record<StatusTone | 'answer' | 'done', { icon: string; label: string; color: string }> = {
  agent: { icon: '◆', label: 'Agent', color: '\x1b[90m' },
  thinking: { icon: '✦', label: '思考', color: '\x1b[94m' },
  tool: { icon: '●', label: '工具', color: '\x1b[96m' },
  success: { icon: '└', label: '结果', color: '\x1b[92m' },
  failure: { icon: '×', label: '失败', color: '\x1b[91m' },
  answer: { icon: '◆', label: '回答', color: '\x1b[95m' },
  done: { icon: '✓', label: '完成', color: '\x1b[92m' },
};

const MIMI_THINKING_FACES = [
  '^._.^',
  '^._?^',
  '^-_-^',
  '^?_.^',
  '^-.-^',
  '^._.^',
] as const;
const MIMI_RUNNING_FACES = [
  '^._.^',
  '^>_<^',
  '^._.^',
  '^=w=^',
  '^>_<^',
  '^-.-^',
] as const;
const MIMI_TAILS = ['~', '-', '\\', '|', '/', '-'] as const;
export const MIMI_TAIL_INTERVAL_MS = 250;
export const MIMI_THINKING_EXPRESSION_INTERVAL_MS = 10_000;
export const MIMI_RUNNING_EXPRESSION_INTERVAL_MS = 8_000;
const motionConfig: Record<RunMotion, { faces: readonly string[]; expressionIntervalMs: number }> = {
  thinking: {
    faces: MIMI_THINKING_FACES,
    expressionIntervalMs: MIMI_THINKING_EXPRESSION_INTERVAL_MS,
  },
  running: {
    faces: MIMI_RUNNING_FACES,
    expressionIntervalMs: MIMI_RUNNING_EXPRESSION_INTERVAL_MS,
  },
};

export function renderMimiFrame(motion: RunMotion, motionElapsedMs: number, tailFrame: number): string {
  const config = motionConfig[motion];
  const faceIndex = Math.floor(Math.max(0, motionElapsedMs) / config.expressionIntervalMs) % config.faces.length;
  const face = config.faces[faceIndex] ?? config.faces[0];
  const tail = MIMI_TAILS[tailFrame % MIMI_TAILS.length] ?? MIMI_TAILS[0];
  return `${face}${tail}`;
}

export function formatRunDuration(durationMs: number): string {
  const totalSeconds = Math.floor(Math.max(0, durationMs) / 1_000);
  const seconds = totalSeconds % 60;
  if (totalSeconds < 60) return `${totalSeconds}秒`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  if (totalMinutes < 60) return `${totalMinutes}分 ${String(seconds).padStart(2, '0')}秒`;
  const hours = Math.floor(totalMinutes / 60);
  return `${hours}小时 ${String(minutes).padStart(2, '0')}分 ${String(seconds).padStart(2, '0')}秒`;
}

export interface BannerInfo {
  version: string;
  provider: string;
  model: string;
  sessionTitle: string;
  workspaceRoot: string;
  skillCount: number;
  mcpServers: string[];
}

export function renderBanner(info: BannerInfo, tty = true): string {
  const muted = (text: string) => tty ? `${ansi.gray}${text}${ansi.reset}` : text;
  const strong = (text: string) => tty ? `${ansi.bold}${text}${ansi.reset}` : text;
  return [
    `${strong('MimiAgent')} ${muted(`v${info.version}`)}`,
    '全天候个人 Agent',
    `模型    ${info.provider} · ${info.model}`,
    `对话    ${info.sessionTitle}`,
    `扩展    Skills ${info.skillCount} · MCP ${info.mcpServers.length || '未连接'}`,
    `工作区  ${info.workspaceRoot}`,
  ].join('\n');
}

function sessionItemText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    const value = record(part);
    if (typeof value?.text === 'string') return value.text;
    if (value?.type === 'input_image') return '[图片]';
    if (value?.type === 'input_file') return '[附件]';
    return '';
  }).filter(Boolean).join('\n');
}

export function renderUserInput(value: string, tty = true): string {
  const lines = value.replace(/\x1b/g, '').trim().split(/\r?\n/);
  if (!tty) return lines.map((line, index) => `${index === 0 ? '▸' : ' '} ${line}`).join('\n');
  const marker = '\x1b[96m▸\x1b[0m';
  return lines.map((line, index) => {
    const content = `\x1b[100;97m ${line} \x1b[0m`;
    return `${index === 0 ? marker : ' '}${content}`;
  }).join('\n');
}

export function renderRecoveryCheckpoint(checkpoint: RunCheckpoint | undefined, tty = true): string {
  if (!checkpoint || checkpoint.status === 'completed') return '';
  const label = tty ? '\x1b[96m↻ 可恢复\x1b[0m' : '↻ 可恢复';
  const detail = [checkpoint.phase, checkpoint.lastEvent].filter(Boolean).join(' · ');
  return `${label}  ${detail || checkpoint.input}  ${tty ? '\x1b[90m/resume 继续\x1b[0m' : '/resume 继续'}`;
}

/** Render persisted user/assistant messages for terminal scrollback after a session switch. */
export function renderSessionTranscript(items: AgentInputItem[], tty = true): string {
  const blocks: string[] = [];
  for (const item of items) {
    if (!('role' in item) || (item.role !== 'user' && item.role !== 'assistant') || !('content' in item)) continue;
    const text = sessionItemText(item.content).replace(/\x1b/g, '').trim();
    if (!text) continue;
    if (item.role === 'user') {
      blocks.push(renderUserInput(text, tty));
      continue;
    }
    blocks.push(renderAssistantAnswer(text, tty));
  }
  return blocks.join('\n\n');
}

export function renderAssistantAnswer(value: string, tty = true): string {
  const answer = renderMarkdownText(value.replace(/\x1b/g, '').trim(), tty);
  return `${badge('answer', tty)}\n${answer}`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

function compact(value: unknown, limit = 160): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return '';
  const singleLine = text.replace(/\s+/g, ' ').trim();
  return singleLine.length <= limit ? singleLine : `${singleLine.slice(0, Math.max(0, limit - 3))}...`;
}

function detailed(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return String(value);
  }
}

function rawItem(event: RunStreamEvent): Record<string, unknown> | undefined {
  if (event.type !== 'run_item_stream_event') return undefined;
  return record(record(event.item)?.rawItem);
}

export function parseRunEvent(event: RunStreamEvent): DisplayEvent | undefined {
  if (event.type === 'agent_updated_stream_event') {
    return {
      kind: 'status',
      tone: 'agent',
      title: event.agent.name,
      next: 'Agent 工作中',
    };
  }

  if (event.type === 'run_item_stream_event') {
    const raw = rawItem(event);
    if (event.name === 'tool_called') {
      const name = typeof raw?.name === 'string' ? raw.name : 'unknown';
      return {
        kind: 'status',
        tone: 'tool',
        title: name,
        detail: compact(raw?.arguments),
        fullDetail: detailed(raw?.arguments),
        next: `正在执行 ${name}`,
        nextMotion: 'running',
      };
    }
    if (event.name === 'tool_output') {
      const item = record(event.item);
      const name = typeof raw?.name === 'string' ? raw.name : 'tool';
      if (name === 'run_team') {
        return {
          kind: 'status',
          tone: 'success',
          title: 'Ultra Team',
          detail: '本轮并行任务已结束',
          fullDetail: detailed(item?.output),
          next: '模型继续思考',
        };
      }
      return {
        kind: 'status',
        tone: 'success',
        title: name,
        detail: compact(item?.output, 120),
        fullDetail: detailed(item?.output),
        next: '模型继续思考',
      };
    }
    if (event.name === 'reasoning_item_created') {
      return {
        kind: 'status',
        tone: 'thinking',
        title: '推理阶段完成',
        next: '生成回答',
      };
    }
    return undefined;
  }

  if (event.type !== 'raw_model_stream_event') return undefined;
  if (event.data.type === 'output_text_delta') {
    return { kind: 'answer', text: event.data.delta };
  }
  if (event.data.type !== 'model') return undefined;

  const providerEvent = record(event.data.event);
  const choices = Array.isArray(providerEvent?.choices) ? providerEvent.choices : undefined;
  const choice = record(choices?.[0]);
  const delta = record(choice?.delta);
  if (typeof delta?.reasoning_content === 'string') {
    return { kind: 'reasoning', text: delta.reasoning_content };
  }
  if (
    providerEvent?.type === 'response.reasoning_summary_text.delta' &&
    typeof providerEvent.delta === 'string'
  ) {
    return { kind: 'reasoning', text: providerEvent.delta };
  }
  return undefined;
}

function inlineMarkdown(text: string, tty: boolean): string {
  let value = text.replace(/\x1b/g, '').replace(/[ \t]{3,}/g, ' ');
  value = value.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1 ($2)');
  value = value.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label: string, url: string) =>
    tty ? `${label} ${ansi.dim}(${url})${ansi.reset}` : `${label} (${url})`,
  );
  value = value.replace(/`([^`]+)`/g, (_, code: string) =>
    tty ? `${ansi.code}${code}${ansi.reset}` : code,
  );
  value = value.replace(/\*\*([^*]+)\*\*/g, (_, content: string) =>
    tty ? `${ansi.bold}${content}${ansi.reset}` : content,
  );
  value = value.replace(/__([^_]+)__/g, (_, content: string) =>
    tty ? `${ansi.bold}${content}${ansi.reset}` : content,
  );
  value = value.replace(/~~([^~]+)~~/g, '$1');
  value = value.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, (_, content: string) =>
    tty ? `${ansi.italic}${content}${ansi.reset}` : content,
  );
  return value;
}

type TableAlignment = 'left' | 'center' | 'right';

interface MarkdownTable {
  rows: string[][];
  alignments: TableAlignment[];
}

function parseTableRow(source: string): string[] | undefined {
  let line = source.trim();
  if (!line.includes('|')) return undefined;
  if (line.startsWith('|')) line = line.slice(1);
  if (line.endsWith('|') && !line.endsWith('\\|')) line = line.slice(0, -1);

  const cells: string[] = [];
  let cell = '';
  let escaped = false;
  for (const character of line) {
    if (escaped) {
      cell += character;
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      cell += character;
      continue;
    }
    if (character === '|') {
      cells.push(cell.trim());
      cell = '';
      continue;
    }
    cell += character;
  }
  cells.push(cell.trim());
  return cells.length >= 2 ? cells : undefined;
}

function parseTableDivider(source: string): TableAlignment[] | undefined {
  const cells = parseTableRow(source);
  if (!cells || !cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s/g, '')))) return undefined;
  return cells.map((cell) => {
    const marker = cell.replace(/\s/g, '');
    if (marker.startsWith(':') && marker.endsWith(':')) return 'center';
    return marker.endsWith(':') ? 'right' : 'left';
  });
}

function terminalWidth(value: string): number {
  const plain = value.replace(/\x1b\[[0-9;]*m/g, '');
  let width = 0;
  for (const character of plain) {
    const code = character.codePointAt(0) ?? 0;
    width += code >= 0x1100 && (
      code <= 0x115f
      || code === 0x2329
      || code === 0x232a
      || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f)
      || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe10 && code <= 0xfe19)
      || (code >= 0xfe30 && code <= 0xfe6f)
      || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6)
      || (code >= 0x1f300 && code <= 0x1faff)
    ) ? 2 : 1;
  }
  return width;
}

function padTableCell(value: string, width: number, alignment: TableAlignment): string {
  const remaining = Math.max(0, width - terminalWidth(value));
  if (alignment === 'right') return `${' '.repeat(remaining)}${value}`;
  if (alignment === 'center') {
    const left = Math.floor(remaining / 2);
    return `${' '.repeat(left)}${value}${' '.repeat(remaining - left)}`;
  }
  return `${value}${' '.repeat(remaining)}`;
}

function renderMarkdownTable(table: MarkdownTable, tty: boolean): string {
  const renderedRows = table.rows.map((row) => row.map((cell) => inlineMarkdown(cell, tty)));
  const widths = table.alignments.map((_, index) =>
    Math.max(1, ...renderedRows.map((row) => terminalWidth(row[index] ?? ''))),
  );
  const border = (left: string, middle: string, right: string) =>
    `${left}${widths.map((width) => '─'.repeat(width + 2)).join(middle)}${right}`;
  const row = (cells: string[], header = false) => {
    const content = cells.map((cell, index) => {
      const value = header && tty ? `${ansi.bold}${cell}${ansi.reset}` : cell;
      return ` ${padTableCell(value, widths[index]!, table.alignments[index]!)} `;
    });
    return `│${content.join('│')}│`;
  };
  return [
    border('┌', '┬', '┐'),
    row(renderedRows[0] ?? [], true),
    border('├', '┼', '┤'),
    ...renderedRows.slice(1).map((cells) => row(cells)),
    border('└', '┴', '┘'),
  ].join('\n');
}

function renderMarkdownText(source: string, tty: boolean): string {
  const lines = source.split(/\r?\n/);
  const state = { code: false };
  const rendered: string[] = [];
  for (let index = 0; index < lines.length;) {
    const header = parseTableRow(lines[index] ?? '');
    const alignments = parseTableDivider(lines[index + 1] ?? '');
    if (!state.code && header && alignments && header.length === alignments.length) {
      const rows = [header];
      index += 2;
      while (index < lines.length) {
        const cells = parseTableRow(lines[index] ?? '');
        if (!cells || cells.length !== header.length) break;
        rows.push(cells);
        index += 1;
      }
      rendered.push(renderMarkdownTable({ rows, alignments }, tty));
      continue;
    }
    rendered.push(renderMarkdownLine(lines[index] ?? '', tty, state));
    index += 1;
  }
  return rendered.join('\n');
}

export function renderMarkdownLine(
  source: string,
  tty = true,
  state: { code: boolean } = { code: false },
): string {
  const line = source.replace(/\x1b/g, '');
  const fence = line.match(/^\s*```\s*([^`]*)$/);
  if (fence) {
    state.code = !state.code;
    const language = fence[1]?.trim();
    if (state.code) return language ? `  ┌─ ${language}` : '  ┌─';
    return '  └─';
  }
  if (state.code) {
    return tty ? `  ${ansi.gray}│ ${line}${ansi.reset}` : `  │ ${line}`;
  }

  const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+)$/);
  if (heading) {
    const text = inlineMarkdown(heading[2]!, tty);
    const indent = heading[1]!.length > 2 ? '  ' : '';
    return tty ? `${indent}${ansi.bold}${text}${ansi.reset}` : `${indent}${text}`;
  }
  if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
    return tty ? `${ansi.dim}${'─'.repeat(48)}${ansi.reset}` : '─'.repeat(48);
  }

  const tableDivider = line.match(/^\s*\|?(?:\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?\s*$/);
  if (tableDivider) return tty ? `${ansi.dim}${'─'.repeat(48)}${ansi.reset}` : '─'.repeat(48);
  if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
    const cells = line.trim().slice(1, -1).split('|').map((cell) => inlineMarkdown(cell.trim(), tty));
    return `  ${cells.join('  │  ')}`;
  }

  const quote = line.match(/^\s*>\s?(.*)$/);
  if (quote) {
    const text = inlineMarkdown(quote[1]!, tty);
    return tty ? `${ansi.gray}│ ${text}${ansi.reset}` : `│ ${text}`;
  }
  const task = line.match(/^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/);
  if (task) return `${task[1]}${task[2]!.toLowerCase() === 'x' ? '✓' : '○'} ${inlineMarkdown(task[3]!, tty)}`;
  const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
  if (bullet) return `${bullet[1]}• ${inlineMarkdown(bullet[2]!, tty)}`;
  return inlineMarkdown(line, tty);
}

class MarkdownStream {
  private buffer = '';
  private readonly state = { code: false };
  private timer?: NodeJS.Timeout;
  private previousBlank = false;
  private partialLineOpen = false;
  private pendingTableHeader?: string;
  private table?: MarkdownTable;

  constructor(
    private readonly output: Writable,
    private readonly tty: boolean,
  ) {}

  write(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (this.partialLineOpen) {
        this.output.write(`${this.renderContinuation(line)}\n`);
        this.partialLineOpen = false;
        this.previousBlank = false;
        newline = this.buffer.indexOf('\n');
        continue;
      }
      this.writeCompleteLine(line);
      newline = this.buffer.indexOf('\n');
    }
    this.scheduleFlush();
  }

  flush(): boolean {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.buffer) {
      const wrotePartial = this.partialLineOpen || this.flushPendingTable();
      this.partialLineOpen = false;
      this.previousBlank = false;
      return wrotePartial;
    }
    if (this.partialLineOpen) {
      this.output.write(this.renderContinuation(this.buffer));
    } else {
      this.writeCompleteLine(this.buffer, false);
      this.flushPendingTable(false);
    }
    this.buffer = '';
    this.partialLineOpen = false;
    this.previousBlank = false;
    return true;
  }

  private scheduleFlush(): void {
    if (!this.buffer || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.canFlushPartial()) {
        this.scheduleFlush();
        return;
      }
      this.output.write(this.partialLineOpen
        ? this.renderContinuation(this.buffer)
        : renderMarkdownLine(this.buffer, this.tty, this.state));
      this.buffer = '';
      this.partialLineOpen = true;
    }, 45);
    this.timer.unref();
  }

  private canFlushPartial(): boolean {
    const trimmed = this.buffer.trim();
    if (!trimmed) return false;
    if (/^#{1,6}$/.test(trimmed) || trimmed.startsWith('```')) return false;
    if (parseTableRow(this.buffer) || parseTableDivider(this.buffer)) return false;
    const boldMarkers = (this.buffer.match(/\*\*/g) ?? []).length;
    const codeMarkers = (this.buffer.match(/(?<!`)`(?!`)/g) ?? []).length;
    return boldMarkers % 2 === 0 && codeMarkers % 2 === 0;
  }

  private renderContinuation(value: string): string {
    const clean = value.replace(/\x1b/g, '');
    if (this.state.code) return this.tty ? `${ansi.gray}${clean}${ansi.reset}` : clean;
    return inlineMarkdown(clean, this.tty);
  }

  private writeCompleteLine(line: string, newline = true): void {
    if (this.table) {
      const cells = parseTableRow(line);
      if (cells?.length === this.table.alignments.length) {
        this.table.rows.push(cells);
        return;
      }
      this.flushPendingTable();
    }

    if (this.pendingTableHeader !== undefined) {
      const header = parseTableRow(this.pendingTableHeader);
      const alignments = parseTableDivider(line);
      if (header && alignments && header.length === alignments.length) {
        this.table = { rows: [header], alignments };
        this.pendingTableHeader = undefined;
        return;
      }
      this.emitLine(this.pendingTableHeader);
      this.pendingTableHeader = undefined;
    }

    if (!this.state.code && parseTableRow(line) && !parseTableDivider(line)) {
      this.pendingTableHeader = line;
      return;
    }
    this.emitLine(line, newline);
  }

  private emitLine(line: string, newline = true): void {
    const blank = line.trim() === '';
    if (!blank || !this.previousBlank) {
      this.output.write(`${renderMarkdownLine(line, this.tty, this.state)}${newline ? '\n' : ''}`);
    }
    this.previousBlank = blank;
  }

  private flushPendingTable(newline = true): boolean {
    if (this.table) {
      this.output.write(`${renderMarkdownTable(this.table, this.tty)}${newline ? '\n' : ''}`);
      this.table = undefined;
      this.previousBlank = false;
      return true;
    }
    if (this.pendingTableHeader !== undefined) {
      this.emitLine(this.pendingTableHeader, newline);
      this.pendingTableHeader = undefined;
      return true;
    }
    return false;
  }
}

function badge(tone: keyof typeof badges, tty: boolean): string {
  const item = badges[tone];
  if (!tty) return `${item.icon} ${item.label}`;
  return `${item.color}${item.icon} ${item.label}${ansi.reset}`;
}

export class TerminalRenderer {
  private label = '';
  private spinnerFrame = 0;
  private spinnerTimer?: NodeJS.Timeout;
  private motion: RunMotion = 'thinking';
  private motionStartedAt = 0;
  private active?: 'answer' | 'reasoning';
  private markdown?: MarkdownStream;
  private hasBlock = false;
  private readonly startedAt = Date.now();
  private readonly levelRank: number;

  constructor(
    private readonly status: Writable = process.stderr,
    private readonly answer: Writable = process.stdout,
    private readonly level: OutputLevel = 'tools',
  ) {
    this.levelRank = OUTPUT_LEVELS.find((item) => item.id === level)?.rank ?? 2;
  }

  start(label = '模型思考中', input?: string, motion: RunMotion = 'thinking'): void {
    this.stopSpinner();
    if (this.levelRank >= 3 && input) {
      this.beginBlock(this.status);
      this.status.write(`${badge('agent', Boolean(this.status.isTTY))}  任务\n  ${this.limitDetail(input)}\n`);
    }
    this.label = label;
    this.motion = motion;
    this.motionStartedAt = Date.now();
    this.spinnerFrame = 0;
    if (!this.status.isTTY) {
      if (this.levelRank > 0) {
        this.status.write(`[运行] ${label}\n`);
        this.hasBlock = true;
      }
      return;
    }
    this.draw();
    this.scheduleSpinner();
  }

  handle(event: RunStreamEvent): void {
    const display = parseRunEvent(event);
    if (!display) return;
    this.handleDisplay(display);
  }

  handleDisplay(display: DisplayEvent): void {
    if (display.kind === 'reasoning' && this.levelRank < 1) return;
    if (display.kind === 'status') {
      if (display.tone === 'agent' && this.levelRank < 3) return;
      if (display.tone === 'thinking' && this.levelRank < 1) return;
      if (display.tone === 'tool' && this.levelRank < 2) return;
      if (display.tone === 'success' && this.levelRank < 2) return;
    }

    if (display.kind === 'status') {
      this.renderStatus(
        display.tone,
        display.title,
        display.detail,
        display.fullDetail,
        display.next,
        display.nextMotion,
      );
      return;
    }

    this.stopSpinner();
    if (display.kind === 'reasoning') {
      if (this.active !== 'reasoning') {
        this.closeActive();
        this.beginBlock(this.status);
        this.status.write(`${badge('thinking', Boolean(this.status.isTTY))}\n`);
        this.active = 'reasoning';
        this.markdown = new MarkdownStream(this.status, Boolean(this.status.isTTY));
      }
      this.markdown?.write(display.text);
      return;
    }

    if (this.active !== 'answer') {
      this.closeActive();
      if (this.levelRank > 0) {
        this.beginBlock(this.answer);
        this.answer.write(`${badge('answer', Boolean(this.answer.isTTY))}\n`);
      }
      this.active = 'answer';
      this.markdown = new MarkdownStream(this.answer, Boolean(this.answer.isTTY));
    }
    this.markdown?.write(display.text);
  }

  handleRuntimeEvent(event: RuntimeEvent): void {
    if (event.type === 'work_unit_event' && this.levelRank >= 2) {
      const unit = event.observation;
      const result = unit.result;
      const name = `${unit.descriptor.kind} ${unit.descriptor.role ?? 'worker'} · ${unit.descriptor.id}`;
      this.renderStatus(
        unit.status === 'failed' || unit.status === 'uncertain' ? 'failure' : 'success',
        name,
        compact(result?.summary ?? unit.status, 180),
        result?.summary,
        '父执行单元继续整合',
      );
      return;
    }
    if (event.type !== 'team_worker_event' || this.levelRank < 2) return;
    const name = `子代理 ${event.role} · ${event.taskId}`;
    if (event.eventType === 'start') {
      this.renderStatus(
        'agent',
        name,
        `分配任务：${compact(event.description, 160)}`,
        event.description,
        `${event.role} 子代理执行中`,
        'running',
      );
      return;
    }
    const result = event.result || (event.eventType === 'error' ? '未返回错误信息' : '未返回结果摘要');
    const failed = event.eventType === 'error';
    this.renderStatus(
      failed ? 'failure' : 'success',
      name,
      `${failed ? '失败' : '完成'}：${compact(result, 180)}`,
      result,
      'Ultra Team 继续执行',
    );
  }

  finish(): void {
    this.stopSpinner();
    this.closeActive();
    if (this.levelRank > 0) {
      this.beginBlock(this.status);
      this.status.write(`${badge('done', Boolean(this.status.isTTY))}  ${this.muted(formatRunDuration(Date.now() - this.startedAt), this.status)}\n`);
    }
  }

  stop(): void {
    this.stopSpinner();
    this.closeActive();
  }

  private beginBlock(output: Writable): void {
    if (this.hasBlock) output.write('\n');
    this.hasBlock = true;
  }

  private renderStatus(
    tone: StatusTone,
    title: string,
    detail: string | undefined,
    fullDetail: string | undefined,
    next: string,
    nextMotion: RunMotion = 'thinking',
  ): void {
    this.stopSpinner();
    this.closeActive();
    this.beginBlock(this.status);
    const value = this.levelRank >= 3 ? fullDetail : detail;
    const renderedDetail = value
      ? this.levelRank >= 3 ? `\n${this.renderDetail(value)}` : `  ${value}`
      : '';
    this.status.write(`${badge(tone, Boolean(this.status.isTTY))}  ${title}${renderedDetail}\n`);
    this.start(next, undefined, nextMotion);
  }

  private closeActive(): void {
    if (!this.active) return;
    const wroteTail = this.markdown?.flush() ?? false;
    if (wroteTail) (this.active === 'answer' ? this.answer : this.status).write('\n');
    this.active = undefined;
    this.markdown = undefined;
  }

  private muted(text: string, output: Writable): string {
    return output.isTTY ? `${ansi.gray}${text}${ansi.reset}` : text;
  }

  private renderDetail(value: string): string {
    return this.limitDetail(value)
      .split(/\r?\n/)
      .map((line) => `  ${this.muted(`│ ${line}`, this.status)}`)
      .join('\n');
  }

  private limitDetail(value: string): string {
    const limit = 20_000;
    return value.length <= limit ? value : `${value.slice(0, limit)}\n...[详情已截断，共 ${value.length} 字符]`;
  }

  private draw(): void {
    const frame = renderMimiFrame(this.motion, Date.now() - this.motionStartedAt, this.spinnerFrame);
    const elapsed = formatRunDuration(Date.now() - this.startedAt);
    this.status.write(`\r\x1b[2K${ansi.gray}${frame} ${this.label} · ${elapsed}${ansi.reset}`);
  }

  private scheduleSpinner(): void {
    this.spinnerTimer = setTimeout(() => {
      if (!this.label) return;
      this.spinnerFrame = (this.spinnerFrame + 1) % MIMI_TAILS.length;
      this.draw();
      this.scheduleSpinner();
    }, MIMI_TAIL_INTERVAL_MS);
    this.spinnerTimer.unref();
  }

  private stopSpinner(): void {
    if (this.spinnerTimer) clearTimeout(this.spinnerTimer);
    this.spinnerTimer = undefined;
    if (this.status.isTTY && this.label) this.status.write('\r\x1b[2K');
    this.label = '';
  }
}
