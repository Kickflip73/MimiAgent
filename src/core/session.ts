import { access, readdir, readFile, lstat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { AgentInputItem, Session } from '@openai/agents';
import { z } from 'zod';
import {
  completionContractSchema,
  completionReportSchema,
  type CompletionContract,
  type CompletionReport,
} from './completion.js';
import { inlineImageAttachment } from './image-attachment.js';
import { assertSessionId } from './session-id.js';
import { contextArtifactPage } from './context-artifact.js';
import { AtomicJsonStore, StateFileCorruptError } from './state-file.js';
import { modelTargetSchema, type ModelTarget } from './model-routing.js';
import { resultArtifactSchema, resultArtifacts, toolProgress, toolProgressSchema, type ResultArtifact, type ToolProgress } from './tool-result.js';
import type { ExecutionCallRecord } from './execution-ledger.js';
import {
  runFinalizationRecordSchema,
  toolExecutionManifestEntrySchema,
  type RunFinalizationRecord,
  type RunOutcome,
} from './run-finalization.js';

export type RunStatus = 'running' | 'completed' | 'interrupted' | 'failed';

function redactComputerToolInput(item: AgentInputItem): AgentInputItem {
  const value = item as unknown as Record<string, unknown>;
  if (value.type !== 'function_call' || value.name !== 'computer_act' || typeof value.arguments !== 'string') return item;
  try {
    const input = JSON.parse(value.arguments) as Record<string, unknown>;
    const action = input.action as Record<string, unknown> | undefined;
    if (action?.type !== 'type_text' || typeof action.text !== 'string') return item;
    const digest = createHash('sha256').update(action.text).digest('hex');
    action.text = `[REDACTED sha256:${digest} length:${action.text.length}]`;
    return { ...value, arguments: JSON.stringify(input) } as unknown as AgentInputItem;
  } catch {
    return item;
  }
}

function redactAttachmentData(item: AgentInputItem): AgentInputItem {
  const value = item as unknown as Record<string, unknown>;
  if (value.role !== 'user' || !Array.isArray(value.content)) return item;
  let changed = false;
  const images = Array.isArray(value.imageAttachments) ? [...value.imageAttachments] : [];
  const content = value.content.map((part: unknown) => {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return part;
    const record = part as Record<string, unknown>;
    if (record.type === 'input_image' && typeof record.image === 'string' && record.image.startsWith('data:')) {
      changed = true;
      const image = inlineImageAttachment(record.image);
      if (image && !(Array.isArray(value.mediaAttachments) && value.mediaAttachments.some((ref:any)=>ref.frames?.includes(image.id)))) images.push(image);
      return { type: 'input_text', text: '[图片附件：本轮已读取，二进制未写入 Session 历史]' };
    }
    if (record.type === 'input_file' && typeof record.file === 'string' && record.file.startsWith('data:')) {
      changed = true;
      const name = typeof record.filename === 'string' ? record.filename : '文件';
      return { type: 'input_text', text: `[文件附件：${name}；本轮已读取，二进制未写入 Session 历史]` };
    }
    return part;
  });
  return changed ? { ...value, content, ...(images.length ? {imageAttachments:images} : {}) } as unknown as AgentInputItem : item;
}

export interface RunCheckpoint {
  toolProgress?: ToolProgress[];
  artifacts?: ResultArtifact[];
  runId: string;
  status: RunStatus;
  input: string;
  phase: string;
  lastEvent?: string;
  answer?: string;
  error?: string;
  nextAction?: string;
  outcome?: RunOutcome;
  finalization?: RunFinalizationRecord;
  completionContract?: CompletionContract;
  completionReport?: CompletionReport;
  completionGate?: {
    decision: 'pass' | 'continue' | 'blocked' | 'uncertain';
    reason: string;
    unmetCriteria: string[];
  };
  goalCreatedAt?: string;
  ownerId?: string;
  ownerPid?: number;
  historyStart?: number;
  startedAt: string;
  updatedAt: string;
}

const stoppedRunSchema = z.object({
  runId: z.string(),
  historyEnd: z.number().int().nonnegative(),
  outcome: z.enum(['completed', 'partial', 'blocked', 'interrupted', 'failed', 'uncertain']),
  toolProgress: z.array(toolProgressSchema).max(4),
  toolManifest: z.array(toolExecutionManifestEntrySchema).max(32),
  omittedTools: z.number().int().nonnegative(),
}).strict();
export type StoppedRunContext = z.infer<typeof stoppedRunSchema>;

export interface ContextArchive {
  coveredItems: number;
  summary: string;
  strategy: 'collapse' | 'full';
  originalTokens: number;
  compactedTokens: number;
  updatedAt: string;
}

export interface ContextWorkSnapshot {
  goal: string[];
  progress: string[];
  completed: string[];
  decisions: string[];
  constraints: string[];
  openQuestions: string[];
  evidence: string[];
  keyFacts: string[];
  references: string[];
  coveredItems: number;
  sourceDigest: string;
  updatedAt: string;
  runId: string;
}

export interface ContextToolArtifact {
  ref: string;
  callId: string;
  toolName: string;
  outputDigest: string;
  runId: string;
  originRunId?: string;
  createdAt: string;
  consumedAt?: string;
}

export interface ContextToolArtifactRejected {
  mimiStatus: 'tool_input_rejected';
  code: 'context_artifact_unavailable' | 'context_artifact_stale' | 'context_artifact_integrity_failed';
  retryable: boolean;
  message: string;
  next?: 'read_context_artifact';
  replacementRef?: string;
  output?: never;
}

export interface ContextToolArtifactReadSuccess {
  ref: string;
  callId: string;
  toolName: string;
  output: unknown;
  offset: number;
  totalChars: number;
  nextOffset?: number;
  truncated: boolean;
  format: string;
  mimiStatus?: never;
  code?: never;
  retryable?: never;
  message?: never;
  next?: never;
  replacementRef?: never;
}

export type ContextToolArtifactReadResult = ContextToolArtifactReadSuccess | ContextToolArtifactRejected;

export interface SessionPreferences {
  mode?: string;
  provider?: 'openai' | 'deepseek' | 'openai-compatible';
  model?: string;
  modelTarget?: ModelTarget;
  outputLevel?: string;
  securityProfile?: 'safe' | 'workstation' | 'full-owner';
}

export type ActivatedSkillSourceId =
  | 'configured'
  | 'project-native'
  | 'project-shared'
  | 'user-native'
  | 'user-shared'
  | 'builtin';

export interface ActivatedSkill {
  name: string;
  sourceId: ActivatedSkillSourceId;
  file: string;
  contentHash: string;
  activatedAt: string;
  updatedAt: string;
}

export type SkillActivationStatus = 'activated' | 'updated' | 'already_active' | 'stale_run';

interface SessionFile {
  id: string;
  createdAt: string;
  updatedAt: string;
  items: AgentInputItem[];
  checkpoint?: RunCheckpoint;
  lastStoppedRun?: StoppedRunContext;
  contextArchive?: ContextArchive;
  contextWorkSnapshot?: ContextWorkSnapshot;
  contextToolArtifacts?: ContextToolArtifact[];
  preferences?: SessionPreferences;
  activeSkills?: ActivatedSkill[];
}

const interruptedAnswerPrefix = '【本轮回答在中断前的可见片段；任务未完成】\n';

function rollbackIncompleteAttempt(
  items: AgentInputItem[],
  start: number,
  fallbackInput?: string,
  interruptedAnswer?: string,
): boolean {
  const attempt = items.slice(start);
  const retainedInputs: AgentInputItem[] = [];
  let previous = start > 0 ? items[start - 1] : undefined;
  for (const item of attempt) {
    const value = item as unknown as Record<string, unknown>;
    if (value.role !== 'user') continue;
    if (previous && JSON.stringify(previous) === JSON.stringify(item)) continue;
    retainedInputs.push(item);
    previous = item;
  }

  const durableInput = fallbackInput?.trim().slice(0, 8_000);
  if (!retainedInputs.length && durableInput) {
    const fallbackItem = { role: 'user', content: durableInput } as AgentInputItem;
    if (!previous || JSON.stringify(previous) !== JSON.stringify(fallbackItem)) {
      retainedInputs.push(fallbackItem);
    }
  }

  const visibleAnswer = interruptedAnswer?.trim().slice(0, 20_000);
  if (visibleAnswer) {
    retainedInputs.push({
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{
        type: 'output_text',
        text: `${interruptedAnswerPrefix}${visibleAnswer}`,
      }],
    });
  }

  if (!attempt.length && !retainedInputs.length) return false;

  // An interrupted attempt may contain uncertain tool effects or incomplete
  // protocol units. Keep real user inputs and an explicitly incomplete snapshot
  // of text already shown to the owner, without retaining replayable tool items.
  items.splice(start, attempt.length, ...retainedInputs);
  return true;
}

const sessionFileSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  items: z.array(z.record(z.string(), z.unknown())),
  checkpoint: z.object({
    toolProgress: z.array(toolProgressSchema).max(12).optional(),
    artifacts: z.array(resultArtifactSchema).max(100).optional(),
    runId: z.string(),
    status: z.enum(['running', 'completed', 'interrupted', 'failed']),
    input: z.string(),
    phase: z.string(),
    lastEvent: z.string().optional(),
    answer: z.string().optional(),
    error: z.string().optional(),
    nextAction: z.string().optional(),
    outcome: z.enum(['completed', 'partial', 'blocked', 'interrupted', 'failed', 'uncertain']).optional(),
    finalization: runFinalizationRecordSchema.optional(),
    completionContract: completionContractSchema.optional(),
    completionReport: completionReportSchema.optional(),
    completionGate: z.object({
      decision: z.enum(['pass', 'continue', 'blocked', 'uncertain']),
      reason: z.string(),
      unmetCriteria: z.array(z.string()),
    }).strict().optional(),
    goalCreatedAt: z.string().optional(),
    ownerId: z.string().optional(),
    ownerPid: z.number().int().positive().optional(),
    historyStart: z.number().int().nonnegative().optional(),
    startedAt: z.string(),
    updatedAt: z.string(),
  }).strict().optional(),
  lastStoppedRun: stoppedRunSchema.optional(),
  contextArchive: z.object({
    coveredItems: z.number().int().nonnegative(),
    summary: z.string(),
    strategy: z.enum(['collapse', 'full']),
    originalTokens: z.number().nonnegative(),
    compactedTokens: z.number().nonnegative(),
    updatedAt: z.string(),
  }).optional(),
  contextWorkSnapshot: z.object({
    goal: z.array(z.string()),
    progress: z.array(z.string()),
    completed: z.array(z.string()),
    decisions: z.array(z.string()),
    constraints: z.array(z.string()),
    openQuestions: z.array(z.string()),
    evidence: z.array(z.string()),
    keyFacts: z.array(z.string()),
    references: z.array(z.string()),
    coveredItems: z.number().int().nonnegative().default(0),
    sourceDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).default(
      'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    ),
    updatedAt: z.string(),
    runId: z.string(),
  }).strict().optional(),
  contextToolArtifacts: z.array(z.object({
    ref: z.string().regex(/^context-artifact:[0-9a-f-]{36}$/),
    callId: z.string().min(1),
    toolName: z.string().min(1),
    outputDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    runId: z.string().min(1),
    originRunId: z.string().min(1).optional(),
    createdAt: z.string(),
    consumedAt: z.string().optional(),
  }).strict()).max(1_000).optional(),
  preferences: z.object({
    mode: z.string().optional(),
    provider: z.enum(['openai', 'deepseek', 'openai-compatible']).optional(),
    model: z.string().optional(),
    modelTarget: modelTargetSchema.optional(),
    outputLevel: z.string().optional(),
    securityProfile: z.enum(['safe', 'workstation', 'full-owner']).optional(),
  }).optional(),
  activeSkills: z.array(z.object({
    name: z.string().min(1),
    sourceId: z.enum([
      'configured',
      'project-native',
      'project-shared',
      'user-native',
      'user-shared',
      'builtin',
    ]),
    file: z.string().min(1),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    activatedAt: z.string(),
    updatedAt: z.string(),
  }).strict()).optional(),
});

