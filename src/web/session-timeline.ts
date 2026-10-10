import { conversationOutcome } from '../core/run-finalization.js';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { mediaSchema } from '../core/media-attachment.js';
import { imageMediaType } from '../core/image-attachment.js';
import { assertSessionId } from '../core/session-id.js';
import { sanitizeSensitiveData } from '../core/data-sanitizer.js';

type Item = Record<string, unknown>;
export interface TimelineStep {
  kind: 'status' | 'reasoning';
  tone?: string;
  title?: string;
  fullDetail?: string;
  text?: string;
  timestamp?: string;
  next?: string;
  afterAnswer?: number;
}
export interface SessionExecution {
  id: string;
  userText: string;
  startedAt?: number;
  endedAt?: number;
  status: string;
  steps: TimelineStep[];
  durationKnown: boolean;
  historical: true;
  truncated?: boolean;
}
export interface TimelineItem extends Item {
  timestamp?: string;
  timestampSource?: 'message' | 'run-start' | 'run-end' | 'event';
  timelineRunId?: string;
  execution?: SessionExecution;
  executionAfter?: SessionExecution;
  duration?: number;
}
export interface SessionTimelineOptions {
  dataRoot: string;
  sessionId: string;
  items: readonly unknown[];
  canonicalItems?: readonly unknown[];
  database?: DatabaseSync;
  maxTraceBytes?: number;
}
interface TraceTurn {
  id: string;
  explicitRunId?: string;
  input: string;
  answer?: string;
  startedAt: string;
  endedAt?: string;
  status: string;
  steps: TimelineStep[];
  answerTimes: Record<number,string>;
}
const MAX_SESSION_BYTES = 8 * 1024 * 1024;
const MAX_STEPS = 400;
const MAX_DETAIL = 12_000;
const cache = new Map<string, { key: string; items: Item[] }>();
const object = (value: unknown): Item => value && typeof value === 'object' && !Array.isArray(value) ? value as Item : {};
const text = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((part) => typeof object(part).text === 'string' ? object(part).text : '').join('\n');
  return '';
};
const itemText = (item: Item): string => (Array.isArray(item.mediaAttachments)&&typeof item.displayText==='string'?item.displayText:text(item.content)).trim();
const date = (value: unknown): string | undefined => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined;
const detail = (value: unknown): string => {
  const safe = sanitizeSensitiveData(value);
  const source = typeof safe === 'string' ? safe : JSON.stringify(safe, null, 2) ?? '';
  return source.length > MAX_DETAIL ? `${source.slice(0, MAX_DETAIL)}\n[内容过长，展示已截断]` : source;
};

