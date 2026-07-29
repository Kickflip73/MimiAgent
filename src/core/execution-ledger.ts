import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AtomicJsonStore, UnsupportedStateVersionError } from './state-file.js';
import {
  actionIntentSchema,
  evaluateActionAuthorization,
  ActionFailedSafeError,
  ActionIntentUncertainError,
  type ActionIntent,
  type ActionIntentReceipt,
  type GuardedActionContext,
  type OneTimeActionAuthorization,
} from './action-intent.js';

export const DEFAULT_EXECUTION_LEDGER_MAX_OUTPUT_BYTES = 64_000;

export interface ExecutionCall {
  sessionId: string;
  runId: string;
  toolName: string;
  callId: string;
  modelCallId?: string;
  argumentsJson: string;
}

export interface SucceededExecutionCall extends ExecutionCall {
  output: unknown;
}

export interface ExecutionCallRecord extends ExecutionCall {
  modelCallIds?: string[];
  status: ExecutionStatus;
  output?: unknown;
  error?: string;
}

export type ExecutionStatus = 'started' | 'succeeded' | 'failed' | 'uncertain';

interface ExecutionEntry extends ExecutionCall {
  modelCallIds?: string[];
  key: string;
  argumentsHash: string;
  status: ExecutionStatus;
  outputJson?: string;
  error?: string;
  startedAt: string;
  updatedAt: string;
}

interface ActionIntentEntry {
  sessionId: string;
  runId: string;
  intent: ActionIntent;
  status: 'started' | 'confirmed' | 'failed_safe' | 'uncertain';
  attempts: number;
  authorizationIds: string[];
  authorizationSource: 'guarded-owner-fast-path' | 'one-time-authorization';
  resultJson?: string;
  error?: string;
  startedAt: string;
  updatedAt: string;
}

interface LedgerFile {
  version: 2;
  entries: Record<string, ExecutionEntry>;
  actionIntents: Record<string, ActionIntentEntry>;
}

const entrySchema = z.object({
  key: z.string(),
  sessionId: z.string(),
  runId: z.string(),
  toolName: z.string(),
  callId: z.string(),
  modelCallId: z.string().optional(),
  modelCallIds: z.array(z.string()).optional(),
  argumentsJson: z.string(),
  argumentsHash: z.string(),
  status: z.enum(['started', 'succeeded', 'failed', 'uncertain']),
  outputJson: z.string().optional(),
  error: z.string().optional(),
  startedAt: z.string(),
  updatedAt: z.string(),
});
const actionIntentEntrySchema = z.object({
  sessionId: z.string(),
  runId: z.string(),
  intent: actionIntentSchema,
  status: z.enum(['started', 'confirmed', 'failed_safe', 'uncertain']),
  attempts: z.number().int().positive(),
  authorizationIds: z.array(z.string()),
  authorizationSource: z.enum(['guarded-owner-fast-path', 'one-time-authorization']),
  resultJson: z.string().optional(),
  error: z.string().optional(),
  startedAt: z.string(),
  updatedAt: z.string(),
});
const ledgerV1Schema = z.object({ version: z.literal(1), entries: z.record(z.string(), entrySchema) });
const ledgerSchema = z.object({
  version: z.literal(2),
  entries: z.record(z.string(), entrySchema),
  actionIntents: z.record(z.string(), actionIntentEntrySchema),
});

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function executionKey(call: ExecutionCall): string {
  return digest([call.sessionId, call.runId, call.toolName, call.callId].join('\0'));
}

export function executionReceiptRef(call: ExecutionCall): string {
  return `execution:${executionKey(call)}`;
}

function receiptCall(sessionId: string, runId: string): ExecutionCall {
  return {
    sessionId,
    runId,
    toolName: '__mimi_execution_receipt__',
    callId: 'completed',
    argumentsJson: '{}',
  };
}

interface SerializedOutput<T> {
  json: string;
  value: T;
}

interface TruncatedExecutionOutput {
  mimiStatus: 'output_truncated';
  message: string;
  originalBytes: number;
  sha256: string;
}