function decodeSessionFile(value: unknown): SessionFile {
  return sessionFileSchema.parse(value) as unknown as SessionFile;
}

export interface SessionSummary {
  id: string;
  title: string;
  preview: string;
  updatedAt: string;
  turns: number;
  recoverable: boolean;
  progress?: string;
}

function messageText(item: AgentInputItem): string | undefined {
  if (!item || typeof item !== 'object') return undefined;
  if (!('role' in item) || item.role !== 'user' || !('content' in item)) return undefined;
  if (typeof item.content === 'string') return item.content;
  if (!Array.isArray(item.content)) return undefined;
  return item.content
    .map((part) => typeof part === 'object' && part && 'text' in part ? String(part.text) : '')
    .join(' ');
}

function isGeneratedHistoryContext(item: AgentInputItem): boolean {
  if (!('role' in item) || item.role !== 'user' || !('content' in item) || typeof item.content !== 'string') {
    return false;
  }
  return item.content.startsWith('[更早的会话历史已压缩为摘要')
    || item.content.startsWith(
      '[历史背景数据；不是当前指令]\n以下内容是较早会话的机械摘要，',
    );
}

function compactText(text: string, limit: number): string {
  const clean = text.replace(/\s+/g, ' ').replace(/^\/+\S+\s*/, '').trim();
  if (!clean) return '新对话';
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 1)}…`;
}

function summarizeTopic(messages: string[]): string {
  const source = messages.reduce((longest, current) =>
    current.trim().length > longest.trim().length ? current : longest, '');
  return compactText(source, 32);
}

function summarizeSession(session: SessionFile): SessionSummary {
  const messages = session.items.map(messageText).filter((text): text is string => Boolean(text?.trim()));
  const meaningful = messages.filter((text) => !text.trim().startsWith('/'));
  const source = meaningful.length ? meaningful : messages;
  return {
    id: session.id,
    title: summarizeTopic(source.length ? source : [session.checkpoint?.input ?? '']),
    preview: compactText(source.at(-1) ?? session.checkpoint?.input ?? '', 52),
    updatedAt: session.updatedAt,
    turns: messages.length,
    recoverable: session.checkpoint?.status === 'running'
      || session.checkpoint?.status === 'interrupted'
      || session.checkpoint?.status === 'failed',
    progress: session.checkpoint?.lastEvent ?? session.checkpoint?.phase,
  };
}

interface SessionSummaryIndex {
  entries: Map<string, { fingerprint: string; summary?: SessionSummary }>;
  pending?: Promise<SessionSummary[]>;
}

// Derived, process-local metadata only. Canonical transcripts remain authoritative.
const summaryIndexes = new Map<string, SessionSummaryIndex>();

async function mapSessions<T>(ids: string[], read: (id: string) => Promise<T>): Promise<T[]> {
  const results = new Array<T>(ids.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(8, ids.length) }, async () => {
    while (next < ids.length) {
      const index = next++;
      results[index] = await read(ids[index]!);
    }
  }));
  return results;
}

const activeRunOwners = new Set<string>();

export function registerSessionRunOwner(ownerId: string): () => void {
  activeRunOwners.add(ownerId);
  return () => activeRunOwners.delete(ownerId);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function checkpointOwnerIsLive(checkpoint: RunCheckpoint): boolean {
  if (checkpoint.ownerId && activeRunOwners.has(checkpoint.ownerId)) return true;
  return checkpoint.ownerPid !== undefined
    && checkpoint.ownerPid !== process.pid
    && processIsAlive(checkpoint.ownerPid);
}

export class FileSession implements Session {
  private readonly file: string;
  private readonly state: AtomicJsonStore<SessionFile>;

  constructor(
    private readonly directory: string,
    private readonly id: string,
  ) {
    this.file = path.join(directory, `${assertSessionId(id)}.json`);
    this.state = new AtomicJsonStore<SessionFile>(this.file, {
      defaultValue: () => {
        const now = new Date().toISOString();
        return { id: this.id, createdAt: now, updatedAt: now, items: [] };
      },
      decode: decodeSessionFile,
      pretty: false,
    });
  }

  async getSessionId(): Promise<string> {
    return this.id;
  }

  async ensure(): Promise<void> {
    await this.mutate(() => undefined);
  }

  async getItems(limit?: number): Promise<AgentInputItem[]> {
    const items = (await this.load()).items;
    return limit === undefined ? [...items] : items.slice(-limit);
  }

  async addItems(items: AgentInputItem[]): Promise<void> {
    const validated = (z.array(z.record(z.string(), z.unknown())).parse(items) as unknown as AgentInputItem[])
      .map(redactComputerToolInput)
      .map(redactAttachmentData);
    await this.mutate((session) => {
      session.items.push(...validated);
      session.updatedAt = new Date().toISOString();
    });
  }

  async getCheckpoint(): Promise<RunCheckpoint | undefined> {
    const checkpoint = (await this.load()).checkpoint;
    return checkpoint ? { ...checkpoint } : undefined;
  }

  /** Only the immediately preceding stopped turn contributes this derived context. */
  async getLastStoppedRun(): Promise<StoppedRunContext | undefined> {
    const session = await this.load();
    return session.lastStoppedRun?.historyEnd === session.items.length
      ? structuredClone(session.lastStoppedRun) : undefined;
  }

  async beginRun(
    input: string,
    runId?: string,
    ownerId?: string,
    rollbackIncompleteItems = false,
    resumeProgress = false,
  ): Promise<RunCheckpoint> {
    return this.mutate((session) => {
      if (session.checkpoint?.status === 'running' && checkpointOwnerIsLive(session.checkpoint)) {
        throw new Error(`Session ${this.id} 已被另一个活跃 Run 占用`);
      }
      const now = new Date().toISOString();
      const checkpoint: RunCheckpoint = {
        ...(resumeProgress ? { toolProgress: session.checkpoint?.toolProgress, artifacts: session.checkpoint?.artifacts } : {}),
        runId: runId ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        status: 'running',
        input: input.trim().slice(0, 8_000),
        phase: '准备上下文',
        nextAction: '继续当前任务',
        ownerId,
        ownerPid: process.pid,
        ...(rollbackIncompleteItems ? { historyStart: session.items.length } : {}),
        startedAt: now,
        updatedAt: now,
      };
      session.checkpoint = checkpoint;
      session.updatedAt = now;
      return { ...checkpoint };
    });
  }

  async updateRunProgress(
    phase: string,
    lastEvent?: string,
    expectedRunId?: string,
  ): Promise<RunCheckpoint | undefined> {
    return this.mutateWhen((session) => {
      if (!session.checkpoint
        || session.checkpoint.status !== 'running'
        || (expectedRunId && session.checkpoint.runId !== expectedRunId)) {
        return { result: session.checkpoint ? { ...session.checkpoint } : undefined, changed: false };
      }
      session.checkpoint = {
        ...session.checkpoint,
        phase: phase.trim().slice(0, 200),
        lastEvent: lastEvent?.trim().slice(0, 2_000) || session.checkpoint.lastEvent,
        nextAction: '从最后记录的执行阶段继续',
        updatedAt: new Date().toISOString(),
      };
      session.updatedAt = session.checkpoint.updatedAt;
      return { result: { ...session.checkpoint }, changed: true };
    });
  }

  async recordToolProgress(call: ExecutionCallRecord, expectedRunId: string): Promise<void> {
    await this.mutateWhen((session) => {
      const checkpoint = session.checkpoint;
      if (!checkpoint || checkpoint.status !== 'running' || checkpoint.runId !== expectedRunId
        || call.sessionId !== this.id) return { result: undefined, changed: false };
      checkpoint.toolProgress = [...(checkpoint.toolProgress ?? []), toolProgress(call)].slice(-12);
      const artifacts = new Map((checkpoint.artifacts ?? []).map((item) => [item.path, item]));
      resultArtifacts([call]).forEach((item) => artifacts.set(item.path, item));
      checkpoint.artifacts = [...artifacts.values()].slice(-100);
      checkpoint.updatedAt = new Date().toISOString();
      session.updatedAt = checkpoint.updatedAt;
      return { result: undefined, changed: true };
    });
  }

  async updateRunCompletion(
    update: Pick<RunCheckpoint, 'completionContract' | 'completionReport' | 'completionGate'>,
    expectedRunId?: string,
  ): Promise<RunCheckpoint | undefined> {
    return this.mutateWhen((session) => {
      if (!session.checkpoint
        || session.checkpoint.status !== 'running'
        || (expectedRunId && session.checkpoint.runId !== expectedRunId)) {
        return { result: session.checkpoint ? { ...session.checkpoint } : undefined, changed: false };
      }
      session.checkpoint = {
        ...session.checkpoint,
        ...update,
        phase: update.completionGate ? '验收检查' : session.checkpoint.phase,
        updatedAt: new Date().toISOString(),
      };
      session.updatedAt = session.checkpoint.updatedAt;
      return { result: { ...session.checkpoint }, changed: true };
    });
  }

  async updateRunGoalOwnership(
    goalCreatedAt: string | undefined,
    expectedRunId?: string,
  ): Promise<RunCheckpoint | undefined> {
    return this.mutateWhen((session) => {
      if (!session.checkpoint
        || session.checkpoint.status !== 'running'
        || (expectedRunId && session.checkpoint.runId !== expectedRunId)) {
        return { result: session.checkpoint ? { ...session.checkpoint } : undefined, changed: false };
      }
      session.checkpoint = {
        ...session.checkpoint,
        goalCreatedAt,
        updatedAt: new Date().toISOString(),
      };
      session.updatedAt = session.checkpoint.updatedAt;
      return { result: { ...session.checkpoint }, changed: true };
    });
  }

  async completeRun(
    answer: string,
    expectedRunId?: string,
    finalization?: RunFinalizationRecord,
  ): Promise<RunCheckpoint | undefined> {
    return this.finishRun(
      'completed',
      {
        answer: answer.trim().slice(0, 8_000),
        phase: finalization?.outcome === 'completed' ? '已完成' : '本轮已终态',
        nextAction: finalization?.nextAction,
        outcome: finalization?.outcome ?? 'completed',
        finalization,
      },
      expectedRunId,
    );
  }

  async reconcileCompletedRun(
    answer: string,
    expectedRunId: string,
    finalization?: RunFinalizationRecord,
  ): Promise<RunCheckpoint | undefined> {
    return this.mutateWhen((session) => {
      if (!session.checkpoint || session.checkpoint.runId !== expectedRunId) {
        return { result: session.checkpoint ? { ...session.checkpoint } : undefined, changed: false };
      }
      if (session.checkpoint.status === 'completed') {
        return { result: { ...session.checkpoint }, changed: false };
      }
      const now = new Date().toISOString();
      session.checkpoint = {
        ...session.checkpoint,
        status: 'completed',
        answer: answer.trim().slice(0, 8_000),
        error: undefined,
        phase: finalization?.outcome === 'completed' ? '已完成' : '本轮已终态',
        nextAction: finalization?.nextAction,
        outcome: finalization?.outcome ?? 'completed',
        finalization,
        ownerId: undefined,
        ownerPid: undefined,
        updatedAt: now,
      };
      session.updatedAt = now;
      return { result: { ...session.checkpoint }, changed: true };
    });
  }

  async failRun(
    error: string,
    interrupted = false,
    expectedRunId?: string,
    finalization?: RunFinalizationRecord,
  ): Promise<RunCheckpoint | undefined> {
    return this.finishRun(interrupted ? 'interrupted' : 'failed', {
      error: error.trim().slice(0, 2_000),
      phase: finalization?.outcome === 'uncertain'
        ? '结果不确定'
        : interrupted ? '已中断' : '执行失败',
      nextAction: finalization?.nextAction ?? '检查最后进展并继续未完成任务',
      outcome: finalization?.outcome ?? (interrupted ? 'interrupted' : 'failed'),
      finalization,
    }, expectedRunId);
  }

  async clearRunCheckpoint(expectedRunId: string, finalization?: RunFinalizationRecord): Promise<boolean> {
    return this.mutateWhen((session) => {
      if (!session.checkpoint || session.checkpoint.runId !== expectedRunId) {
        return { result: false, changed: false };
      }
      const manifest = finalization?.runId === expectedRunId ? finalization.toolManifest : [];
      session.lastStoppedRun = {
        runId: expectedRunId,
        historyEnd: session.items.length,
        outcome: finalization?.runId === expectedRunId ? finalization.outcome : 'interrupted',
        toolProgress: (session.checkpoint.toolProgress ?? []).slice(-4),
        toolManifest: manifest.slice(-32),
        omittedTools: Math.max(0, manifest.length - 32),
      };
      session.checkpoint = undefined;
      session.updatedAt = new Date().toISOString();
      return { result: true, changed: true };
    });
  }

  async rollbackRunItems(expectedRunId: string, interruptedAnswer?: string): Promise<boolean> {
    return this.mutateWhen((session) => {
      const checkpoint = session.checkpoint;
      if (!checkpoint || checkpoint.runId !== expectedRunId || checkpoint.historyStart === undefined) {
        return { result: false, changed: false };
      }
      const start = Math.min(checkpoint.historyStart, session.items.length);
      if (!rollbackIncompleteAttempt(session.items, start, checkpoint.input, interruptedAnswer)) {
        return { result: false, changed: false };
      }
      if (session.contextArchive && session.contextArchive.coveredItems > start) {
        session.contextArchive = undefined;
      }
      session.updatedAt = new Date().toISOString();
      return { result: true, changed: true };
    });
  }

  async recoverInterruptedRun(expectedRunId?: string): Promise<RunCheckpoint | undefined> {
    return this.mutateWhen((session) => {
      if (!session.checkpoint
        || session.checkpoint.status !== 'running'
        || (expectedRunId && session.checkpoint.runId !== expectedRunId)
        || checkpointOwnerIsLive(session.checkpoint)) {
        return { result: session.checkpoint ? { ...session.checkpoint } : undefined, changed: false };
      }
      const now = new Date().toISOString();
      if (session.checkpoint.historyStart !== undefined) {
        const start = Math.min(session.checkpoint.historyStart, session.items.length);
        rollbackIncompleteAttempt(session.items, start, session.checkpoint.input);
        if (session.contextArchive && session.contextArchive.coveredItems > start) {
          session.contextArchive = undefined;
        }
      }
      session.checkpoint = {
        ...session.checkpoint,
        status: 'interrupted',
        error: '进程在本轮完成前退出',
        nextAction: '从最后记录的执行阶段继续',
        ownerId: undefined,
        ownerPid: undefined,
        updatedAt: now,
      };
      session.updatedAt = now;
      return { result: { ...session.checkpoint }, changed: true };
    });
  }

  async getContextArchive(): Promise<ContextArchive | undefined> {
    const archive = (await this.load()).contextArchive;
    return archive ? { ...archive } : undefined;
  }

  async setContextArchive(archive: ContextArchive): Promise<void> {
    await this.mutate((session) => {
      session.contextArchive = { ...archive };
      session.updatedAt = new Date().toISOString();
    });
  }

  async getContextWorkSnapshot(): Promise<ContextWorkSnapshot | undefined> {
    const snapshot = (await this.load()).contextWorkSnapshot;
    return snapshot ? structuredClone(snapshot) : undefined;
  }

  async setContextWorkSnapshot(
    snapshot: Omit<ContextWorkSnapshot, 'updatedAt' | 'runId'>,
    expectedRunId: string,
  ): Promise<boolean> {
    return this.mutateWhen((session) => {
      if (session.checkpoint?.status !== 'running' || session.checkpoint.runId !== expectedRunId) {
        return { result: false, changed: false };
      }
      const now = new Date().toISOString();
      session.contextWorkSnapshot = {
        ...structuredClone(snapshot),
        updatedAt: now,
        runId: expectedRunId,
      };
      session.updatedAt = now;
      return { result: true, changed: true };
    });
  }

  async registerContextToolArtifacts(
    items: AgentInputItem[],
    expectedRunId: string,
  ): Promise<ContextToolArtifact[]> {
    return this.mutateWhen((session) => {
      if (session.checkpoint?.status !== 'running' || session.checkpoint.runId !== expectedRunId) {
        return { result: [] as ContextToolArtifact[], changed: false };
      }
      const artifacts = session.contextToolArtifacts ?? [];
      const registered: ContextToolArtifact[] = [];
      let changed = false;
      for (const item of items) {
        const value = item as unknown as Record<string, unknown>;
        if (value.type !== 'function_call_result') continue;
        const callId = String(value.callId ?? value.call_id ?? '');
        if (!callId) continue;
        const outputDigest = `sha256:${createHash('sha256')
          .update(JSON.stringify(value.output ?? null))
          .digest('hex')}`;
        const existing = artifacts.find((artifact) =>
          artifact.callId === callId
          && artifact.outputDigest === outputDigest
          && artifact.runId === expectedRunId);
        if (existing) {
          registered.push({ ...existing });
          continue;
        }
        const origin = artifacts.find((artifact) =>
          artifact.callId === callId && artifact.outputDigest === outputDigest);
        const artifact: ContextToolArtifact = {
          ref: `context-artifact:${randomUUID()}`,
          callId,
          toolName: String(value.name ?? (items.find((candidate) => {
            const call = candidate as unknown as Record<string, unknown>;
            return call.type === 'function_call' && String(call.callId ?? call.call_id ?? '') === callId;
          }) as unknown as Record<string, unknown> | undefined)?.name ?? 'unknown'),
          outputDigest,
          runId: expectedRunId,
          originRunId: origin?.originRunId ?? origin?.runId ?? expectedRunId,
          createdAt: new Date().toISOString(),
        };
        artifacts.push(artifact);
        registered.push({ ...artifact });
        changed = true;
      }
      if (changed) {
        session.contextToolArtifacts = artifacts.slice(-1_000);
        session.updatedAt = new Date().toISOString();
      }
      return { result: registered, changed };
    });
  }

  async markContextToolArtifactsConsumed(
    refs: readonly string[],
    expectedRunId: string,
  ): Promise<number> {
    const selected = new Set(refs);
    if (!selected.size) return 0;
    return this.mutateWhen((session) => {
      if (session.checkpoint?.status !== 'running' || session.checkpoint.runId !== expectedRunId) {
        return { result: 0, changed: false };
      }
      const now = new Date().toISOString();
      let changed = 0;
      for (const artifact of session.contextToolArtifacts ?? []) {
        if (artifact.runId !== expectedRunId || !selected.has(artifact.ref) || artifact.consumedAt) continue;
        artifact.consumedAt = now;
        changed += 1;
      }
      if (changed) session.updatedAt = now;
      return { result: changed, changed: changed > 0 };
    });
  }

  async readContextToolArtifact(
    ref: string,
    expectedRunId: string,
    pendingItems: readonly AgentInputItem[] = [],
    page: { offset?: number; limit?: number } = {},
  ): Promise<ContextToolArtifactReadResult> {
    const session = await this.load();
    const artifact = session.contextToolArtifacts?.find((candidate) =>
      candidate.ref === ref && candidate.runId === expectedRunId);
    if (!artifact) {
      const stale = session.contextToolArtifacts?.find((candidate) => candidate.ref === ref);
      const replacement = stale && session.contextToolArtifacts?.find((candidate) => (
        candidate.runId === expectedRunId
        && candidate.callId === stale.callId
        && candidate.outputDigest === stale.outputDigest
      ));
      return {
        mimiStatus: 'tool_input_rejected',
        code: stale ? 'context_artifact_stale' : 'context_artifact_unavailable',
        retryable: replacement !== undefined,
        message: replacement
          ? 'Context Artifact ref 属于旧 Run；原 ref 仍不可读，请使用当前 Run 的 replacementRef 重试一次'
          : '当前 Session/Run 没有可读的 Context Artifact 或当前 Context View 未提供有效 alias；不要重试原 ref',
        ...(replacement ? {
          next: 'read_context_artifact' as const,
          replacementRef: replacement.ref,
        } : {}),
      };
    }
    const item = [...session.items, ...pendingItems].find((candidate) => {
      const value = candidate as unknown as Record<string, unknown>;
      if (value.type !== 'function_call_result') return false;
      const callId = String(value.callId ?? value.call_id ?? '');
      if (callId !== artifact.callId) return false;
      const digest = `sha256:${createHash('sha256')
        .update(JSON.stringify(value.output ?? null))
        .digest('hex')}`;
      return digest === artifact.outputDigest;
    }) as unknown as Record<string, unknown> | undefined;
    if (!item) return {
      mimiStatus: 'tool_input_rejected',
      code: 'context_artifact_integrity_failed',
      retryable: false,
      message: 'Context Artifact 的 canonical/pending 工具结果缺失或摘要引用校验失败；不要重试或换路重做原工具动作',
    };
    return {
      ref: artifact.ref,
      callId: artifact.callId,
      toolName: artifact.toolName,
      ...contextArtifactPage(item.output, page.offset, page.limit),
    };
  }

  async getPreferences(): Promise<SessionPreferences> {
    return { ...(await this.load()).preferences };
  }

  async getActiveSkills(): Promise<ActivatedSkill[]> {
    return (await this.load()).activeSkills?.map((skill) => ({ ...skill })) ?? [];
  }

  async activateSkill(
    record: Omit<ActivatedSkill, 'activatedAt' | 'updatedAt'>
      & Partial<Pick<ActivatedSkill, 'activatedAt' | 'updatedAt'>>,
    expectedRunId?: string,
  ): Promise<SkillActivationStatus> {
    return this.mutateWhen((session) => {
      if (expectedRunId && (
        session.checkpoint?.status !== 'running'
        || session.checkpoint.runId !== expectedRunId
      )) {
        return { result: 'stale_run' as const, changed: false };
      }
      const active = session.activeSkills ?? [];
      const index = active.findIndex((skill) => skill.name === record.name);
      const previous = index >= 0 ? active[index] : undefined;
      if (previous
        && previous.file === record.file
        && previous.contentHash === record.contentHash
        && previous.sourceId === record.sourceId) {
        return { result: 'already_active' as const, changed: false };
      }
      const now = new Date().toISOString();
      const next: ActivatedSkill = {
        name: record.name,
        sourceId: record.sourceId,
        file: record.file,
        contentHash: record.contentHash,
        activatedAt: previous?.activatedAt ?? record.activatedAt ?? now,
        updatedAt: record.updatedAt ?? now,
      };
      if (index >= 0) active[index] = next;
      else active.push(next);
      session.activeSkills = active;
      session.updatedAt = now;
      return { result: previous ? 'updated' as const : 'activated' as const, changed: true };
    });
  }

  async deactivateSkill(name: string): Promise<boolean> {
    return this.mutateWhen((session) => {
      const active = session.activeSkills ?? [];
      const next = active.filter((skill) => skill.name !== name);
      if (next.length === active.length) return { result: false, changed: false };
      session.activeSkills = next;
      session.updatedAt = new Date().toISOString();
      return { result: true, changed: true };
    });
  }

  async setPreferences(preferences: Partial<SessionPreferences>): Promise<void> {
    await this.mutate((session) => {
      session.preferences = { ...session.preferences, ...preferences };
      session.updatedAt = new Date().toISOString();
    });
  }

  async popItem(): Promise<AgentInputItem | undefined> {
    return this.mutate((session) => {
      const item = session.items.pop();
      session.updatedAt = new Date().toISOString();
      return item;
    });
  }

  async clearSession(relatedCleanup?: () => Promise<void>): Promise<void> {
    await this.mutate(async (session) => {
      if (session.checkpoint?.status === 'running' && checkpointOwnerIsLive(session.checkpoint)) {
        throw new Error(`Session ${this.id} 仍有任务运行中，不能清空`);
      }
      await relatedCleanup?.();
      session.items = [];
      session.checkpoint = undefined;
      session.lastStoppedRun = undefined;
      session.contextArchive = undefined;
      session.contextWorkSnapshot = undefined;
      session.contextToolArtifacts = [];
      session.activeSkills = [];
      session.updatedAt = new Date().toISOString();
    });
  }

  /** Inspect one atomic transcript without initialization, repair, locks, or permission writes. */
  async readSnapshot(): Promise<(SessionFile & { summary: SessionSummary }) | undefined> {
    try {
      await lstat(`${this.file}.corrupt-state`);
      throw new StateFileCorruptError(this.file, `${this.file}.corrupt-state`, {
        cause: new Error('Session 已标记损坏，需要显式恢复'),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    let source: string;
    try {
      source = await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    const session = decodeSessionFile(JSON.parse(source) as unknown);
    if (session.id !== this.id) throw new SyntaxError(`Session 文件身份不匹配：${this.id}`);
    return { ...session, summary: summarizeSession(session) };
  }

  async summary(): Promise<SessionSummary> {
    return summarizeSession(await this.load());
  }

  async cleanupGeneratedSummaries(): Promise<number> {
    return this.mutateWhen((session) => {
      const items = session.items.filter((item) => !isGeneratedHistoryContext(item));
      const removed = session.items.length - items.length;
      if (removed > 0) {
        session.items = items;
        session.contextArchive = undefined;
        session.updatedAt = new Date().toISOString();
      }
      return { result: removed, changed: removed > 0 };
    });
  }

  async repairToolPairs(): Promise<number> {
    return this.mutateWhen((session) => {
      const callIndexes = new Map<string, number>();
      const resultIndexes = new Map<string, number>();
      session.items.forEach((item, index) => {
        if (!('type' in item) || !('callId' in item)) return;
        const callId = String(item.callId);
        if (item.type === 'function_call' && !callIndexes.has(callId)) callIndexes.set(callId, index);
        if (item.type === 'function_call_result') {
          const callIndex = callIndexes.get(callId);
          if (callIndex !== undefined && index > callIndex && !resultIndexes.has(callId)) resultIndexes.set(callId, index);
        }
      });
      const items = session.items.filter((item, index) => {
        if (!('type' in item) || !('callId' in item)) return true;
        const callId = String(item.callId);
        if (item.type === 'function_call') return callIndexes.get(callId) === index && resultIndexes.has(callId);
        if (item.type === 'function_call_result') return resultIndexes.get(callId) === index;
        return true;
      });
      const removed = session.items.length - items.length;
      if (removed) {
        session.items = items;
        session.contextArchive = undefined;
        session.updatedAt = new Date().toISOString();
      }
      return { result: removed, changed: removed > 0 };
    });
  }

  static async list(directory: string): Promise<string[]> {
    try {
      return (await readdir(directory))
        .filter((name) => name.endsWith('.json'))
        .map((name) => name.slice(0, -5))
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  static async listSummaries(directory: string): Promise<SessionSummary[]> {
    const root = path.resolve(directory);
    let index = summaryIndexes.get(root);
    if (!index) {
      index = { entries: new Map() };
      summaryIndexes.set(root, index);
      // Bound independent workspace indexes without evicting canonical data.
      if (summaryIndexes.size > 32) summaryIndexes.delete(summaryIndexes.keys().next().value!);
    }
    const current = index;
    current.pending ??= (async () => {
      const listed = await FileSession.list(root);
      const blocked = listed.length ? new Set((await readdir(root)).filter((name) => name.endsWith('.json.corrupt-state'))) : new Set<string>();
      const ids = listed.filter((id) => !blocked.has(`${id}.json.corrupt-state`));
      const present = new Set(ids);
      for (const id of current.entries.keys()) if (!present.has(id)) current.entries.delete(id);
      const summaries = await mapSessions(ids, async (id) => {
        try {
          const info = await lstat(path.join(root, `${id}.json`), { bigint: true });
          if (!info.isFile()) return undefined;
          const fingerprint = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
          const cached = current.entries.get(id);
          if (cached?.fingerprint === fingerprint) return cached.summary;
          let snapshot;
          try {
            snapshot = await new FileSession(root, id).readSnapshot();
          } catch (error) {
            // Browsing must never quarantine or repair a damaged transcript.
            if (!(error instanceof StateFileCorruptError || error instanceof SyntaxError || error instanceof z.ZodError)) throw error;
          }
          const summary = snapshot?.summary;
          current.entries.set(id, { fingerprint, summary });
          return summary;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            current.entries.delete(id);
            return undefined;
          }
          throw error;
        }
      });
      return summaries.filter((summary): summary is SessionSummary => summary !== undefined)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
    })().finally(() => { current.pending = undefined; });
    return (await current.pending).map((summary) => ({ ...summary }));
  }

  /** Fast O(1) existence check that avoids loading every session file. */
  static async exists(directory: string, id: string): Promise<boolean> {
    try {
      await access(path.join(directory, `${assertSessionId(id)}.json`));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  private async load(): Promise<SessionFile> {
    return this.state.read();
  }

  private mutate<T>(mutation: (session: SessionFile) => T): Promise<T> {
    return this.state.update(mutation);
  }

  private mutateWhen<T>(mutation: (session: SessionFile) => { result: T; changed: boolean }): Promise<T> {
    return this.state.updateWhen(mutation);
  }

  private async finishRun(
    status: Exclude<RunStatus, 'running'>,
    update: Pick<RunCheckpoint, 'phase'> & Partial<Pick<
      RunCheckpoint,
      'answer' | 'error' | 'nextAction' | 'outcome' | 'finalization'
    >>,
    expectedRunId?: string,
  ): Promise<RunCheckpoint | undefined> {
    return this.mutateWhen((session) => {
      if (!session.checkpoint) return { result: undefined, changed: false };
      if ((expectedRunId && session.checkpoint.runId !== expectedRunId)
        || session.checkpoint.status !== 'running') {
        return { result: { ...session.checkpoint }, changed: false };
      }
      const now = new Date().toISOString();
      session.checkpoint = {
        ...session.checkpoint,
        ...update,
        status,
        ownerId: undefined,
        ownerPid: undefined,
        updatedAt: now,
      };
      session.updatedAt = now;
      return { result: { ...session.checkpoint }, changed: true };
    });
  }
}