async function canonicalFile(file: string): Promise<{ items: Item[]; truncated: boolean }> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > MAX_SESSION_BYTES) return { items: [], truncated: true };
    const key = `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}`;
    const cached = cache.get(file);
    if (cached?.key === key) return { items: cached.items, truncated: false };
    const buffer = Buffer.alloc(stats.size);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const parsed = object(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')));
    const items = Array.isArray(parsed.items) ? parsed.items.map(object) : [];
    cache.delete(file);
    cache.set(file, { key, items });
    while (cache.size > 3) cache.delete(cache.keys().next().value!);
    return { items, truncated: false };
  } catch (error) {
    if (['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '') || error instanceof SyntaxError) return { items: [], truncated: false };
    throw error;
  } finally { await handle?.close(); }
}

async function traceTail(file: string, bytes: number): Promise<{ events: Item[]; truncated: boolean }> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stats = await handle.stat();
    if (!stats.isFile()) return { events: [], truncated: false };
    const offset = Math.max(0, stats.size - bytes);
    const buffer = Buffer.alloc(Math.min(stats.size, bytes));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    let source = buffer.subarray(0, bytesRead).toString('utf8');
    if (offset) source = source.includes('\n') ? source.slice(source.indexOf('\n') + 1) : '';
    return {
      events: source.split('\n').flatMap((line) => { try { return [object(JSON.parse(line))]; } catch { return []; } }),
      truncated: offset > 0,
    };
  } catch (error) {
    if (['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) return { events: [], truncated: false };
    throw error;
  } finally { await handle?.close(); }
}

function traceTurns(events: Item[], sessionId: string): TraceTurn[] {
  const turns: TraceTurn[] = [];
  let current: TraceTurn | undefined;
  for (const event of events) {
    if (event.sessionId !== sessionId || !date(event.timestamp)) continue;
    const at = String(event.timestamp), data = object(event.data);
    if (event.type === 'turn_start') {
      current = { id: typeof data.runId === 'string' ? data.runId : `trace:${at}`, ...(typeof data.runId === 'string' ? { explicitRunId: data.runId } : {}), input: String(data.input ?? '').trim(), startedAt: at, status: 'running', steps: [], answerTimes:{} };
      turns.push(current);
    } else if (current && current.id.startsWith('trace:') && event.type === 'model_binding_event' && ['conversation', 'background'].includes(String(data.workUnitKind)) && typeof data.workUnitId === 'string') {
      current.id = data.workUnitId;
    } else if (event.type === 'run_finalization' && ['completed', 'partial', 'blocked', 'interrupted', 'failed', 'uncertain'].includes(String(data.outcome))) {
      // A transport ending successfully does not imply a complete delivery.
      // Legacy work-unit IDs are provisional; persisted finalization owns the run.
      const owner = typeof data.runId === 'string'
        ? [...turns].reverse().find((turn) => turn.explicitRunId === data.runId)
          ?? (current && !current.explicitRunId ? current : undefined)
        : current;
      if (owner) {
        owner.status = conversationOutcome(data as {outcome:string;toolManifest?:{status:string}[]}) ?? String(data.outcome);
        if (typeof data.runId === 'string') { owner.id = data.runId; owner.explicitRunId = data.runId; }
      }
    } else if (current && ['turn_end', 'turn_interrupted', 'error'].includes(String(event.type))) {
      current.endedAt = at;
      if (['unknown', 'running'].includes(current.status)) current.status = event.type === 'turn_end' ? 'completed' : event.type === 'turn_interrupted' ? 'cancelled' : 'failed';
      if (typeof data.answer === 'string') current.answer = data.answer.trim();
      current = undefined;
    } else if (current && event.type === 'answer_started' && data.runId === current.id && Number.isInteger(data.answerIndex)) {
      current.answerTimes[Number(data.answerIndex)] = at;
    } else if (current && event.type === 'reasoning' && typeof data.text === 'string'
      && (!data.runId || data.runId === current.id) && current.steps.length < MAX_STEPS) {
      current.steps.push({ kind: 'reasoning', text: detail(data.text) + (data.truncated ? '\n[思考内容达到保存上限]' : ''), timestamp: date(data.startedAt) ?? at, ...(Number.isInteger(data.afterAnswer) && Number(data.afterAnswer) >= -1 ? {afterAnswer:Number(data.afterAnswer)} : {}) });
    } else if (current && event.type === 'status' && current.steps.length < MAX_STEPS) {
      if(data.transient === true || (data.tone === 'thinking' && !data.detail && !data.next && ['正在准备附件与运行环境','正在准备回答','正在理解图片与视频画面','正在准备上下文','正在等待模型响应'].includes(String(data.title))))continue;
      current.steps.push({ kind: 'status', tone: String(data.tone ?? 'agent'), title: String(data.title ?? ''), fullDetail: detail(data.detail), next: String(data.next ?? ''), timestamp: at, ...(Number.isInteger(data.afterAnswer) && Number(data.afterAnswer) >= -1 ? {afterAnswer:Number(data.afterAnswer)} : {}) });
    }
  }
  return turns;
}

function durableRuns(database: DatabaseSync | undefined, sessionId: string): Item[] {
  if (!database) return [];
  try {
    return database.prepare(`SELECT id, task_id, status, started_at, completed_at,
      substr(answer_json, 1, 65536) AS answer_json FROM runs
      WHERE session_key = ? ORDER BY started_at DESC LIMIT 50`).all(sessionId) as Item[];
  } catch (error) {
    // Older standalone CLI workspaces need no daemon database or run table.
    if (/no such (?:table|column)/i.test(String(error))) return [];
    throw error;
  }
}

function canonicalSteps(items: Item[]): TimelineStep[] {
  const steps: TimelineStep[] = [], calls = new Map<string, TimelineStep>();
  let afterAnswer = -1;
  for (const item of items) {
    if (item.role === 'assistant' && itemText(item)) afterAnswer += 1;
    if (steps.length >= MAX_STEPS) break;
    const at = date(item.timestamp) ?? date(item.createdAt);
    if (item.type === 'reasoning') {
      // Only persisted, explicit text; encrypted/raw provider payloads are not reasoning text.
      const content = text(item.summary) || text(item.content);
      if (content.trim()) steps.push({ kind: 'reasoning', afterAnswer, text: detail(content), ...(at ? { timestamp: at } : {}) });
    } else if (item.type === 'function_call') {
      const step: TimelineStep = { kind: 'status', afterAnswer, tone: 'tool', title: String(item.name ?? '工具调用'), fullDetail: `参数\n${detail(item.arguments)}`, next: '', ...(at ? { timestamp: at } : {}) };
      steps.push(step);
      if (item.callId || item.call_id) calls.set(String(item.callId ?? item.call_id), step);
    } else if (item.type === 'function_call_result' || item.type === 'function_call_output') {
      const step = calls.get(String(item.callId ?? item.call_id));
      if (step) step.fullDetail += `\n\n结果\n${detail(item.output)}`;
      else steps.push({ kind: 'status', afterAnswer, tone: 'tool', title: String(item.name ?? '工具结果'), fullDetail: detail(item.output), next: '', ...(at ? { timestamp: at } : {}) });
    }
  }
  return steps;
}

/** Recover legacy preparation failures from the immutable accepted submission.
 * Only unambiguous same-session text matches are eligible; never guess by proximity. */
function restoreSubmittedMedia(database: DatabaseSync | undefined, sessionId: string, items: Item[]): Item[] {
  if (!database) return items;
  let rows: Item[];
  try {
    rows = database.prepare(`SELECT e.id,e.payload_json,e.created_at FROM tasks t JOIN events e ON e.id=t.authority_event_id
      WHERE t.session_key=? AND t.type='conversation' ORDER BY t.created_at DESC LIMIT 100`).all(sessionId) as Item[];
  } catch(error) { if (/no such (?:table|column)/i.test(String(error))) return items; throw error; }
  const records = rows.flatMap(row=>{try{return [{...row,created_at:row.created_at,payload:object(JSON.parse(String(row.payload_json)))}];}catch{return [];}});
  return items.map(item=>{
    if(item.role!=='user' || item.imageAttachments || item.mediaAttachments)return item;
    const matches=records.filter(row=>String(row.payload.prompt??'').trim()===itemText(item));
    if(matches.length!==1 || items.filter(other=>other.role==='user'&&itemText(other)===itemText(item)).length!==1)return item;
    const record=matches[0]!,payload=record.payload;
    const extensions:Record<string,string>={'image/png':'png','image/jpeg':'jpg','image/gif':'gif','image/webp':'webp'};
    const images=(Array.isArray(payload.attachments)?payload.attachments:[]).flatMap(raw=>{
      const ref=object(raw),extension=extensions[String(ref.mediaType)];
      if(ref.kind!=='image'||!extension||typeof ref.sha256!=='string'||!/^[a-f0-9]{64}$/.test(ref.sha256))return [];
      const id=`${ref.sha256}.${extension}`;
      return [{id,mediaType:imageMediaType(id),bytes:Number(ref.bytes)}];
    });
    const media=(Array.isArray(payload.mediaAttachments)?payload.mediaAttachments:[]).flatMap(ref=>{const parsed=mediaSchema.safeParse(ref);return parsed.success?[parsed.data]:[];});
    return {...item,...(images.length?{imageAttachments:images}:{}),...(media.length?{mediaAttachments:media,displayText:payload.mediaDisplayText??itemText(item)}:{}),
      ...(images.length||media.length?{timestamp:item.timestamp??record.created_at}: {})};
  });
}

/** A read-only display projection. Never modifies canonical history or initializes an Agent. */
export async function decorateSessionTimeline(options: SessionTimelineOptions): Promise<{
  items: TimelineItem[];
  timeline: { truncated: boolean; reasoningAvailable: boolean; runCount: number };
}> {
  assertSessionId(options.sessionId);
  const source = options.canonicalItems
    ? { items: options.canonicalItems.map(object), truncated: false }
    : await canonicalFile(path.join(options.dataRoot, 'sessions', `${options.sessionId}.json`));
  const canonical = source.items.length ? source.items : options.items.map(object);
  const bytes = Math.max(1024, Math.min(2 * 1024 * 1024, options.maxTraceBytes ?? 1024 * 1024));
  const tails = await Promise.all(['.1.jsonl', '.jsonl'].map((suffix) => traceTail(path.join(options.dataRoot, 'traces', options.sessionId + suffix), bytes)));
  const turns = traceTurns(tails.flatMap((tail) => tail.events), options.sessionId);
  const rows = durableRuns(options.database, options.sessionId);
  const projected = restoreSubmittedMedia(options.database, options.sessionId, options.items.map(value=>({...object(value)}))) as TimelineItem[];
  // Match from the tail so identical repeated messages do not all bind to the newest run.
  const indices = new Map<number, number>();
  let cursor = canonical.length - 1;
  for (let i = projected.length - 1; i >= 0; i -= 1) {
    const candidate = projected[i]!;
    if (!['user', 'assistant'].includes(String(candidate.role))) continue;
    for (let j = cursor; j >= 0; j -= 1) {
      if (canonical[j]!.role === candidate.role && itemText(canonical[j]!) === itemText(candidate)) {
        indices.set(j, i); cursor = j - 1; break;
      }
    }
  }
  let boundary = canonical.length, traceCursor = turns.length - 1, runCount = 0, reasoningAvailable = false;
  let stepBudget = MAX_STEPS, byteBudget = 512 * 1024;
  let truncated = source.truncated || tails.some((tail) => tail.truncated);
  for (let start = canonical.length - 1; start >= 0; start -= 1) {
    if (canonical[start]!.role !== 'user') continue;
    if (runCount >= 25) { truncated = true; break; }
    const end = boundary; boundary = start;
    const visible = [...indices.keys()].filter((index) => index >= start && index < end);
    if (!visible.length) continue;
    runCount += 1;
    const userText = itemText(canonical[start]!);
    const assistants: number[] = [];
    for (let j = start + 1; j < end; j += 1) if (canonical[j]!.role === 'assistant' && itemText(canonical[j]!)) assistants.push(j);
    const final = assistants.at(-1);
    let turn: TraceTurn | undefined;
    for (let j = traceCursor; j >= 0; j -= 1) {
      const candidate = turns[j]!;
      if (candidate.input !== userText) continue;
      // Host completion gates can wrap the model's canonical final answer. A
      // unique input in both sources still identifies this run unambiguously.
      const uniqueInput = turns.filter((value) => value.input === userText).length === 1
        && canonical.filter((value) => value.role === 'user' && itemText(value) === userText).length === 1;
      if (candidate.answer && final !== undefined && candidate.answer !== itemText(canonical[final]!) && !uniqueInput) continue;
      turn = candidate; traceCursor = j - 1; break;
    }
    let steps = canonicalSteps(canonical.slice(start + 1, end));
    reasoningAvailable ||= steps.some((step) => step.kind === 'reasoning');
    if (turn) {
      // Trace gives real time for matching tool starts; canonical supplies full tool results.
      let next = 0;
      for (const step of steps) {
        if (step.kind !== 'status') continue;
        const match = turn.steps.findIndex((event, index) => index >= next && event.tone === 'tool' && event.title === step.title);
        if (match >= 0) { step.timestamp ??= turn.steps[match]!.timestamp; next = match + 1; }
      }
      if (!steps.some((step) => step.kind === 'reasoning') && turn.steps.some((step) => step.kind === 'reasoning')) {
        let toolIndex = 0;
        let afterAnswer = -1;
        steps = turn.steps.map((step, traceIndex) => {
          const followingTool = turn!.steps.slice(traceIndex).find((entry) => entry.tone === 'tool' && steps.slice(toolIndex).some((candidate) => candidate.title === entry.title));
          const anchor = followingTool && steps.slice(toolIndex).find((candidate) => candidate.title === followingTool.title);
          if (anchor) afterAnswer = anchor.afterAnswer ?? afterAnswer;
          // Prefer actual message timestamps where available. Never invent boundaries from prose.
          if (step.timestamp) {
            const precedingIndex = [...assistants].reverse().find((index) => {
              const at = date(canonical[index]!.timestamp) ?? date(canonical[index]!.createdAt);
              return at && Date.parse(at) <= Date.parse(step.timestamp!);
            });
            if (precedingIndex !== undefined) afterAnswer = assistants.indexOf(precedingIndex);
          }
          step = {...step, afterAnswer:step.afterAnswer ?? afterAnswer};
          if (step.kind !== 'status' || step.tone !== 'tool') return step;
          const match = steps.findIndex((candidate, index) => index >= toolIndex && candidate.title === step.title && candidate.tone === 'tool');
          if (match < 0) return step;
          toolIndex = match + 1;
          return { ...steps[match]!, timestamp: step.timestamp };
        });
      } else if (!steps.length) steps = turn.steps;
      reasoningAvailable ||= steps.some((step) => step.kind === 'reasoning');
    }
    const run = turn ? rows.find(row=>{try{return object(object(JSON.parse(String(row.answer_json))).finalization).runId===turn!.id;}catch{return false;}}) ?? rows.find((row) => {
      const first = date(row.started_at), last = date(row.completed_at);
      return first && Date.parse(first) <= Date.parse(turn.startedAt) && (!last || Date.parse(last) >= Date.parse(turn.startedAt));
    }) : (() => {
      if (final === undefined) return undefined;
      const finalText = itemText(canonical[final]!);
      if (canonical.filter((item) => item.role === 'assistant' && itemText(item) === finalText).length !== 1) return undefined;
      const matches = rows.filter((row) => {
        try { const answer: unknown = JSON.parse(String(row.answer_json)); return (typeof answer === 'string' ? answer : object(answer).answer) === itemText(canonical[final]!); } catch { return false; }
      });
      return matches.length === 1 ? matches[0] : undefined;
    })();
    const availableSteps: TimelineStep[] = [];
    for (const step of steps) {
      const size = Buffer.byteLength(JSON.stringify(step));
      if (stepBudget <= 0 || size > byteBudget) break;
      availableSteps.push(step); stepBudget -= 1; byteBudget -= size;
    }
    const stepsTruncated = availableSteps.length < steps.length;
    truncated ||= stepsTruncated;
    steps = availableSteps;
    const startedAt = date(run?.started_at) ?? turn?.startedAt;
    const endedAt = turn?.endedAt ?? date(run?.completed_at);
    const id = typeof run?.id === 'string' ? run.id : turn?.id ?? `history:${start}`;
    const execution: SessionExecution = { id, userText: detail(userText), status: turn?.status ?? String(run?.status ?? 'unknown'), steps, durationKnown: !!startedAt && !!endedAt, historical: true, ...(stepsTruncated ? { truncated: true } : {}),
      ...(startedAt ? { startedAt: Date.parse(startedAt) } : {}), ...(endedAt ? { endedAt: Date.parse(endedAt) } : {}) };
    for (const index of visible) {
      const item = projected[indices.get(index)!]!;
      const ownTime = turn?.answerTimes[assistants.indexOf(index)] ?? date(canonical[index]!.timestamp) ?? date(canonical[index]!.createdAt);
      item.timelineRunId = id;
      if (ownTime) { item.timestamp = ownTime; item.timestampSource = 'message'; }
      else if (index === start && startedAt) { item.timestamp = startedAt; item.timestampSource = 'run-start'; }
      else if (index === final && endedAt) { item.timestamp = endedAt; item.timestampSource = 'run-end'; }
      if (index === final && startedAt && endedAt && Date.parse(endedAt) >= Date.parse(startedAt)) item.duration = Date.parse(endedAt) - Date.parse(startedAt);
    }
    const groups = new Map<number, TimelineStep[]>();
    for (const step of steps) {
      const after = step.afterAnswer ?? -1;
      if (!groups.has(after)) groups.set(after, []);
      groups.get(after)!.push(step);
    }
    for (const [after, group] of groups) {
      const next = assistants[after + 1];
      const previous = after >= 0 ? assistants[after] : undefined;
      const anchor = next !== undefined && indices.has(next) ? next
        : next !== undefined ? assistants.find((index) => index > next && indices.has(index))
        : previous !== undefined && indices.has(previous) ? previous : (indices.has(start) ? start : undefined);
      if (anchor === undefined) continue;
      const item = projected[indices.get(anchor)!]!;
      const field = next === undefined && previous === anchor ? 'executionAfter' : 'execution';
      if (item[field]) item[field]!.steps.push(...group);
      else item[field] = {...execution, status:after===Math.max(...groups.keys())?execution.status:'', steps:[...group]};
    }
  }
  return { items: projected, timeline: { truncated, reasoningAvailable, runCount } };
}