function serializeOutput<T>(value: T, maxBytes: number): SerializedOutput<T> {
  const output = JSON.stringify([value]);
  if (output === undefined) throw new Error('工具输出无法序列化，不能提交执行账本');
  const originalBytes = Buffer.byteLength(output, 'utf8');
  if (originalBytes <= maxBytes) return { json: output, value };
  const receipt: TruncatedExecutionOutput = {
    mimiStatus: 'output_truncated',
    message: '工具已成功执行，但输出超过执行账本限制；完整输出未持久化，本回执可安全重放。',
    originalBytes,
    sha256: digest(output),
  };
  const bounded = JSON.stringify([receipt]);
  if (Buffer.byteLength(bounded, 'utf8') > maxBytes) {
    throw new Error(`工具输出超过执行账本 ${maxBytes} 字节限制，且无法保存有界成功回执`);
  }
  return { json: bounded, value: receipt as T };
}

function deserializeOutput<T>(value: string): T {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error('执行账本输出格式无效');
  return parsed[0] as T;
}

export class ExecutionLedger {
  private readonly state: AtomicJsonStore<LedgerFile>;
  private readonly inFlight = new Map<string, { argumentsHash: string; execution: Promise<unknown> }>();
  private readonly maxEntries: number;
  private readonly maxOutputBytes: number;
  private readonly retentionMs: number;
  private migrationPending = false;

  constructor(file: string, options: ExecutionLedgerOptions = {}) {
    this.maxEntries = positiveLimit(options.maxEntries, 2_000, 'maxEntries');
    this.maxOutputBytes = positiveLimit(
      options.maxOutputBytes,
      DEFAULT_EXECUTION_LEDGER_MAX_OUTPUT_BYTES,
      'maxOutputBytes',
    );
    this.retentionMs = positiveLimit(options.retentionMs, 30 * 24 * 60 * 60_000, 'retentionMs');
    this.state = new AtomicJsonStore(file, {
      defaultValue: () => ({
        version: 2,
        entries: Object.create(null) as Record<string, ExecutionEntry>,
        actionIntents: Object.create(null) as Record<string, ActionIntentEntry>,
      }),
      decode: (value) => {
        const version = value && typeof value === 'object'
          ? (value as { version?: unknown }).version
          : undefined;
        if (typeof version === 'number' && Number.isSafeInteger(version) && version > 2) {
          throw new UnsupportedStateVersionError('ExecutionLedger', version, 2);
        }
        const legacy = ledgerV1Schema.safeParse(value);
        if (legacy.success) {
          this.migrationPending = true;
          return {
            version: 2,
            entries: Object.assign(Object.create(null), legacy.data.entries) as Record<string, ExecutionEntry>,
            actionIntents: Object.create(null) as Record<string, ActionIntentEntry>,
          };
        }
        const parsed = ledgerSchema.parse(value);
        return {
          version: 2,
          entries: Object.assign(Object.create(null), parsed.entries) as Record<string, ExecutionEntry>,
          actionIntents: Object.assign(
            Object.create(null),
            parsed.actionIntents,
          ) as Record<string, ActionIntentEntry>,
        };
      },
      pretty: false,
      // Losing this ledger could replay a side effect whose outcome is unknown.
      // Quarantine the file, but fail closed until the user inspects it.
      preserveSchemaMismatch: true,
      recoverCorrupt: false,
    });
  }

  async initialize(): Promise<void> {
    await this.state.updateWhen(() => ({
      result: undefined,
      changed: this.migrationPending,
    }));
    this.migrationPending = false;
  }

  async executeActionIntent<T>(
    sessionId: string,
    runId: string,
    intentInput: ActionIntent,
    context: GuardedActionContext,
    authorization: OneTimeActionAuthorization | undefined,
    operation: () => Promise<T>,
  ): Promise<ActionIntentReceipt<T>> {
    const intent = actionIntentSchema.parse(intentInput);
    if (intent.status !== 'not_started' && intent.status !== 'failed_safe') {
      throw new Error(`ActionIntent 输入状态 ${intent.status} 不允许开始执行`);
    }
    const authorizationDecision = evaluateActionAuthorization(intent, context, authorization);
    if (!authorizationDecision.allowed) throw new Error(authorizationDecision.reason);
    const businessActionRef = 'businessActionRef' in intent
      ? intent.businessActionRef
      : undefined;
    const decision = await this.state.updateWhen<{ replay?: ActionIntentReceipt<T> }>((ledger) => {
      const existing = ledger.actionIntents[intent.executionKey];
      const matchingBusinessAttempts = businessActionRef
        ? Object.entries(ledger.actionIntents).filter(([executionKey, entry]) => (
            executionKey !== intent.executionKey
            && entry.sessionId === sessionId
            && 'businessActionRef' in entry.intent
            && entry.intent.businessActionRef === businessActionRef
            && entry.intent.actionFamily === intent.actionFamily
          ))
        : [];
      const uncertainBusinessAttempt = matchingBusinessAttempts.find(([, entry]) =>
        entry.status === 'started' || entry.status === 'uncertain');
      if (uncertainBusinessAttempt) {
        throw new ActionIntentUncertainError(
          `业务操作 ${businessActionRef} 的 ${intent.actionFamily} 之前处于`
          + ` ${uncertainBusinessAttempt[1].status} 状态；即使更换临时目标、载荷或会话也禁止自动重放`,
        );
      }
      const confirmedBusinessAttempt = matchingBusinessAttempts.find(([, entry]) =>
        entry.status === 'confirmed');
      if (confirmedBusinessAttempt) {
        if (!confirmedBusinessAttempt[1].resultJson) {
          throw new Error('ActionIntent confirmed 回执缺少结果');
        }
        return {
          result: {
            replay: deserializeOutput<ActionIntentReceipt<T>>(confirmedBusinessAttempt[1].resultJson),
          },
          changed: false,
        };
      }
      if (authorizationDecision.authorizationId) {
        const consumedBy = Object.entries(ledger.actionIntents).find(([, entry]) =>
          entry.authorizationIds.includes(authorizationDecision.authorizationId!));
        if (consumedBy && consumedBy[0] !== intent.executionKey) {
          throw new Error('一次性授权已由其他 ActionIntent 消费');
        }
      }
      if (existing) {
        if (existing.sessionId !== sessionId) {
          throw new Error('ActionIntent executionKey 已属于其他 Session');
        }
        const sameAction = existing.intent.actionFamily === intent.actionFamily
          && existing.intent.targetRef === intent.targetRef
          && existing.intent.payloadDigest === intent.payloadDigest
          && existing.intent.policyRevision === intent.policyRevision
          && (!('businessActionRef' in existing.intent) || !('businessActionRef' in intent)
            || existing.intent.businessActionRef === intent.businessActionRef);
        if (!sameAction) throw new Error(`ActionIntent executionKey 冲突：${intent.executionKey}`);
        if (existing.status === 'confirmed') {
          if (!existing.resultJson) throw new Error('ActionIntent confirmed 回执缺少结果');
          return {
            result: {
              replay: deserializeOutput<ActionIntentReceipt<T>>(existing.resultJson),
            },
            changed: false,
          };
        }
        if (existing.status === 'started' || existing.status === 'uncertain') {
          throw new Error(`ActionIntent 之前处于 ${existing.status} 状态，禁止换路或自动重放`);
        }
        if (existing.intent.selectedRoute === intent.selectedRoute) {
          throw new Error('ActionIntent failed_safe 后必须选择不同执行路径');
        }
        if (authorizationDecision.authorizationId
          && existing.authorizationIds.includes(authorizationDecision.authorizationId)) {
          throw new Error('一次性授权已消费，不能用于 ActionIntent 换路');
        }
        existing.intent = { ...intent, status: 'started' };
        existing.status = 'started';
        existing.attempts += 1;
        existing.authorizationSource = authorizationDecision.source;
        if (authorizationDecision.authorizationId) {
          existing.authorizationIds.push(authorizationDecision.authorizationId);
        }
        existing.updatedAt = new Date().toISOString();
        delete existing.resultJson;
        delete existing.error;
        return { result: {}, changed: true };
      }
      const timestamp = new Date().toISOString();
      ledger.actionIntents[intent.executionKey] = {
        sessionId,
        runId,
        intent: { ...intent, status: 'started' },
        status: 'started',
        attempts: 1,
        authorizationIds: authorizationDecision.authorizationId
          ? [authorizationDecision.authorizationId]
          : [],
        authorizationSource: authorizationDecision.source,
        startedAt: timestamp,
        updatedAt: timestamp,
      };
      return { result: {}, changed: true };
    });
    if (decision.replay) return decision.replay;

    try {
      const result = await operation();
      return await this.commitActionIntent(intent.executionKey, 'confirmed', result);
    } catch (error) {
      if (error instanceof ActionFailedSafeError) {
        return this.commitActionIntent(intent.executionKey, 'failed_safe', {
          error: error.message.slice(0, 2_000),
        }) as Promise<ActionIntentReceipt<T>>;
      }
      const receipt = await this.commitActionIntent(intent.executionKey, 'uncertain', {
        error: error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000),
      });
      throw new ActionIntentUncertainError(
        `ActionIntent ${intent.intentId} 结果不确定，禁止自动重放`,
        { cause: receipt },
      );
    }
  }

  async getActionIntent(executionKeyValue: string): Promise<ActionIntentReceipt | undefined> {
    const entry = (await this.state.read()).actionIntents[executionKeyValue];
    if (!entry) return undefined;
    if (entry.resultJson) return deserializeOutput<ActionIntentReceipt>(entry.resultJson);
    return {
      intent: { ...entry.intent, status: entry.status },
      outcome: entry.status === 'started' ? 'uncertain' : entry.status,
      authorizationSource: entry.authorizationSource,
      attempts: entry.attempts,
      updatedAt: entry.updatedAt,
    };
  }

  async isConfirmedActionIntent(executionKeyValue: string, sessionId: string): Promise<boolean> {
    const entry = (await this.state.read()).actionIntents[executionKeyValue];
    return entry?.sessionId === sessionId
      && entry.status === 'confirmed'
      && entry.intent.status === 'confirmed'
      && entry.resultJson !== undefined;
  }

  async isConfirmedExternalReceipt(reference: string, sessionId: string): Promise<boolean> {
    if (reference.startsWith('action-intent:')) {
      const executionKeyValue = reference.slice('action-intent:'.length);
      if (!await this.isConfirmedActionIntent(executionKeyValue, sessionId)) return false;
      const receipt = await this.getActionIntent(executionKeyValue);
      const result = receipt?.result;
      if (result !== null && typeof result === 'object' && !Array.isArray(result)) {
        const value = result as Record<string, unknown>;
        if (value.completionScope === 'interaction' || value.businessOutcome === 'unverified') {
          return false;
        }
      }
      return true;
    }
    if (!reference.startsWith('execution:')) return false;
    const entry = (await this.state.read()).entries[reference.slice('execution:'.length)];
    if (entry?.sessionId !== sessionId
      || entry.status !== 'succeeded'
      || entry.toolName !== 'connector_action'
      || !entry.outputJson) return false;
    const output = deserializeOutput<unknown>(entry.outputJson);
    return output !== null
      && typeof output === 'object'
      && !Array.isArray(output)
      && (output as Record<string, unknown>).outcome === 'confirmed';
  }

  private async commitActionIntent<T>(
    executionKeyValue: string,
    status: 'confirmed' | 'failed_safe' | 'uncertain',
    result: T,
  ): Promise<ActionIntentReceipt<T>> {
    return this.state.update((ledger) => {
      const entry = ledger.actionIntents[executionKeyValue];
      if (!entry || entry.status !== 'started') {
        throw new Error(`ActionIntent ${executionKeyValue} 的执行状态已失效`);
      }
      const updatedAt = new Date().toISOString();
      const receipt: ActionIntentReceipt<T> = {
        intent: { ...entry.intent, status },
        outcome: status,
        result,
        authorizationSource: entry.authorizationSource,
        attempts: entry.attempts,
        updatedAt,
      };
      let serialized = serializeOutput(receipt, this.maxOutputBytes);
      if (serialized.value !== receipt) {
        const boundedReceipt: ActionIntentReceipt<T> = {
          ...receipt,
          result: serialized.value as T,
        };
        serialized = serializeOutput(boundedReceipt, this.maxOutputBytes);
        if (serialized.value !== boundedReceipt) {
          throw new Error(`ActionIntent ${executionKeyValue} 回执超过执行账本限制`);
        }
      }
      entry.intent = serialized.value.intent;
      entry.status = status;
      entry.resultJson = serialized.json;
      entry.updatedAt = updatedAt;
      return serialized.value;
    });
  }

  executeOnce<T>(call: ExecutionCall, operation: () => Promise<T>): Promise<T> {
    const key = executionKey(call);
    const argumentsHash = digest(call.argumentsJson);
    const running = this.inFlight.get(key);
    if (running) {
      if (running.argumentsHash !== argumentsHash) {
        return Promise.reject(new Error(`工具调用 ${call.callId} 参数冲突，拒绝执行`));
      }
      return running.execution as Promise<T>;
    }
    const execution = this.executePersisted(key, call, operation);
    this.inFlight.set(key, { argumentsHash, execution });
    void execution.finally(() => {
      if (this.inFlight.get(key)?.execution === execution) this.inFlight.delete(key);
    }).catch(() => undefined);
    return execution;
  }

  commitReceipt<T>(sessionId: string, runId: string, receipt: T): Promise<T> {
    return this.executeOnce(receiptCall(sessionId, runId), async () => receipt);
  }

  async getReceipt<T>(sessionId: string, runId: string): Promise<T | undefined> {
    const call = receiptCall(sessionId, runId);
    const entry = (await this.state.read()).entries[executionKey(call)];
    if (!entry) return undefined;
    if (entry.argumentsHash !== digest(call.argumentsJson)) {
      throw new Error(`Execution ${runId} 的完成回执参数冲突`);
    }
    if (entry.status !== 'succeeded' || entry.outputJson === undefined) {
      throw new Error(`Execution ${runId} 的完成回执处于 ${entry.status} 状态，拒绝自动重跑`);
    }
    return deserializeOutput<T>(entry.outputJson);
  }

  async clearReceipt(sessionId: string, runId: string): Promise<void> {
    const key = executionKey(receiptCall(sessionId, runId));
    await this.state.updateWhen((ledger) => {
      if (!ledger.entries[key]) return { result: undefined, changed: false };
      delete ledger.entries[key];
      return { result: undefined, changed: true };
    });
  }

  async clearSession(sessionId: string): Promise<void> {
    await this.state.updateWhen((ledger) => {
      let changed = false;
      for (const [key, entry] of Object.entries(ledger.entries)) {
        if (entry.sessionId === sessionId) {
          delete ledger.entries[key];
          changed = true;
        }
      }
      for (const [key, entry] of Object.entries(ledger.actionIntents)) {
        if (entry.sessionId === sessionId) {
          delete ledger.actionIntents[key];
          changed = true;
        }
      }
      return { result: undefined, changed };
    });
  }

  async listSucceededCalls(sessionId: string, runId: string): Promise<SucceededExecutionCall[]> {
    const entries = Object.values((await this.state.read()).entries)
      .filter((entry) => entry.sessionId === sessionId && entry.runId === runId && entry.status === 'succeeded')
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt) || left.key.localeCompare(right.key));
    return entries.map((entry) => {
      if (entry.outputJson === undefined) throw new Error(`工具调用 ${entry.callId} 缺少成功输出`);
      return {
        sessionId: entry.sessionId,
        runId: entry.runId,
        toolName: entry.toolName,
        callId: entry.callId,
        ...(entry.modelCallId ? { modelCallId: entry.modelCallId } : {}),
        argumentsJson: entry.argumentsJson,
        output: deserializeOutput<unknown>(entry.outputJson),
      };
    });
  }

  async listCalls(sessionId: string, runId: string): Promise<ExecutionCallRecord[]> {
    const entries = Object.values((await this.state.read()).entries)
      .filter((entry) => entry.sessionId === sessionId
        && (entry.runId === runId || entry.runId.startsWith(`${runId}:`))
        && entry.toolName !== '__mimi_execution_receipt__')
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt) || left.key.localeCompare(right.key));
    return entries.map((entry) => ({
      sessionId: entry.sessionId,
      runId: entry.runId,
      toolName: entry.toolName,
      callId: entry.callId,
      ...(entry.modelCallId ? { modelCallId: entry.modelCallId } : {}),
      ...(entry.modelCallIds?.length ? { modelCallIds: entry.modelCallIds } : {}),
      argumentsJson: entry.argumentsJson,
      status: entry.status,
      ...(entry.outputJson === undefined ? {} : { output: deserializeOutput<unknown>(entry.outputJson) }),
      ...(entry.error === undefined ? {} : { error: entry.error }),
    }));
  }

  async clearSessionExcept(sessionId: string, retainedRunId: string): Promise<void> {
    await this.state.updateWhen((ledger) => {
      let changed = false;
      for (const [key, entry] of Object.entries(ledger.entries)) {
        const retained = entry.runId === retainedRunId || entry.runId.startsWith(`${retainedRunId}:`);
        if (entry.sessionId === sessionId && !retained) {
          delete ledger.entries[key];
          changed = true;
        }
      }
      for (const [key, entry] of Object.entries(ledger.actionIntents)) {
        const retained = entry.runId === retainedRunId || entry.runId.startsWith(`${retainedRunId}:`);
        if (entry.sessionId === sessionId && !retained) {
          delete ledger.actionIntents[key];
          changed = true;
        }
      }
      return { result: undefined, changed };
    });
  }

  async clearRun(sessionId: string, runId: string): Promise<void> {
    await this.state.updateWhen((ledger) => {
      let changed = false;
      for (const [key, entry] of Object.entries(ledger.entries)) {
        if (entry.sessionId === sessionId && (entry.runId === runId || entry.runId.startsWith(`${runId}:`))) {
          delete ledger.entries[key];
          changed = true;
        }
      }
      for (const [key, entry] of Object.entries(ledger.actionIntents)) {
        if (entry.sessionId === sessionId
          && (entry.runId === runId || entry.runId.startsWith(`${runId}:`))) {
          delete ledger.actionIntents[key];
          changed = true;
        }
      }
      return { result: undefined, changed };
    });
  }

  private async executePersisted<T>(
    key: string,
    call: ExecutionCall,
    operation: () => Promise<T>,
  ): Promise<T> {
    const argumentsHash = digest(call.argumentsJson);
    const decision = await this.state.updateWhen<{ outputJson: string | undefined }>((ledger) => {
      const existing = ledger.entries[key];
      if (existing) {
        if (existing.argumentsHash !== argumentsHash) throw new Error(`工具调用 ${call.callId} 参数冲突，拒绝执行`);
        if (existing.status === 'succeeded' && existing.outputJson !== undefined) {
          const aliases = new Set(existing.modelCallIds ?? (existing.modelCallId ? [existing.modelCallId] : []));
          const before = aliases.size;
          if (call.modelCallId) aliases.add(call.modelCallId);
          existing.modelCallIds = [...aliases];
          return { result: { outputJson: existing.outputJson }, changed: aliases.size !== before };
        }
        throw new Error(`工具调用 ${call.callId} 之前处于 ${existing.status} 状态，为避免重复副作用不会自动重试`);
      }
      this.prune(ledger, Date.now());
      if (Object.keys(ledger.entries).length >= this.maxEntries) {
        throw new Error(`执行账本已达到 ${this.maxEntries} 条上限；请完成或清理旧 Session 后再执行副作用`);
      }
      const now = new Date().toISOString();
      ledger.entries[key] = {
        ...call,
        ...(call.modelCallId ? { modelCallIds: [call.modelCallId] } : {}),
        key,
        argumentsHash,
        status: 'started',
        startedAt: now,
        updatedAt: now,
      };
      return { result: { outputJson: undefined }, changed: true };
    });
    if (decision.outputJson !== undefined) return deserializeOutput<T>(decision.outputJson);

    try {
      const output = await operation();
      const serialized = serializeOutput(output, this.maxOutputBytes);
      await this.state.update((ledger) => {
        const entry = ledger.entries[key];
        if (!entry || entry.status !== 'started' || entry.argumentsHash !== argumentsHash) {
          throw new Error(`工具调用 ${call.callId} 的执行账本状态已失效`);
        }
        entry.status = 'succeeded';
        entry.outputJson = serialized.json;
        entry.updatedAt = new Date().toISOString();
      });
      return serialized.value;
    } catch (error) {
      await this.state.update((ledger) => {
        const entry = ledger.entries[key];
        if (entry?.status === 'started' && entry.argumentsHash === argumentsHash) {
          const uncertain = error instanceof Error
            && (error.name.includes('Uncertain') || /结果不确定|outcome uncertain/i.test(error.message));
          entry.status = uncertain ? 'uncertain' : 'failed';
          entry.error = error instanceof Error ? error.message.slice(0, 4_000) : String(error).slice(0, 4_000);
          entry.updatedAt = new Date().toISOString();
        }
      });
      throw error;
    }
  }

  private prune(ledger: LedgerFile, now: number): void {
    const cutoff = now - this.retentionMs;
    for (const [key, entry] of Object.entries(ledger.entries)) {
      // Durable Events can remain in dead letter until the owner retries their
      // immutable ID. Their ledgers are cleared explicitly after Event commit;
      // TTL pruning here would silently replay old external effects.
      if (!entry.runId.startsWith('event:')
        && entry.status !== 'started'
        && Date.parse(entry.updatedAt) < cutoff) delete ledger.entries[key];
    }
  }
}

export interface ExecutionLedgerOptions {
  maxEntries?: number;
  maxOutputBytes?: number;
  retentionMs?: number;
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0) throw new Error(`${name} 必须是正安全整数`);
  return selected;
}
