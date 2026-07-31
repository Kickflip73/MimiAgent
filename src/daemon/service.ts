import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { access, chmod, link, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse as parseDotenv } from 'dotenv';
import {
  adoptRuntimeWorkspaceConfig,
  adoptWorkspaceConfig,
  preferredEnvironmentValue,
  resolveEnvironmentFile,
  securityProfileSummary,
  type AgentPermissionMode,
  type AppConfig,
} from '../config.js';
import { persistEnvironmentValues } from '../provider-config.js';
import { MimiAgent } from '../agent.js';
import { sanitizeSensitiveData } from '../core/data-sanitizer.js';
import { assertSessionId } from '../core/session-id.js';
import { configureAgentRuntime, requireProviderApiKey } from '../runtime/bootstrap.js';
import { MimiHost } from '../runtime/mimi-host.js';
import {
  AgentRunService,
  providerBackupRouteFromEnvironment,
} from '../runtime/run-service.js';
import { resolveTaskWorkspace } from '../runtime/workspace-resolution.js';
import { stageAttachments, type LocalAttachmentRequest } from '../runtime/attachments.js';
import { MimiDispatcher } from './dispatcher.js';
import {
  ConnectorManager,
  parseConnectorConfig,
  type ConnectorCapability,
  type ConnectorFileConfig,
} from './connectors.js';
import {
  connectorCapabilitySnapshot,
  createConnectorHostTools,
} from './connector-action-tool.js';
import {
  WORKER_CONNECTOR_ACTION_METHOD,
  WORKER_CONNECTOR_INSPECT_METHOD,
  workerConnectorActionParamsSchema,
  workerConnectorInspectParamsSchema,
} from './connector-worker-rpc.js';
import {
  ensureControlToken,
  mimiRpc,
  MimiIpcServer,
  readControlToken,
} from './ipc.js';
import { NotifierRegistry } from './notifier.js';
import { MimiStore } from './store.js';
import { MimiWebhookServer } from './webhook.js';
import { MimiRuntimeHttpServer, runtimeHttpSessionId } from './runtime-http.js';
import { AttentionEngine } from './attention.js';
import { EphemeralSecretBroker } from './ephemeral-secrets.js';
import { TaskProcessSupervisor } from './task-supervisor.js';
import { backgroundTaskSummary, inspectBackgroundTaskSummary } from './task-tools.js';
import {
  buildDaemonHealth,
  doctorBlockingHealthRisks,
  type DaemonHealthSnapshot,
} from './health-model.js';
import {
  inspectDiagnosticStorage,
  type DiagnosticStorageSnapshot,
} from './diagnostics.js';
import { rotateDaemonLogs } from './log-maintenance.js';
import {
  DaemonLifecycleStore,
  type DaemonLifecycleEpoch,
  type DaemonLifecycleStopReason,
} from './lifecycle.js';
import { classifyReadinessUnknown } from './operational-classification.js';
import {
  BACKGROUND_DEFAULTS_VERSION,
  defaultConnectorEnabled,
  LEGACY_VISIBLE_MACOS_CONNECTORS,
  legacyVisibleConnectorsToDisable,
  personalMessageConnectorsToAdd,
} from './background-defaults.js';
import { createMimiCommandHostTools } from './host-tools.js';
import {
  MimiLiveEvents,
  mimiRuntimeStreamEvent,
  mimiStreamEvent,
  mimiStreamTaskState,
} from './live-events.js';
import { ownerSessionId } from './policy.js';
import {
  sharedCuaDriverLifecycle,
  type CuaDriverLifecycle,
} from '../extensions/computer/cua-driver-lifecycle.js';
import {
  assertReadOnlyProbeIdle,
  executeReadOnlyProbe,
} from './read-only-probe.js';
import {
  assertDaemonWorkspace,
  daemonHasActiveWork,
  daemonProtocolAction,
  daemonProtocolState,
  forcedRestartBlockers,
  MIMI_BUILD_VERSION,
  migrateLegacyMimiDaemon,
  mimiPaths,
  type DaemonStatusWire,
  type MimiPaths,
} from './client-runtime.js';
import {
  DAEMON_PROTOCOL_VERSION,
  type DaemonStatus,
  type EventEnvelope,
  type EventKind,
  type EventTrust,
  type MimiActivitySnapshot,
  type MimiChatSnapshot,
  type MimiHistoryChunk,
  type MimiSchedulePage,
  type ReplyRoute,
  type ScheduleRecord,
} from './types.js';

export {
  assertDaemonWorkspace,
  daemonHasActiveWork,
  daemonProtocolAction,
  daemonProtocolState,
  MIMI_BUILD_VERSION,
  mimiPaths,
} from './client-runtime.js';
export type { DaemonProtocolState, MimiPaths } from './client-runtime.js';

export class DaemonMutationGate {
  private activeCount = 0;
  private accepting = true;
  private readonly idleWaiters = new Set<() => void>();

  get active(): number {
    return this.activeCount;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.accepting) throw new Error('MimiAgent 正在关闭，不再接受新的管理事务');
    this.activeCount += 1;
    try {
      return await operation();
    } finally {
      this.activeCount -= 1;
      if (this.activeCount === 0) {
        for (const resolve of this.idleWaiters) resolve();
        this.idleWaiters.clear();
      }
    }
  }

  beginShutdown(): boolean {
    if (this.activeCount > 0) return false;
    this.accepting = false;
    return true;
  }

  async closeAndWait(): Promise<void> {
    this.accepting = false;
    if (this.activeCount === 0) return;
    await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
  }
}

export function daemonProcessIsLive(
  pid: number,
  probe: (pid: number) => void = (candidate) => process.kill(candidate, 0),
): boolean {
  try {
    probe(pid);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export function assertDaemonControlAuth(expected: string, supplied: string | undefined): void {
  const expectedDigest = createHash('sha256').update(expected).digest();
  const suppliedDigest = createHash('sha256').update(supplied ?? '').digest();
  if (!timingSafeEqual(expectedDigest, suppliedDigest)) {
    throw new Error('MimiAgent IPC 控制认证失败');
  }
}

export function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
}

function chatSessionId(params: Record<string, unknown>): string {
  if (params.sessionKey !== undefined) {
    return assertSessionId(requiredString(params.sessionKey, 'sessionKey'));
  }
  return ownerSessionId(
    typeof params.profileId === 'string' && params.profileId.trim() ? params.profileId.trim() : 'owner',
  );
}

export async function createMimiChatSnapshot(
  host: Pick<MimiHost, 'snapshot'>,
  sessionId: string,
  workspaceRoot: string,
  itemLimit = 30,
): Promise<MimiChatSnapshot> {
  const snapshot = await host.snapshot(sessionId);
  return {
    sessionId: snapshot.sessionId,
    workspaceRoot,
    provider: snapshot.runtime.provider,
    model: snapshot.runtime.model,
    mode: snapshot.runtime.mode.label,
    outputLevel: snapshot.runtime.outputLevel,
    permissionMode: snapshot.runtime.permissionMode,
    securityProfile: snapshot.runtime.securityProfile,
    contextUsed: snapshot.context.status.value,
    contextWindow: snapshot.context.contextWindow,
    contextStatus: snapshot.context.status,
    items: boundedChatItems(snapshot.items, itemLimit),
    plan: snapshot.plan.slice(0, 20).map((step) => ({
      ...step,
      id: step.id.slice(0, 100),
      description: step.description.slice(0, 1_000),
    })),
    recovery: snapshot.recovery,
  };
}

const CHAT_SNAPSHOT_MAX_BYTES = 512 * 1024;
const HISTORY_CHUNK_CHARACTERS = 256 * 1024;

function boundedChatItems(items: MimiChatSnapshot['items'], itemLimit: number): MimiChatSnapshot['items'] {
  const limit = Math.max(1, Math.min(200, Math.trunc(itemLimit)));
  const selected = items.filter((item) => (
    'role' in item && (item.role === 'user' || item.role === 'assistant')
  )).slice(-limit);
  while (selected.length > 1 && Buffer.byteLength(JSON.stringify(selected), 'utf8') > CHAT_SNAPSHOT_MAX_BYTES) {
    selected.shift();
  }
  if (Buffer.byteLength(JSON.stringify(selected), 'utf8') <= CHAT_SNAPSHOT_MAX_BYTES) return selected;
  const last = selected.at(-1);
  if (!last || !('role' in last) || (last.role !== 'user' && last.role !== 'assistant')) return [];
  return [{
    role: last.role,
    content: '[最近一条对话超过 CLI 快照上限；请使用 /history 分块读取完整权威历史。]',
  } as MimiChatSnapshot['items'][number]];
}

export async function createMimiHistoryChunk(
  host: Pick<MimiHost, 'snapshot'>,
  sessionId: string,
  offset = 0,
  expectedRevision?: string,
): Promise<MimiHistoryChunk> {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('history offset 必须是非负安全整数');
  const snapshot = await host.snapshot(sessionId);
  const source = JSON.stringify(snapshot.items);
  const revision = createHash('sha256').update(source).digest('hex');
  if (expectedRevision && expectedRevision !== revision) throw new Error('Session 历史在读取期间发生变化，请重试 /history');
  if (offset > source.length) throw new Error('history offset 超出当前 Session 历史');
  const end = Math.min(source.length, offset + HISTORY_CHUNK_CHARACTERS);
  return {
    chunk: source.slice(offset, end),
    nextOffset: end < source.length ? end : undefined,
    revision,
    totalCharacters: source.length,
  };
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value) <= maximumBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle)) <= maximumBytes) low = middle;
    else high = middle - 1;
  }
  let end = low;
  if (end > 0 && /[\uD800-\uDBFF]/.test(value[end - 1]!)) end -= 1;
  return value.slice(0, end);
}

const LAUNCH_AGENT_LABEL = 'com.mimiagent.daemon';
const DAEMON_WORKSPACE_FILE = 'workspace.json';

export type DaemonStartupMode = 'launchd' | 'detached';

export function daemonStartupMode(
  platform: NodeJS.Platform,
  launchAgentInstalled: boolean,
  persistentProviderConfigured = false,
): DaemonStartupMode {
  return platform === 'darwin' && (launchAgentInstalled || persistentProviderConfigured) ? 'launchd' : 'detached';
}

export function daemonSupervisorAction(
  status: Pick<DaemonStatus, 'activeEventId' | 'activeHostMutations' | 'activeTaskCount' | 'tasks' | 'outbox'>,
  startupMode: DaemonStartupMode,
  launchAgentInstalled: boolean,
): 'reuse' | 'migrate' {
  return startupMode === 'launchd' && !launchAgentInstalled && !daemonHasActiveWork(status)
    ? 'migrate'
    : 'reuse';
}

async function daemonSupervisorState(config: AppConfig): Promise<{
  launchAgentInstalled: boolean;
  startupMode: DaemonStartupMode;
}> {
  const launchAgentInstalled = await exists(launchAgentFile());
  const persistentProviderConfigured = process.platform === 'darwin'
    && await launchAgentProviderConfigured(config);
  return {
    launchAgentInstalled,
    startupMode: daemonStartupMode(
      process.platform,
      launchAgentInstalled,
      persistentProviderConfigured,
    ),
  };
}

export async function reconcileMimiDaemon(
  config: AppConfig,
  status: DaemonStatusWire,
): Promise<DaemonStatus> {
  const expectedPermissionMode = config.permissionMode ?? 'trusted';
  const protocolAction = daemonProtocolAction(status, expectedPermissionMode);
  const { launchAgentInstalled, startupMode } = await daemonSupervisorState(config);
  const supervisorAction = daemonSupervisorAction(status, startupMode, launchAgentInstalled);
  if (protocolAction === 'reuse' && supervisorAction === 'reuse') return status as DaemonStatus;
  return startMimiDaemon(config);
}

function launchAgentFile(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`);
}

function daemonWorkspaceFile(config: AppConfig): string {
  return path.join(mimiPaths(config).root, DAEMON_WORKSPACE_FILE);
}

function parseDaemonWorkspace(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('MimiAgent 后台工作区绑定必须是对象');
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.workspaceRoot !== 'string'
    || !path.isAbsolute(record.workspaceRoot) || record.workspaceRoot.length > 4096) {
    throw new Error('MimiAgent 后台工作区绑定无效');
  }
  return path.resolve(record.workspaceRoot);
}

async function readDaemonWorkspace(config: AppConfig): Promise<string | undefined> {
  const file = daemonWorkspaceFile(config);
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`MimiAgent 后台工作区绑定必须是普通文件：${file}`);
  }
  const workspaceRoot = parseDaemonWorkspace(JSON.parse(await readFile(file, 'utf8')) as unknown);
  await chmod(file, 0o600);
  return workspaceRoot;
}

async function rememberDaemonWorkspace(config: AppConfig): Promise<void> {
  const file = daemonWorkspaceFile(config);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(file), 0o700);
  await writeAtomicJson(file, { version: 1, workspaceRoot: path.resolve(config.workspaceRoot) });
}

export async function resolveDaemonWorkspaceConfig(config: AppConfig): Promise<AppConfig> {
  const paths = mimiPaths(config);
  let liveWorkspace: string | undefined;
  try {
    const status = await mimiRpc<DaemonStatusWire>(paths.socket, 'status', undefined, 500);
    if (typeof status.workspaceRoot === 'string' && status.workspaceRoot.trim()) {
      liveWorkspace = path.resolve(status.workspaceRoot);
    }
  } catch {
    // An offline service falls back to the last durable workspace binding.
  }
  const workspaceRoot = liveWorkspace ?? await readDaemonWorkspace(config);
  const resolved = workspaceRoot ? adoptWorkspaceConfig(config, workspaceRoot) : config;
  if (liveWorkspace) await rememberDaemonWorkspace(resolved);
  return resolved;
}

const CONNECTOR_TEMPLATE_ROOTS = [
  '/absolute/path/to/MimiAgent',
  '/absolute/path/to/MimiAgent',
] as const;
export interface MimiInitialization {
  root: string;
  connectors: {
    file: string;
    created: boolean;
    updatedActions: number;
    removedRetired: number;
    total: number;
    enabled: string[];
  };
  assistant: { file: string; created: boolean };
}

export interface MimiDoctorReport {
  ready: boolean;
  platform: NodeJS.Platform;
  node: string;
  provider: { id: AppConfig['provider']; configured: boolean };
  paths: MimiPaths;
  connectors: {
    configured: boolean;
    total: number;
    enabled: string[];
    missingScripts: string[];
    runtime?: {
      online: string[];
      offline: string[];
      inboundReady: string[];
      outboundReady: string[];
      unavailable: string[];
    };
  };
  systemBinaries: Array<{ path: string; available: boolean }>;
  daemon: {
    running: boolean;
    status?: DaemonStatus;
    health?: DaemonHealthSnapshot;
    activity?: {
      needsAttention: boolean;
      workPending: number;
      taskDeadLetters: number;
      outboxDeadLetters: number;
      resourceTrends: MimiActivitySnapshot['resourceTrends'];
      failureClassification: MimiActivitySnapshot['failureClassification'];
    };
  };
  launchAgent: { installed: boolean; file: string };
  computer: {
    configured: boolean;
    backend?: 'cua';
    ready?: boolean;
    diagnostics?: Record<string, unknown>;
  };
  storage?: DiagnosticStorageSnapshot;
  issues: string[];
  nextActions: string[];
}

interface InitializeOptions {
  platform?: NodeJS.Platform;
  runtimeRoot?: string;
}

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function plistString(value: string): string {
  return `    <string>${xml(value)}</string>`;
}

function launchctl(args: string[], ignoreFailure = false): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/launchctl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', (error) => ignoreFailure ? resolve() : reject(error));
    child.once('exit', (code) => {
      if (code === 0 || ignoreFailure) resolve();
      else reject(new Error(`launchctl ${args[0]} 失败：${stderr.trim() || `exit ${code}`}`));
    });
  });
}

interface SubmitParams {
  eventId?: string;
  text?: string;
  payload?: unknown;
  externalId?: string;
  source?: string;
  kind?: EventKind;
  trust?: EventTrust;
  priority?: number;
  profileId?: string;
  sessionKey?: string;
  workspaceRoot?: string;
  resumeState?: boolean;
  approvedPersonalMessageText?: string;
  attachments?: LocalAttachmentRequest[];
  actor?: EventEnvelope['actor'];
  conversation?: EventEnvelope['conversation'];
  replyRoute?: ReplyRoute;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('RPC 参数必须是对象');
  return value as Record<string, unknown>;
}

export function countMissingDaxiangOwnerBindings(raw: unknown): number {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 0;
  const config = raw as Record<string, unknown>;
  const expectedAccountFingerprint = config.expectedAccountFingerprint;
  if (typeof expectedAccountFingerprint !== 'string' || !expectedAccountFingerprint) return 0;
  const selfConversation = config.selfConversation;
  const watch = config.watch && typeof config.watch === 'object' && !Array.isArray(config.watch)
    ? config.watch as Record<string, unknown>
    : undefined;
  const watched = Array.isArray(watch?.conversations) ? watch.conversations : [];
  return [selfConversation, ...watched].filter((target) => {
    if (!target || typeof target !== 'object' || Array.isArray(target)) return true;
    const binding = (target as Record<string, unknown>).binding;
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return true;
    const value = binding as Record<string, unknown>;
    return value.selectedBy !== 'owner'
      || value.accountFingerprint !== expectedAccountFingerprint
      || typeof value.authorizationRevision !== 'string'
      || !/^[A-Za-z0-9._:-]{1,120}$/.test(value.authorizationRevision);
  }).length;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} 不能为空`);
  return value.trim();
}

function optionalAbsoluteDirectory(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  const selected = requiredString(value, name);
  if (!path.isAbsolute(selected)) throw new Error(`${name} 必须是绝对路径`);
  if (selected.length > 4096) throw new Error(`${name} 过长`);
  return path.resolve(selected);
}

function eventKind(value: unknown): EventKind {
  if (value === undefined) return 'command';
  if (typeof value === 'string' && ['command', 'alert', 'ambient', 'schedule', 'webhook'].includes(value)) {
    return value as EventKind;
  }
  throw new Error('kind 不是有效事件类型');
}

function eventTrust(value: unknown): EventTrust {
  if (value === undefined) return 'owner';
  if (typeof value === 'string' && ['owner', 'trusted', 'external', 'public', 'system'].includes(value)) {
    return value as EventTrust;
  }
  throw new Error('trust 不是有效信任等级');
}

function limit(value: unknown, fallback = 50): number {
  const parsed = Number(value ?? fallback);
  return Number.isSafeInteger(parsed) ? Math.max(1, Math.min(200, parsed)) : fallback;
}

function createWebhook(store: MimiStore): MimiWebhookServer | undefined {
  const rawPort = preferredEnvironmentValue('MIMI_WEBHOOK_PORT');
  if (!rawPort) return undefined;
  if (!/^\d+$/.test(rawPort)) throw new Error('MIMI_WEBHOOK_PORT 必须是整数');
  const token = preferredEnvironmentValue('MIMI_WEBHOOK_TOKEN');
  if (!token) throw new Error('启用 Webhook 时必须设置 MIMI_WEBHOOK_TOKEN');
  return new MimiWebhookServer(store, Number(rawPort), token);
}

function runtimeHttpConfiguration(): { port: number; token: string } | undefined {
  const rawPort = preferredEnvironmentValue('MIMI_RUNTIME_HTTP_PORT');
  if (!rawPort) return undefined;
  if (!/^\d+$/.test(rawPort)) throw new Error('MIMI_RUNTIME_HTTP_PORT 必须是整数');
  const port = Number(rawPort);
  if (port < 1 || port > 65_535) throw new Error('MIMI_RUNTIME_HTTP_PORT 必须在 1～65535 之间');
  const token = preferredEnvironmentValue('MIMI_RUNTIME_HTTP_TOKEN');
  if (!token) throw new Error('启用 Runtime HTTP 时必须设置 MIMI_RUNTIME_HTTP_TOKEN');
  return { port, token };
}

function runtimeRoot(): string {
  return path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function writeExclusiveJson(file: string, value: unknown): Promise<boolean> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(file), 0o700);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try {
    await link(temporary, file);
    await chmod(file, 0o600);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  } finally {
    await rm(temporary, { force: true });
  }
}

async function writeAtomicJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try {
    await chmod(temporary, 0o600);
    await rename(temporary, file);
    await chmod(file, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}

function localConnectorConfig(
  template: ConnectorFileConfig,
  root: string,
  platform: NodeJS.Platform,
): ConnectorFileConfig {
  return {
    backgroundDefaultsVersion: BACKGROUND_DEFAULTS_VERSION,
    connectors: Object.fromEntries(Object.entries(template.connectors).map(([id, connector]) => [id, {
      ...connector,
      enabled: defaultConnectorEnabled(id, platform),
      command: connector.command === 'node' ? process.execPath : connector.command,
      args: connector.args.map((argument) => CONNECTOR_TEMPLATE_ROOTS.reduce(
        (resolved, placeholder) => resolved.replaceAll(placeholder, root),
        argument,
      )),
    }])),
  };
}

function connectorScriptPath(connector: ConnectorFileConfig['connectors'][string]): string | undefined {
  for (let index = connector.args.length - 1; index >= 0; index -= 1) {
    const argument = connector.args[index];
    if (argument && path.isAbsolute(argument) && /\.(?:mjs|cjs|js)$/.test(argument)) return argument;
  }
  return undefined;
}

const RETIRED_CONNECTOR_IDS = new Set([
  'daxiang',
  'daxiang-applescript',
  'http-action',
  'macos-browser',
  'qq',
  'qq-applescript',
  'wechat-applescript',
]);

const RETIRED_CONNECTOR_SCRIPTS = new Set([
  'daxiang-applescript-connector.mjs',
  'daxiang-connector.mjs',
  'http-action-connector.mjs',
  'macos-browser-connector.mjs',
  'qq-applescript-connector.mjs',
  'qq-napcat-connector.mjs',
  'wechat-applescript-connector.mjs',
]);

const REQUIRED_CONNECTOR_ENV: Readonly<Record<string, readonly string[]>> = {
  'openclaw-weixin': ['MIMI_DAEMON_SOCKET'],
};

interface ConnectorScriptIdentity {
  canonicalPath: string;
  device?: bigint;
  inode?: bigint;
  sha256?: string;
}

async function connectorScriptIdentity(
  connector: ConnectorFileConfig['connectors'][string],
): Promise<ConnectorScriptIdentity | undefined> {
  const script = connectorScriptPath(connector);
  if (!script) return undefined;
  try {
    const canonicalPath = await realpath(script);
    const metadata = await stat(canonicalPath, { bigint: true });
    const sha256 = metadata.isFile() && metadata.size <= 2_000_000n
      ? createHash('sha256').update(await readFile(canonicalPath)).digest('hex')
      : undefined;
    return { canonicalPath, device: metadata.dev, inode: metadata.ino, sha256 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { canonicalPath: path.resolve(script) };
  }
}

async function sameConnectorScript(
  current: ConnectorFileConfig['connectors'][string],
  packaged: ConnectorFileConfig['connectors'][string],
): Promise<boolean> {
  const [currentIdentity, packagedIdentity] = await Promise.all([
    connectorScriptIdentity(current),
    connectorScriptIdentity(packaged),
  ]);
  if (!currentIdentity || !packagedIdentity) return false;
  if (currentIdentity.canonicalPath === packagedIdentity.canonicalPath) return true;
  if (currentIdentity.device !== undefined
    && packagedIdentity.device !== undefined
    && currentIdentity.device === packagedIdentity.device
    && currentIdentity.inode === packagedIdentity.inode) return true;
  return path.basename(currentIdentity.canonicalPath) === path.basename(packagedIdentity.canonicalPath)
    && currentIdentity.sha256 !== undefined
    && currentIdentity.sha256 === packagedIdentity.sha256;
}

async function mergeTemplateActions(
  current: ConnectorFileConfig,
  template: ConnectorFileConfig,
): Promise<{
  config: ConnectorFileConfig;
  updatedActions: number;
  removedRetired: number;
  changed: boolean;
}> {
  let updatedActions = 0;
  let removedRetired = 0;
  let changed = false;
  const connectors = { ...current.connectors };
  const legacyBrowser = connectors['macos-browser'];
  const browserTemplate = template.connectors.browser;
  if (legacyBrowser && browserTemplate && !connectors.browser) {
    connectors.browser = { ...browserTemplate, enabled: legacyBrowser.enabled };
    changed = true;
  }
  let backgroundDefaultsVersion = current.backgroundDefaultsVersion;
  if (backgroundDefaultsVersion < BACKGROUND_DEFAULTS_VERSION) {
    const canonical = new Set<string>();
    for (const id of LEGACY_VISIBLE_MACOS_CONNECTORS) {
      const connector = connectors[id];
      const packaged = template.connectors[id];
      if (!connector?.enabled || !packaged || !await sameConnectorScript(connector, packaged)) continue;
      canonical.add(id);
    }
    const defaults = legacyVisibleConnectorsToDisable(
      backgroundDefaultsVersion,
      Object.fromEntries(Object.entries(connectors).map(([id, connector]) => [id, connector.enabled])),
      canonical,
    );
    for (const id of defaults.disabled) {
      const connector = connectors[id]!;
      connectors[id] = { ...connector, enabled: false };
    }
    backgroundDefaultsVersion = defaults.version;
    changed ||= defaults.changed;
  }
  if (backgroundDefaultsVersion < BACKGROUND_DEFAULTS_VERSION) {
    const personal = personalMessageConnectorsToAdd(
      backgroundDefaultsVersion,
      new Set(Object.keys(connectors)),
    );
    for (const id of personal.added) {
      const packaged = template.connectors[id];
      if (packaged) connectors[id] = { ...packaged, enabled: false };
    }
    backgroundDefaultsVersion = personal.version;
    changed ||= personal.changed;
  }
  for (const [id, connector] of Object.entries(connectors)) {
    const script = connectorScriptPath(connector);
    if (!RETIRED_CONNECTOR_IDS.has(id) && (!script || !RETIRED_CONNECTOR_SCRIPTS.has(path.basename(script)))) {
      continue;
    }
    delete connectors[id];
    removedRetired += 1;
    changed = true;
  }
  for (const [id, connector] of Object.entries(template.connectors)) {
    if (!connectors[id] && connector.enabled) {
      connectors[id] = connector;
      changed = true;
    }
  }
  for (const [id, connector] of Object.entries(current.connectors)) {
    const packaged = template.connectors[id];
    if (!packaged) continue;
    if (!await sameConnectorScript(connector, packaged)) continue;
    const migrateSystemProvenance = id === 'macos-system'
      && connector.source === 'system'
      && connector.trust === 'trusted'
      && packaged.source === 'macos-system'
      && packaged.trust === 'system';
    const migrateNodeCommand = connector.command === 'node'
      && path.isAbsolute(packaged.command);
    const missing = connector.syncTemplateActions
      ? Object.entries(packaged.actions).filter(([name]) => !Object.hasOwn(connector.actions, name))
      : [];
    const metadataUpdates = connector.syncTemplateActions
      ? Object.entries(packaged.actions).filter(([name, packagedAction]) => {
        const currentAction = connector.actions[name];
        return currentAction !== undefined
          && (currentAction.description !== packagedAction.description
            || (currentAction.capability === undefined && packagedAction.capability !== undefined)
            || (currentAction.effect === 'unknown' && packagedAction.effect !== 'unknown')
            || currentAction.modelVisible !== packagedAction.modelVisible
            || currentAction.targetExample !== packagedAction.targetExample
            || currentAction.payloadExampleJson !== packagedAction.payloadExampleJson);
      })
      : [];
    const missingEnv = (REQUIRED_CONNECTOR_ENV[id] ?? []).filter((name) => (
      packaged.envAllowlist.includes(name) && !connector.envAllowlist.includes(name)
    ));
    const missingClaimedComputerApps = packaged.claimedComputerApps.filter(
      (bundleId) => !connector.claimedComputerApps.includes(bundleId),
    );
    if (
      !migrateSystemProvenance
      && !migrateNodeCommand
      && !missing.length
      && !metadataUpdates.length
      && !missingEnv.length
      && !missingClaimedComputerApps.length
    ) continue;
    updatedActions += missing.length + metadataUpdates.length;
    changed = true;
    const updatedMetadata = Object.fromEntries(metadataUpdates.map(([name, packagedAction]) => {
      const currentAction = connector.actions[name]!;
      return [name, {
        ...currentAction,
        description: packagedAction.description,
        ...(currentAction.capability === undefined && packagedAction.capability !== undefined
          ? { capability: packagedAction.capability }
          : {}),
        ...(currentAction.effect === 'unknown' && packagedAction.effect !== 'unknown'
          ? { effect: packagedAction.effect }
          : {}),
        ...(currentAction.modelVisible !== packagedAction.modelVisible
          ? { modelVisible: packagedAction.modelVisible }
          : {}),
        ...(currentAction.targetExample !== packagedAction.targetExample
          ? { targetExample: packagedAction.targetExample }
          : {}),
        ...(currentAction.payloadExampleJson !== packagedAction.payloadExampleJson
          ? { payloadExampleJson: packagedAction.payloadExampleJson }
          : {}),
      }];
    }));
    connectors[id] = {
      ...connector,
      ...(migrateNodeCommand ? { command: packaged.command } : {}),
      ...(migrateSystemProvenance ? { source: packaged.source, trust: packaged.trust } : {}),
      envAllowlist: [...connector.envAllowlist, ...missingEnv],
      claimedComputerApps: [...connector.claimedComputerApps, ...missingClaimedComputerApps],
      actions: { ...Object.fromEntries(missing), ...connector.actions, ...updatedMetadata },
    };
  }
  return {
    config: { backgroundDefaultsVersion, connectors },
    updatedActions,
    removedRetired,
    changed,
  };
}

export async function initializeMimi(
  config: AppConfig,
  options: InitializeOptions = {},
): Promise<MimiInitialization> {
  const paths = mimiPaths(config);
  const root = path.resolve(options.runtimeRoot ?? runtimeRoot());
  const platform = options.platform ?? process.platform;
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  await chmod(paths.root, 0o700);
  await ensureControlToken(paths.socket);

  const templateFile = path.join(root, 'mimi.connectors.example.json');
  const template = parseConnectorConfig(JSON.parse(await readFile(templateFile, 'utf8')) as unknown);
  const localTemplate = localConnectorConfig(template, root, platform);
  let connectorCreated = false;
  if (!await exists(paths.connectorsConfig)) {
    connectorCreated = await writeExclusiveJson(
      paths.connectorsConfig,
      localTemplate,
    );
  }
  let connectorConfig = parseConnectorConfig(JSON.parse(await readFile(paths.connectorsConfig, 'utf8')) as unknown);
  let updatedActions = 0;
  let removedRetired = 0;
  if (!connectorCreated) {
    const merged = await mergeTemplateActions(connectorConfig, localTemplate);
    connectorConfig = merged.config;
    updatedActions = merged.updatedActions;
    removedRetired = merged.removedRetired;
    if (merged.changed) await writeAtomicJson(paths.connectorsConfig, connectorConfig);
  }
  await chmod(paths.connectorsConfig, 0o600);

  const assistantExisted = await exists(paths.assistantConfig);
  const store = new MimiStore(paths.database);
  try {
    await AttentionEngine.load(paths.assistantConfig, store);
  } finally {
    store.close();
  }
  return {
    root: paths.root,
    connectors: {
      file: paths.connectorsConfig,
      created: connectorCreated,
      updatedActions,
      removedRetired,
      total: Object.keys(connectorConfig.connectors).length,
      enabled: Object.entries(connectorConfig.connectors)
        .filter(([, connector]) => connector.enabled)
        .map(([id]) => id),
    },
    assistant: { file: paths.assistantConfig, created: !assistantExisted },
  };
}

function providerConfigured(config: AppConfig): boolean {
  return config.provider === 'deepseek'
    ? Boolean(process.env.DEEPSEEK_API_KEY)
    : config.provider === 'openai-compatible'
      ? Boolean(process.env.MIMI_PROVIDER_API_KEY)
      : Boolean(process.env.OPENAI_API_KEY);
}

function providerKeyName(
  config: AppConfig,
): 'OPENAI_API_KEY' | 'DEEPSEEK_API_KEY' | 'MIMI_PROVIDER_API_KEY' {
  return config.provider === 'deepseek'
    ? 'DEEPSEEK_API_KEY'
    : config.provider === 'openai-compatible'
      ? 'MIMI_PROVIDER_API_KEY'
      : 'OPENAI_API_KEY';
}

export async function launchAgentProviderConfigured(
  config: AppConfig,
  environmentFile = resolveEnvironmentFile(),
): Promise<boolean> {
  let contents: string;
  try {
    contents = await readFile(environmentFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  return Boolean(parseDotenv(contents)[providerKeyName(config)]?.trim());
}

export async function persistLaunchAgentProviderApiKey(
  config: AppConfig,
  environmentFile = resolveEnvironmentFile(),
): Promise<void> {
  if (await launchAgentProviderConfigured(config, environmentFile)) return;
  const keyName = providerKeyName(config);
  const value = process.env[keyName]?.trim();
  if (!value) return;
  await persistEnvironmentValues(environmentFile, { [keyName]: value });
}

export async function doctorMimi(config: AppConfig): Promise<MimiDoctorReport> {
  const paths = mimiPaths(config);
  const platform = process.platform;
  const issues: string[] = [];
  try {
    providerBackupRouteFromEnvironment(config.provider);
  } catch (error) {
    issues.push(`Provider 主备配置无效：${error instanceof Error ? error.message : String(error)}`);
  }
  let connectorConfig: ConnectorFileConfig | undefined;
  if (await exists(paths.connectorsConfig)) {
    try {
      connectorConfig = parseConnectorConfig(JSON.parse(await readFile(paths.connectorsConfig, 'utf8')) as unknown);
    } catch (error) {
      issues.push(`Connector 配置无效：${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    issues.push('尚未初始化 connectors.json');
  }
  const enabled = connectorConfig
    ? Object.entries(connectorConfig.connectors).filter(([, connector]) => connector.enabled).map(([id]) => id)
    : [];
  if (connectorConfig && enabled.length === 0) issues.push('没有启用任何 Connector');
  const daxiangEnabled = enabled.includes('personal-daxiang');
  const daxiangConnector = connectorConfig?.connectors['personal-daxiang'];
  const daxiangScript = daxiangConnector ? connectorScriptPath(daxiangConnector) : undefined;
  const packagedDaxiangScript = path.join(
    runtimeRoot(),
    'examples',
    'connectors',
    'personal-message-connector.mjs',
  );
  const daxiangManagedScriptDrift = daxiangEnabled
    && daxiangConnector?.syncTemplateActions !== false
    && daxiangScript !== undefined
    && path.basename(daxiangScript) === path.basename(packagedDaxiangScript)
    && path.resolve(daxiangScript) !== path.resolve(packagedDaxiangScript);
  const daxiangConfigFile = process.env.DAXIANG_WEB_CONFIG
    ? path.resolve(process.env.DAXIANG_WEB_CONFIG)
    : path.join(paths.root, 'personal-daxiang.json');
  let daxiangConfigMissing = false;
  let daxiangFingerprintsMissing = false;
  let daxiangBindingsMissing = 0;
  if (daxiangEnabled) {
    if (platform !== 'darwin') issues.push('personal-daxiang 只支持 macOS Google Chrome');
    if (daxiangManagedScriptDrift) {
      issues.push(`personal-daxiang 仍指向其他 checkout 的托管脚本：${daxiangScript}`);
    }
    if (!await exists(daxiangConfigFile)) {
      daxiangConfigMissing = true;
      issues.push(`personal-daxiang 业务配置不存在：${daxiangConfigFile}`);
    } else {
      try {
        const daxiangConfig = JSON.parse(await readFile(daxiangConfigFile, 'utf8')) as Record<string, unknown>;
        daxiangFingerprintsMissing = typeof daxiangConfig.expectedAccountFingerprint !== 'string'
          || !daxiangConfig.expectedAccountFingerprint
          || !Array.isArray(daxiangConfig.allowedPageFingerprints)
          || daxiangConfig.allowedPageFingerprints.length === 0;
        if (daxiangFingerprintsMissing) {
          issues.push('personal-daxiang 尚未锁定账号指纹和页面指纹，只能执行 health_check probe');
        } else {
          daxiangBindingsMissing = countMissingDaxiangOwnerBindings(daxiangConfig);
          if (daxiangBindingsMissing > 0) {
            issues.push(`personal-daxiang 有 ${daxiangBindingsMissing} 个 allowlist 目标缺少当前账号的 owner binding`);
          }
        }
      } catch (error) {
        issues.push(`personal-daxiang 业务配置无效：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  const scriptPaths = connectorConfig
    ? [...new Set(Object.values(connectorConfig.connectors)
      .flatMap((connector) => connector.args)
      .filter((argument) => path.isAbsolute(argument) && /\.(?:mjs|cjs|js)$/.test(argument)))]
    : [];
  const missingScripts: string[] = [];
  for (const script of scriptPaths) if (!await exists(script)) missingScripts.push(script);
  if (missingScripts.length) issues.push(`${missingScripts.length} 个 Connector 脚本不存在`);
  const binaries = platform === 'darwin'
    ? ['/usr/bin/pmset', '/usr/bin/osascript', '/usr/bin/open', '/usr/bin/shortcuts', '/usr/sbin/screencapture', '/usr/bin/swift', '/usr/bin/say']
    : [];
  const systemBinaries = await Promise.all(binaries.map(async (binary) => ({
    path: binary,
    available: await exists(binary),
  })));
  const missingBinaries = systemBinaries.filter((binary) => !binary.available);
  if (missingBinaries.length) issues.push(`缺少系统命令：${missingBinaries.map((item) => item.path).join(', ')}`);
  const configured = providerConfigured(config);
  if (!configured) issues.push(`${config.provider} API Key 未配置`);
  const installedLaunchAgentFile = launchAgentFile();
  const launchAgentInstalled = await exists(installedLaunchAgentFile);
  const persistentProviderKey = await launchAgentProviderConfigured(config);
  if (launchAgentInstalled && !persistentProviderKey) {
    issues.push(`launchd 持久环境文件缺少 ${providerKeyName(config)}`);
  }
  let computerDiagnostics: Record<string, unknown> | undefined;
  let computerReady = false;
  if (config.computer) {
    try {
      const { CuaDriverClient } = await import('../extensions/computer/cua-driver-client.js');
      const client = new CuaDriverClient(config.computer.driverCommand, config.computer.actionTimeoutMs);
      computerDiagnostics = await client.diagnostics();
      const permissions = object(computerDiagnostics.permissions);
      computerReady = permissions.accessibility === true && permissions.screen_recording === true;
      if (!computerReady) issues.push('Computer Use 缺少 CuaDriver Accessibility 或 Screen Recording 权限');
    } catch (error) {
      issues.push(`Computer Use 不可用：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let daemonStatus: DaemonStatus | undefined;
  let runtimeConnectors: ConnectorCapability[] | undefined;
  let activity: MimiActivitySnapshot | undefined;
  try {
    daemonStatus = await mimiRpc<DaemonStatus>(paths.socket, 'status', undefined, 300);
  } catch {
    // Offline is a state, not a Doctor failure.
  }
  if (daemonStatus) {
    const [connectorResult, activityResult] = await Promise.allSettled([
      mimiRpc<ConnectorCapability[]>(paths.socket, 'connectors.list', {}, 1_000),
      mimiRpc<MimiActivitySnapshot>(paths.socket, 'activity.get', { limit: 1 }, 1_000),
    ]);
    if (connectorResult.status === 'fulfilled') runtimeConnectors = connectorResult.value;
    else issues.push(`无法读取 Connector 在线状态：${connectorResult.reason instanceof Error ? connectorResult.reason.message : String(connectorResult.reason)}`);
    if (activityResult.status === 'fulfilled') activity = activityResult.value;
    else issues.push(`无法读取 MimiAgent 活动状态：${activityResult.reason instanceof Error ? activityResult.reason.message : String(activityResult.reason)}`);
  } else if (configured && connectorConfig) {
    issues.push('MimiAgent 后台服务未运行');
  }
  const offlineConnectors = runtimeConnectors?.filter((connector) => connector.enabled && !connector.online) ?? [];
  const unavailableConnectors = runtimeConnectors?.filter((connector) => (
    connector.enabled && connector.online
    && connector.readiness.inbound === 'unavailable'
    && connector.readiness.outbound === 'unavailable'
  )) ?? [];
  const taskDeadLetters = activity?.tasks.dead_letter ?? 0;
  const outboxDeadLetters = activity?.outbox.dead_letter ?? 0;
  const health = daemonStatus
    ? daemonStatus.health ?? buildDaemonHealth({
        tasks: activity?.tasks ?? daemonStatus.tasks,
        outbox: activity?.outbox ?? daemonStatus.outbox,
        pendingDigest: activity?.pendingDigest,
        connectors: runtimeConnectors,
        checkedAt: activity?.generatedAt,
        taskWorkerRuntime: daemonStatus.taskWorkerRuntime,
      })
    : undefined;
  if (health) {
    issues.push(...doctorBlockingHealthRisks(
      health,
      activity?.failureClassification?.unclassifiedDeadLetters ?? taskDeadLetters,
    ).map((risk) => risk.message));
  }
  let storage: DiagnosticStorageSnapshot | undefined;
  try {
    storage = await inspectDiagnosticStorage(config);
    if (storage.capacity.database !== 'ok') {
      issues.push(`SQLite 容量达到 ${storage.capacity.database} 阈值`);
    }
    if (storage.capacity.logs !== 'ok') {
      issues.push(`Daemon 日志容量达到 ${storage.capacity.logs} 阈值`);
    }
    if (storage.capacity.memory !== 'ok') {
      issues.push(`Memory 容量达到 ${storage.capacity.memory} 阈值`);
    }
  } catch (error) {
    issues.push(`无法读取本地容量指标：${error instanceof Error ? error.message : String(error)}`);
  }
  const nextActions: string[] = [];
  if (!connectorConfig) nextActions.push('运行 mimi 完成自动初始化');
  if (!configured) nextActions.push(`在 ~/.mimi-agent/.env（或旧目录）配置 ${providerKeyName(config)}`);
  if (launchAgentInstalled && !persistentProviderKey && configured) {
    nextActions.push(`把 ${providerKeyName(config)} 写入 ${resolveEnvironmentFile()} 后重新运行 mimi`);
  }
  if (missingScripts.length) nextActions.push('重新运行 npm install 或修复 Connector 脚本路径');
  if (missingBinaries.length) nextActions.push('安装或恢复缺失的 macOS 系统命令');
  if (daxiangConfigMissing) {
    nextActions.push(`复制 daxiang-web.example.json 到 ${daxiangConfigFile}，准备已登录且非活动的大象专用标签`);
  } else if (daxiangFingerprintsMissing) {
    nextActions.push('对 personal-daxiang 执行 health_check probe，核对摘要后写回账号和页面指纹并 reload');
  } else if (daxiangBindingsMissing > 0) {
    nextActions.push(`为 personal-daxiang 的 ${daxiangBindingsMissing} 个 allowlist 目标补齐当前账号 owner binding 并 reload`);
  }
  if (daxiangManagedScriptDrift) {
    nextActions.push(`把 personal-daxiang 脚本路径更新为当前构建 ${packagedDaxiangScript} 并 reload`);
  }
  if (!daemonStatus && configured && connectorConfig) nextActions.push('运行 mimi，后台服务会自动启动');
  if (health) {
    for (const action of health.risks.map((risk) => risk.nextAction)) {
      if (!nextActions.includes(action)) nextActions.push(action);
    }
  }
  if (storage?.capacity.database !== undefined && storage.capacity.database !== 'ok') {
    nextActions.push('运行 mimi daemon activity 检查保留策略和积压，再安排数据库备份与维护');
  }
  if (storage?.capacity.logs !== undefined && storage.capacity.logs !== 'ok') {
    nextActions.push('安全重启 MimiAgent 以轮转超限日志，并检查重复错误');
  }
  if (storage?.capacity.memory !== undefined && storage.capacity.memory !== 'ok') {
    nextActions.push('检查 MemoryHub 页面、索引和备份增长');
  }
  return {
    ready: issues.length === 0,
    platform,
    node: process.version,
    provider: { id: config.provider, configured },
    paths,
    connectors: {
      configured: Boolean(connectorConfig),
      total: connectorConfig ? Object.keys(connectorConfig.connectors).length : 0,
      enabled,
      missingScripts,
      ...(runtimeConnectors ? {
        runtime: {
          online: runtimeConnectors.filter((connector) => connector.enabled && connector.online).map((connector) => connector.id),
          offline: offlineConnectors.map((connector) => connector.id),
          inboundReady: runtimeConnectors.filter((connector) => connector.enabled && connector.online && connector.readiness.inbound === 'ready').map((connector) => connector.id),
          outboundReady: runtimeConnectors.filter((connector) => connector.enabled && connector.online && connector.readiness.outbound === 'ready').map((connector) => connector.id),
          unavailable: unavailableConnectors.map((connector) => connector.id),
        },
      } : {}),
    },
    systemBinaries,
    daemon: {
      running: Boolean(daemonStatus),
      ...(daemonStatus ? { status: daemonStatus } : {}),
      ...(health ? { health } : {}),
      ...(activity ? {
        activity: {
          needsAttention: activity.needsAttention,
          workPending: activity.workPending,
          taskDeadLetters,
          outboxDeadLetters,
          resourceTrends: activity.resourceTrends ?? [],
          failureClassification: {
            ...(activity.failureClassification ?? {
              deadLetters: [],
              digest: [],
              unclassifiedDeadLetters: taskDeadLetters,
            }),
            readinessUnknown: classifyReadinessUnknown(
              runtimeConnectors ?? [],
              daemonStatus?.startedAt ?? new Date().toISOString(),
            ),
          },
        },
      } : {}),
    },
    launchAgent: { installed: launchAgentInstalled, file: installedLaunchAgentFile },
    computer: {
      configured: Boolean(config.computer),
      ...(config.computer ? { backend: config.computer.backend, ready: computerReady } : {}),
      ...(computerDiagnostics ? { diagnostics: computerDiagnostics } : {}),
    },
    ...(storage ? { storage } : {}),
    issues,
    nextActions,
  };
}

export function daemonLaunchEnvironment(config: AppConfig): Record<string, string> {
  const paths = mimiPaths(config);
  const session = preferredEnvironmentValue('MIMI_SESSION', 'AGENT_SESSION') ?? 'mimi-system';
  const environment: Record<string, string> = {
    MIMI_MODEL_PROVIDER: config.provider,
    MIMI_CONFIG_VERSION: '4',
    MIMI_WORKSPACE: config.workspaceRoot,
    AGENT_WORKSPACE: config.workspaceRoot,
    MIMI_DATA_DIR: config.dataRoot,
    MIMI_DAEMON_DATA_DIR: paths.root,
    MIMI_DAEMON_SOCKET: paths.socket,
    MIMI_SKILLS_DIR: config.skillsRoot,
    MIMI_MCP_CONFIG: config.mcpConfig,
    MIMI_HISTORY_LIMIT: String(config.historyLimit),
    MIMI_TEAM_MAX_CONCURRENCY: String(config.teamMaxConcurrency ?? 4),
    MIMI_PERMISSION_MODE: config.permissionMode ?? 'trusted',
    MIMI_SECURITY_PROFILE: securityProfileSummary(config).id,
    MIMI_SESSION: session,
    AGENT_SESSION: session,
    MIMI_CONNECTORS_CONFIG: paths.connectorsConfig,
    MIMI_ASSISTANT_CONFIG: paths.assistantConfig,
  };
  if (config.maxTurns !== null) environment.MIMI_MAX_TURNS = String(config.maxTurns);
  if (config.contextWindow !== undefined) environment.MIMI_CONTEXT_WINDOW = String(config.contextWindow);
  if (config.outputReserve !== undefined) environment.MIMI_OUTPUT_TOKEN_RESERVE = String(config.outputReserve);
  if (config.provider === 'openai-compatible') {
    if (config.providerBaseUrl !== undefined) environment.MIMI_PROVIDER_BASE_URL = config.providerBaseUrl;
    if (config.defaultModel !== undefined) environment.MIMI_MODEL = config.defaultModel;
    if (config.availableModels?.length) environment.MIMI_MODELS = config.availableModels.join(',');
  } else if (config.provider === 'deepseek') {
    if (config.providerBaseUrl !== undefined) environment.DEEPSEEK_BASE_URL = config.providerBaseUrl;
    if (config.defaultModel !== undefined) environment.DEEPSEEK_MODEL = config.defaultModel;
    if (config.availableModels?.length) environment.DEEPSEEK_MODELS = config.availableModels.join(',');
  } else {
    if (config.defaultModel !== undefined) environment.OPENAI_MODEL = config.defaultModel;
    if (config.availableModels?.length) environment.OPENAI_MODELS = config.availableModels.join(',');
  }
  if (config.computer) {
    environment.MIMI_COMPUTER_BACKEND = config.computer.backend;
    environment.MIMI_CUA_DRIVER_COMMAND = config.computer.driverCommand;
    environment.MIMI_COMPUTER_ACTION_TIMEOUT_MS = String(config.computer.actionTimeoutMs);
    environment.MIMI_COMPUTER_MAX_ACTIONS_PER_RUN = String(config.computer.maxActionsPerRun);
    environment.MIMI_COMPUTER_MAX_SCREENSHOTS_PER_RUN = String(config.computer.maxScreenshotsPerRun);
    environment.MIMI_COMPUTER_PAUSE_WHEN_TARGET_FRONTMOST = String(config.computer.pauseWhenTargetFrontmost);
    environment.MIMI_COMPUTER_DEFAULT_ACCESS = config.computer.defaultAccess;
    environment.MIMI_COMPUTER_FOREGROUND_LEASE_SECONDS = String(config.computer.foregroundLeaseSeconds);
    environment.MIMI_COMPUTER_ARTIFACT_MAX_MIB = String(Math.floor(config.computer.artifactMaxBytes / 1024 / 1024));
  }
  if (config.trustedWorkspaceMcp !== undefined) {
    environment.MIMI_TRUST_WORKSPACE_MCP = config.trustedWorkspaceMcp;
  }
  const environmentFile = resolveEnvironmentFile();
  environment.MIMI_ENV_FILE = environmentFile;
  environment.DOTENV_CONFIG_PATH = environmentFile;
  return environment;
}

export function launchAgentPlist(config: AppConfig, entry = process.argv[1], execArgs = process.execArgv): string {
  if (!entry) throw new Error('无法确定 MimiAgent 启动入口');
  const paths = mimiPaths(config);
  const argumentsXml = [process.execPath, ...execArgs, entry, 'daemon', 'run'].map(plistString).join('\n');
  const environment = daemonLaunchEnvironment(config);
  environment.MIMI_DAEMON_SUPERVISOR = 'launchd';
  const environmentXml = Object.entries(environment)
    .map(([key, value]) => `      <key>${xml(key)}</key>\n      <string>${xml(value)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argumentsXml}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(config.workspaceRoot)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${environmentXml}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(paths.stdoutLog)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(paths.stderrLog)}</string>
</dict>
</plist>
`;
}

export async function installMimiLaunchAgent(config: AppConfig): Promise<string> {
  if (process.platform !== 'darwin') throw new Error('自动登录启动当前仅支持 macOS launchd');
  config = await resolveDaemonWorkspaceConfig(config);
  await initializeMimi(config);
  requireProviderApiKey(config);
  await persistLaunchAgentProviderApiKey(config);
  const paths = mimiPaths(config);
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  await chmod(paths.root, 0o700);
  const directory = path.join(os.homedir(), 'Library', 'LaunchAgents');
  const file = launchAgentFile();
  const temporary = `${file}.${process.pid}.tmp`;
  await mkdir(directory, { recursive: true });
  await writeFile(temporary, launchAgentPlist(config), { mode: 0o600 });
  await rename(temporary, file);
  await chmod(file, 0o600);
  const domain = `gui/${process.getuid?.() ?? 0}`;
  await launchctl(['bootout', domain, file], true);
  await rotateDaemonLogs(paths);
  await launchctl(['bootstrap', domain, file]);
  return file;
}

export async function uninstallMimiLaunchAgent(): Promise<string> {
  if (process.platform !== 'darwin') throw new Error('自动登录启动当前仅支持 macOS launchd');
  const file = launchAgentFile();
  await launchctl(['bootout', `gui/${process.getuid?.() ?? 0}`, file], true);
  await rm(file, { force: true });
  return file;
}

export async function runMimiDaemon(config: AppConfig): Promise<void> {
  await initializeMimi(config);
  requireProviderApiKey(config);
  configureAgentRuntime(config);
  const paths = mimiPaths(config);
  const controlToken = await readControlToken(paths.socket);
  if (!controlToken) throw new Error('MimiAgent IPC 控制令牌缺失');
  const store = new MimiStore(paths.database);
  const workerId = `${process.pid}-${randomUUID().slice(0, 8)}`;
  const lifecycle = new DaemonLifecycleStore(paths.lifecycle);
  let lifecycleEpoch: DaemonLifecycleEpoch = await lifecycle.begin({
    buildVersion: MIMI_BUILD_VERSION,
    pid: process.pid,
    workerId,
    workspaceRoot: config.workspaceRoot,
    supervisor: process.env.MIMI_DAEMON_SUPERVISOR === 'launchd'
      ? 'launchd'
      : process.env.MIMI_DAEMON_SUPERVISOR === 'detached'
        ? 'detached'
        : 'foreground',
  });
  let host: MimiHost | undefined;
  let connectors: ConnectorManager | undefined;
  let webhook: MimiWebhookServer | undefined;
  let runtimeHttp: MimiRuntimeHttpServer | undefined;
  let dispatcher: MimiDispatcher | undefined;
  let taskSupervisor: TaskProcessSupervisor | undefined;
  let server: MimiIpcServer | undefined;
  let attention: AttentionEngine | undefined;
  let computerLifecycle: CuaDriverLifecycle | undefined;
  const stopping = new AbortController();
  const mutationGate = new DaemonMutationGate();
  const ephemeralSecrets = new EphemeralSecretBroker();
  let stopRequest: {
    reason: DaemonLifecycleStopReason;
    signal?: DaemonLifecycleEpoch['signal'];
    exitCode: number;
  } | undefined;
  const stop = async (
    reason: DaemonLifecycleStopReason,
    signal?: DaemonLifecycleEpoch['signal'],
    exitCode = 0,
  ) => {
    if (stopRequest) return;
    stopRequest = { reason, ...(signal ? { signal } : {}), exitCode };
    lifecycleEpoch = await lifecycle.transition(lifecycleEpoch.epochId, 'stopping', {
      reason,
      ...(signal ? { signal } : {}),
    });
    if (!stopping.signal.aborted) stopping.abort();
  };
  const onSignal = (signal: 'SIGINT' | 'SIGTERM') => {
    process.exitCode = 1;
    void mutationGate.closeAndWait().then(() => stop('signal', signal, 1));
  };
  let signalsRegistered = false;
  let runtimeFailure: unknown;
  try {
    const runtimeConfig = (workspaceRoot?: string): AppConfig => workspaceRoot
      ? adoptRuntimeWorkspaceConfig(config, workspaceRoot)
      : config;
    const backupProvider = providerBackupRouteFromEnvironment(config.provider);
    const runService = (runtime: MimiAgent) => new AgentRunService(runtime, {
      providerId: config.provider,
      providerIdForRun: (request) => runtime.providerReliabilityKey(
        request.modelInput ?? request.input,
        request.options,
      ),
      ...(backupProvider ? { backupProvider } : {}),
    });
    if (config.computer) {
      computerLifecycle = sharedCuaDriverLifecycle(
        config.computer.driverCommand,
        config.computer.actionTimeoutMs,
      );
      await computerLifecycle.start();
    }
    const agent = await MimiAgent.create(config);
    host = new MimiHost(agent, runService(agent), {
      maxConcurrentSessions: config.sessionMaxConcurrency ?? 4,
      primaryWorkspaceRoot: config.workspaceRoot,
      createSessionRuntime: async (sessionId, workspaceRoot) => {
        const sessionAgent = await MimiAgent.create(runtimeConfig(workspaceRoot), sessionId);
        return { agent: sessionAgent, runs: runService(sessionAgent) };
      },
    });
    const notifier = new NotifierRegistry();
    connectors = await ConnectorManager.load(paths.connectorsConfig, store, notifier);
    attention = await AttentionEngine.load(paths.assistantConfig, store);
    store.setIngressRoutePolicy((event, at) => attention!.routeIngress(event, at));
    webhook = createWebhook(store);
    const liveEvents = new MimiLiveEvents();
    taskSupervisor = new TaskProcessSupervisor(store, config, {
      database: paths.database,
      assistantConfig: paths.assistantConfig,
      socket: paths.socket,
    }, {
      maxWorkers: config.sessionMaxConcurrency ?? 4,
      redactEnvironmentKeys: () => connectors?.environmentKeys ?? [],
      onStreamEvent: (eventId, event) => liveEvents.publish(eventId, event),
    });
    const activeTaskSupervisor = taskSupervisor;
    const ingestOwnerPrompt = (event: EventEnvelope, prompt: string) => {
      if (!event.sessionKey) throw new Error('认证 Owner 命令缺少 Session，无法绑定临时敏感输入');
      const captured = ephemeralSecrets.capture({
        eventId: event.id,
        sessionId: event.sessionKey,
        profileId: event.profileId,
        source: event.source,
        trust: event.trust,
      }, prompt);
      const payload = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
        ? event.payload as Record<string, unknown>
        : {};
      try {
        const accepted = store.ingestEvent({
          ...event,
          payload: {
            ...payload,
            prompt: captured.sanitized,
            ...(captured.references.length ? { transientInputRefs: captured.references } : {}),
          },
        });
        if (!accepted.inserted || !accepted.task) ephemeralSecrets.discard(event.id);
        return accepted;
      } catch (error) {
        ephemeralSecrets.discard(event.id);
        throw error;
      }
    };
    dispatcher = new MimiDispatcher(store, host, attention, notifier, connectors, {
      workerId,
      maxConcurrentTasks: config.sessionMaxConcurrency ?? 4,
      claimTaskTypes: ['conversation'],
      onStreamEvent: (eventId, event) => {
        const streamed = mimiStreamEvent(event);
        if (streamed) liveEvents.publish(eventId, streamed);
      },
      onRuntimeEvent: (eventId, event) => {
        const streamed = mimiRuntimeStreamEvent(event);
        if (streamed) liveEvents.publish(eventId, streamed);
      },
      cancelEvent: (eventId, reason) => {
        const task = store.getTask(eventId);
        return task?.executor === 'isolated_worker' || task?.executor === 'codex'
          ? activeTaskSupervisor.cancel(eventId, reason)
          : dispatcher!.cancel(eventId, reason);
      },
      pauseEvent: (eventId, reason) => {
        const task = store.getTask(eventId);
        return task?.executor === 'isolated_worker' || task?.executor === 'codex'
          ? activeTaskSupervisor.pause(eventId, reason)
          : { state: 'not_pauseable' };
      },
      takeEphemeralSecrets: (eventId, sessionId, references) =>
        ephemeralSecrets.take(eventId, sessionId, references),
      resolveWorkspace: async (event, sessionId) => {
        const current = host!.workspaceRootFor(sessionId);
        if (event.trust !== 'owner') return current ?? config.workspaceRoot;
        const payload = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
          ? event.payload as Record<string, unknown>
          : {};
        const requestedWorkspaceRoot = optionalAbsoluteDirectory(
          payload.workspaceRoot,
          'event.payload.workspaceRoot',
        );
        const resolved = await resolveTaskWorkspace({
          requestedWorkspaceRoot,
          sessionWorkspaceRoot: current,
          defaultWorkspaceRoot: config.workspaceRoot,
        });
        return resolved.workspaceRoot;
      },
    });
    const activeConnectors = connectors;
    const activeDispatcher = dispatcher;
    const activeWebhook = webhook;
    const activeAttention = attention;
    const activeStatus = () => {
      const taskWorkers = activeTaskSupervisor.status();
      const taskWorkerRuntime = activeTaskSupervisor.runtimeStatus();
      const status = {
        ...activeDispatcher.status(),
        activeTaskCount: taskWorkers.length,
        taskWorkers,
        taskWorkerRuntime,
        activeHostMutations: mutationGate.active,
      };
      const activity = store.activitySnapshot(1);
      const effectiveCapability = host?.currentCapabilitySnapshot();
      const providerHealth = host?.providerHealth();
      const providerHealthRoutes = host?.providerHealthRoutes();
      const transportComputer = computerLifecycle?.status();
      const operationalComputer = host?.computerStatus();
      const computer = transportComputer ? {
        ...transportComputer,
        transportReady: transportComputer.ready,
        ready: transportComputer.ready && operationalComputer?.operationalReadiness === 'ready',
        operationalReadiness: operationalComputer?.operationalReadiness ?? 'unknown',
        ...(operationalComputer?.operationalCheckedAt
          ? { operationalCheckedAt: operationalComputer.operationalCheckedAt }
          : {}),
        ...(operationalComputer?.lastOperationalFailure
          ? { lastOperationalFailure: operationalComputer.lastOperationalFailure }
          : {}),
      } : undefined;
      return {
        ...status,
        lifecycle: lifecycleEpoch,
        ...(providerHealth ? { providerHealth } : {}),
        ...(providerHealthRoutes?.length ? { providerHealthRoutes } : {}),
        ...(effectiveCapability ? {
          effectiveCapability: {
            schemaVersion: effectiveCapability.schemaVersion,
            snapshotDigest: effectiveCapability.snapshotDigest,
            observedAt: effectiveCapability.observedAt,
          },
        } : {}),
        ...(computer ? { computer } : {}),
        health: buildDaemonHealth({
          tasks: status.tasks,
          outbox: status.outbox,
          pendingDigest: activity.pendingDigest,
          connectors: activeConnectors.listCapabilities(),
          checkedAt: activity.generatedAt,
          taskWorkerRuntime,
          computer,
        }),
      };
    };
    const taskSummaryWithRuntime = (task: ReturnType<MimiStore['getTask']>) => {
      if (!task) throw new Error('后台任务不存在');
      const summary = backgroundTaskSummary(task);
      const worker = activeTaskSupervisor.status().find((candidate) => candidate.taskId === task.id);
      return {
        ...summary,
        ...(worker ? { worker } : {}),
      };
    };
    const taskDetailsWithRuntime = async (task: ReturnType<MimiStore['getTask']>) => {
      if (!task) throw new Error('后台任务不存在');
      const summary = task.executor === 'codex'
        ? { ...await inspectBackgroundTaskSummary(task), worker: taskSummaryWithRuntime(task).worker }
        : taskSummaryWithRuntime(task);
      const recentEvents = liveEvents.recent(task.id, 8);
      const snapshot = task.executor !== 'codex' && task.sessionKey
        ? await host!.snapshot(task.sessionKey).catch(() => undefined)
        : undefined;
      return {
        ...summary,
        ...(recentEvents.length ? { recentEvents } : {}),
        ...(snapshot?.plan.length ? { plan: snapshot.plan } : {}),
        ...(snapshot?.recovery ? { checkpoint: snapshot.recovery } : {}),
      };
    };
    const runtimeHttpConfig = runtimeHttpConfiguration();
    if (runtimeHttpConfig) {
      runtimeHttp = new MimiRuntimeHttpServer(runtimeHttpConfig.port, runtimeHttpConfig.token, {
        createSession: runtimeHttpSessionId,
        submit: async (sessionId, input, idempotencyKey) => {
          const now = new Date().toISOString();
          const eventId = randomUUID();
          const accepted = ingestOwnerPrompt({
            id: eventId,
            externalId: idempotencyKey
              ? `runtime-http:${sessionId}:${idempotencyKey}`
              : `runtime-http:${eventId}`,
            source: 'runtime-http',
            kind: 'command',
            trust: 'owner',
            payload: { workspaceRoot: config.workspaceRoot },
            occurredAt: now,
            receivedAt: now,
            priority: 100,
            profileId: 'owner',
            sessionKey: assertSessionId(sessionId),
          }, input);
          if (!accepted.task) throw new Error('MimiAgent 没有为 HTTP 命令创建 Task');
          return { taskId: accepted.task.id, inserted: accepted.inserted };
        },
        task: (taskId) => taskSummaryWithRuntime(store.getTask(taskId)),
        cancel: (taskId, reason) => {
          const task = store.getTask(taskId);
          return task?.executor === 'isolated_worker' || task?.executor === 'codex'
            ? activeTaskSupervisor.cancel(taskId, reason)
            : activeDispatcher.cancel(taskId, reason);
        },
        events: (taskId, after) => {
          const page = liveEvents.page(taskId, after);
          const task = mimiStreamTaskState(store.getTask(taskId));
          return {
            events: page.events,
            next: page.nextSequence,
            terminal: Boolean(task && ['completed', 'failed', 'cancelled', 'dead_letter'].includes(task.status)),
            task,
          };
        },
      });
    }
    server = new MimiIpcServer(paths.socket, async (method, rawParams, signal, auth) => {
      if (method === WORKER_CONNECTOR_INSPECT_METHOD) {
        const params = workerConnectorInspectParamsSchema.parse(rawParams);
        if (!activeTaskSupervisor.authorizeWorker(params.taskId, params.workerToken)) {
          throw new Error('后台 Task worker 身份已失效');
        }
        return connectorCapabilitySnapshot(activeConnectors, params.filter);
      }
      if (method === WORKER_CONNECTOR_ACTION_METHOD) {
        const params = workerConnectorActionParamsSchema.parse(rawParams);
        if (!activeTaskSupervisor.authorizeWorkerAction(params.taskId, params.workerToken)) {
          throw new Error('后台 Task worker 身份已失效');
        }
        // Once handed to a Connector, a disconnected worker cannot prove the
        // external transaction did not happen. Let the broker reach a result;
        // the task execution ledger prevents an uncertain retry.
        return activeConnectors.executeAction(params.request);
      }
      assertDaemonControlAuth(controlToken, auth);
      if (method === 'ping' || method === 'status') return {
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        buildVersion: MIMI_BUILD_VERSION,
        permissionMode: config.permissionMode ?? 'trusted',
        securityProfile: securityProfileSummary(config),
        ...activeStatus(),
        connectorCount: activeConnectors.size,
        webhookAddress: activeWebhook?.address,
        runtimeHttpAddress: runtimeHttp?.address,
        attention: activeAttention.status(), workspaceRoot: config.workspaceRoot,
      };
      if (stopping.signal.aborted) throw new Error('MimiAgent 正在关闭，不再接受新事务');
      if (method === 'probe.read') {
        assertReadOnlyProbeIdle(activeStatus());
        await host!.mutate(
          host!.currentSessionId,
          (agent) => agent.assertReadOnlyDaemonProbePolicy(
            createConnectorHostTools(activeConnectors),
          ),
          signal,
        );
        const claimedApps = [...new Set(activeConnectors.listCapabilities()
          .filter((connector) => connector.enabled)
          .flatMap((connector) => connector.claimedComputerApps))];
        const receipt = await executeReadOnlyProbe(rawParams, {
          connectors: activeConnectors,
          computerWindow: (expectedTarget, probeSignal) => host!.mutate(
            host!.currentSessionId,
            (agent) => agent.probeReadOnlyComputerWindow(
              [
                'com.apple.finder',
                'com.apple.Preview',
                'com.apple.TextEdit',
                'com.apple.SystemSettings',
              ],
              claimedApps,
              probeSignal,
              expectedTarget,
            ),
            probeSignal,
          ),
        }, signal);
        assertReadOnlyProbeIdle(activeStatus());
        return sanitizeSensitiveData(receipt);
      }
      if (method === 'activity.get') {
        return sanitizeSensitiveData(store.activitySnapshot(limit(object(rawParams).limit, 10)));
      }
      if (method === 'chat.bootstrap') {
        const params = object(rawParams);
        const draftSessionId = assertSessionId(requiredString(params.draftSessionId, 'draftSessionId'));
        const requestedWorkspaceRoot = optionalAbsoluteDirectory(params.workspaceRoot, 'workspaceRoot');
        const draftExists = (await host!.listSessionSummaries())
          .some((summary) => summary.id === draftSessionId);
        const snapshot = await createMimiChatSnapshot(
          host!,
          draftExists ? draftSessionId : host!.currentSessionId,
          config.workspaceRoot,
          1,
        );
        return sanitizeSensitiveData({
          ...snapshot,
          sessionId: draftSessionId,
          workspaceRoot: requestedWorkspaceRoot ?? snapshot.workspaceRoot,
          draft: true,
          permissionMode: config.permissionMode ?? 'trusted',
          securityProfile: securityProfileSummary(config),
          contextUsed: 0,
          contextStatus: {
            value: 0,
            source: 'raw-history',
            contextWindow: snapshot.contextWindow,
          },
          items: [],
          plan: [],
          recovery: undefined,
        } satisfies MimiChatSnapshot);
      }
      if (method === 'chat.sessions') {
        return sanitizeSensitiveData(
          (await host!.listSessionSummaries())
            .filter((summary) => summary.turns > 0 || summary.recoverable),
        );
      }
      if (method === 'chat.snapshot') {
        const params = object(rawParams);
        const sessionId = chatSessionId(params);
        return sanitizeSensitiveData(await createMimiChatSnapshot(
          host!,
          sessionId,
          host!.workspaceRootFor(sessionId) ?? config.workspaceRoot,
          limit(params.limit, 30),
        ));
      }
      if (method === 'chat.history') {
        const params = object(rawParams);
        const sessionId = chatSessionId(params);
        const offset = params.offset === undefined ? 0 : Number(params.offset);
        const revision = typeof params.revision === 'string' ? params.revision : undefined;
        return sanitizeSensitiveData(await createMimiHistoryChunk(host!, sessionId, offset, revision));
      }
      if (method === 'chat.invoke') {
        const params = object(rawParams);
        const operation = requiredString(params.operation, 'operation');
        if (operation === 'sessions') return sanitizeSensitiveData(await host!.listSessionSummaries());
        const sessionId = chatSessionId(params);
        return sanitizeSensitiveData(await mutationGate.run(() => host!.mutate(sessionId, async (agent) => {
            if (operation === 'runtime') return agent.runtimeInfo();
            if (operation === 'models') return agent.availableModels();
            if (operation === 'model.control') {
              return agent.modelControl(object(params.value));
            }
            if (operation === 'model.set') {
              await agent.switchModel(requiredString(params.value, 'value'));
              return agent.runtimeInfo();
            }
            if (operation === 'modes') return agent.availableModes();
            if (operation === 'mode.set') {
              await agent.switchMode(requiredString(params.value, 'value'));
              return agent.runtimeInfo();
            }
            if (operation === 'security.set') {
              await agent.switchSecurityProfile(requiredString(params.value, 'value'));
              return agent.runtimeInfo();
            }
            if (operation === 'output.set') {
              const value = requiredString(params.value, 'value');
              if (value !== 'answer' && value !== 'thinking' && value !== 'tools' && value !== 'trace') {
                throw new Error('value 必须是 answer、thinking、tools 或 trace');
              }
              await agent.setOutputLevel(value);
              return agent.runtimeInfo();
            }
            if (operation === 'skills') return agent.listSkills();
            if (operation === 'skills.reload') return agent.reloadSkills();
            if (operation === 'skills.set') {
              const request = object(params.value);
              const scope = request.scope === 'project' || request.scope === 'user'
                ? request.scope
                : undefined;
              if (!scope || typeof request.enabled !== 'boolean') throw new Error('skills.set 参数无效');
              await agent.setSkillEnabled(requiredString(request.name, 'name'), scope, request.enabled);
              return { updated: true };
            }
            if (operation === 'tools') {
              return agent.visibleToolNames(createMimiCommandHostTools(
                store,
                activeAttention,
                activeConnectors,
                sessionId,
              ));
            }
            if (operation === 'mcp') return agent.mcpStatuses();
            if (operation === 'mcp.reload') return agent.reloadMcp();
            if (operation === 'context') return agent.contextInfo();
            if (operation === 'compact') return agent.compactContext();
            if (operation === 'instructions') return agent.guidanceInfo();
            if (operation === 'memory.list') {
              const scope = params.value === 'private' || params.value === 'workspace' ? params.value : 'all';
              return agent.memoryList(scope);
            }
            if (operation === 'memory.search') {
              const request = object(params.value);
              const scope = request.scope === 'private' || request.scope === 'workspace' ? request.scope : 'all';
              return agent.memorySearch(requiredString(request.query, 'query'), scope);
            }
            if (operation === 'memory.read') return agent.memoryRead(object(params.value) as never);
            if (operation === 'memory.forget') return agent.memoryForget(object(params.value) as never);
            if (operation === 'memory.ingest') return agent.memoryIngest(requiredString(params.value, 'value'), signal);
            if (operation === 'memory.capture') {
              const roundRef = typeof params.value === 'string' && params.value.trim() ? params.value.trim() : undefined;
              return agent.memoryCaptureRound(roundRef);
            }
            if (operation === 'memory.lint') return agent.memoryLint();
            if (operation === 'memory.refresh') return agent.memoryRefresh(limit(params.value, 20));
            if (operation === 'memory.conflicts') return agent.memoryConflicts(limit(params.value, 20));
            if (operation === 'memory.audit') return agent.memoryAudit(limit(params.value, 20));
            if (operation === 'memory.maintain') {
              const created = store.emitDueMemoryMaintenanceTasks(new Date(), 'owner');
              return { created: created.map((task) => task.id), ...store.memoryObservationStatus('owner') };
            }
            if (operation === 'memory.reindex') return agent.memoryReindex();
            if (operation === 'memory.status') return {
              ...await agent.memoryStatus(),
              observations: store.memoryObservationStatus('owner'),
            };
            if (operation === 'plan') return agent.currentPlan();
            if (operation === 'team') return agent.currentTeam();
            if (operation === 'goal') return agent.currentGoal();
            if (operation === 'goal.set') return agent.setGoal(requiredString(params.value, 'value'));
            if (operation === 'resume') return { prompt: await agent.resumePrompt() };
            if (operation === 'clear') {
              await agent.clearSession();
              return { cleared: true, sessionId };
            }
            if (operation === 'undo.list') return agent.listUndoableRuns(limit(params.value, 20));
            if (operation === 'undo.preview') return agent.previewUndo(requiredString(params.value, 'value'));
            if (operation === 'undo.apply') return agent.undoRun(requiredString(params.value, 'value'));
            throw new Error(`未知 MimiAgent Chat 操作：${operation}`);
          }, signal)));
      }
      if (method === 'submit') {
        const params = object(rawParams) as SubmitParams;
        const now = new Date().toISOString();
        const source = params.source ?? 'local-cli';
        const trust = eventTrust(params.trust);
        const requestedWorkspaceRoot = source === 'local-cli' && trust === 'owner'
          ? optionalAbsoluteDirectory(params.workspaceRoot, 'workspaceRoot')
          : undefined;
        const stagedAttachments = source === 'local-cli' && trust === 'owner' && params.attachments?.length
          ? await stageAttachments(
              params.attachments,
              requestedWorkspaceRoot ?? config.workspaceRoot,
              path.join(mimiPaths(config).root, 'attachments'),
            )
          : [];
        const prompt = params.payload === undefined ? requiredString(params.text, 'text') : undefined;
        const payload = params.payload ?? {
          ...(requestedWorkspaceRoot ? { workspaceRoot: requestedWorkspaceRoot } : {}),
          ...(params.resumeState === true ? { resumeState: true } : {}),
          ...(typeof params.approvedPersonalMessageText === 'string'
            && params.approvedPersonalMessageText.trim()
            ? { approvedPersonalMessageText: params.approvedPersonalMessageText.trim().slice(0, 4_000) }
            : {}),
          ...(stagedAttachments.length ? { attachments: stagedAttachments } : {}),
        };
        const event: EventEnvelope = {
          id: params.eventId ? requiredString(params.eventId, 'eventId') : randomUUID(),
          externalId: params.externalId ?? randomUUID(), source,
          kind: eventKind(params.kind), trust,
          payload,
          occurredAt: now, receivedAt: now, priority: Math.max(0, Math.min(100, params.priority ?? 100)),
          profileId: params.profileId ?? 'owner',
          sessionKey: params.sessionKey === undefined
            ? undefined
            : assertSessionId(requiredString(params.sessionKey, 'sessionKey')),
          actor: params.actor, conversation: params.conversation, replyRoute: params.replyRoute,
        };
        return prompt !== undefined && source === 'local-cli' && trust === 'owner'
          ? ingestOwnerPrompt(event, prompt)
          : store.ingestEvent(event);
      }
      if (method === 'task.cancel') {
        const params = object(rawParams);
        const reason = typeof params.reason === 'string' ? params.reason : undefined;
        const id = requiredString(params.id, 'id');
        const task = store.getTask(id);
        return task?.executor === 'isolated_worker' || task?.executor === 'codex'
          ? activeTaskSupervisor.cancel(id, reason)
          : activeDispatcher.cancel(id, reason);
      }
      if (method === 'event.get') {
        return sanitizeSensitiveData(store.getImmutableEvent(requiredString(object(rawParams).id, 'id')));
      }
      if (method === 'event.route') {
        return sanitizeSensitiveData(store.getEventRouteReceipt(requiredString(object(rawParams).id, 'id')));
      }
      if (method === 'event.stream') {
        const params = object(rawParams);
        const id = requiredString(params.id, 'id');
        const after = Number(params.after ?? 0);
        const page = liveEvents.page(id, Number.isSafeInteger(after) && after >= 0 ? after : 0);
        return sanitizeSensitiveData({
          ...page,
          task: mimiStreamTaskState(store.getTask(id)),
        });
      }
      if (method === 'events.list') return store.listEventSummaries(limit(object(rawParams).limit));
      if (method === 'tasks.list') {
        return store.listTasks(limit(object(rawParams).limit))
          .map((task) => taskSummaryWithRuntime(task));
      }
      if (method === 'tasks.get') {
        const task = store.getTask(requiredString(object(rawParams).id, 'id'));
        if (!task) throw new Error('Task 不存在');
        return taskDetailsWithRuntime(task);
      }
      if (method === 'tasks.cancel') {
        const params = object(rawParams);
        const id = requiredString(params.id, 'id');
        const reason = typeof params.reason === 'string' ? params.reason : undefined;
        return activeTaskSupervisor.cancel(id, reason);
      }
      if (method === 'tasks.pause') {
        const params = object(rawParams);
        const id = requiredString(params.id, 'id');
        const reason = typeof params.reason === 'string' ? params.reason : undefined;
        return activeTaskSupervisor.pause(id, reason);
      }
      if (method === 'tasks.resume') {
        const params = object(rawParams);
        const id = requiredString(params.id, 'id');
        const context = typeof params.context === 'string' ? params.context : undefined;
        const task = store.getTask(id);
        if (!task) return { state: 'not_found' };
        if (task.status !== 'paused' && task.status !== 'blocked') {
          return { state: 'not_resumable' };
        }
        store.resumeTask(id, context);
        return { state: 'resumed' };
      }
      if (method === 'task.retry') return store.retryDeadLetterTask(requiredString(object(rawParams).id, 'id'));
      if (method === 'run.get') {
        return sanitizeSensitiveData(store.getRun(requiredString(object(rawParams).id, 'id')));
      }
      if (method === 'runs.list') {
        return sanitizeSensitiveData(store.listRunSummaries(limit(object(rawParams).limit)));
      }
      if (method === 'outbox.get') {
        return sanitizeSensitiveData(store.getOutbox(requiredString(object(rawParams).id, 'id')));
      }
      if (method === 'outbox.list') {
        return sanitizeSensitiveData(store.listOutboxSummaries(limit(object(rawParams).limit)));
      }
      if (method === 'outbox.retry') {
        return sanitizeSensitiveData({
          outbox: store.retryDeadLetterOutbox(requiredString(object(rawParams).id, 'id')),
          warning: '该投递采用 at-least-once 重试；若远端已接收但确认丢失，可能产生重复消息。',
        });
      }
      if (method === 'outbox.archive') {
        return sanitizeSensitiveData(
          store.archiveDeadLetterOutbox(requiredString(object(rawParams).id, 'id')),
        );
      }
      if (method === 'digest.list') {
        return sanitizeSensitiveData(store.listPendingDigest(limit(object(rawParams).limit, 100)));
      }
      if (method === 'attention.status') return activeAttention.status();
      if (method === 'attention.reload') return mutationGate.run(() => activeAttention.reload());
      if (method === 'attention.brief') return activeAttention.forceBriefing();
      if (method === 'connectors.list') return activeConnectors.listCapabilities();
      if (method === 'connectors.setEnabled') {
        const params = object(rawParams);
        return mutationGate.run(() => activeConnectors.setEnabled(
          requiredString(params.id, 'id'),
          params.enabled === true,
        ));
      }
      if (method === 'connectors.reload') {
        return mutationGate.run(async () => {
          await initializeMimi(config);
          const capabilities = await activeConnectors.reload();
          return {
            total: capabilities.length,
            enabled: capabilities.filter((connector) => connector.enabled).length,
            online: capabilities.filter((connector) => connector.online).length,
            connectors: capabilities,
          };
        });
      }
      if (method === 'schedule.get') {
        return sanitizeSensitiveData(store.getSchedule(requiredString(object(rawParams).id, 'id')));
      }
      if (method === 'schedules.page') {
        const params = object(rawParams);
        const offset = params.offset === undefined ? 0 : Number(params.offset);
        if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('schedule offset 必须是非负安全整数');
        const expectedRevision = typeof params.revision === 'string' ? params.revision : undefined;
        const revision = store.scheduleRevision();
        if (expectedRevision && expectedRevision !== revision) {
          throw new Error('计划任务在读取期间发生变化，请重试 mimi daemon schedule list');
        }
        const total = store.scheduleCount();
        const items = store.listScheduleSummaries(limit(params.limit, 200), offset);
        if (store.scheduleRevision() !== revision) {
          throw new Error('计划任务在读取期间发生变化，请重试 mimi daemon schedule list');
        }
        const nextOffset = offset + items.length;
        return sanitizeSensitiveData({
          items,
          nextOffset: nextOffset < total ? nextOffset : undefined,
          revision,
          total,
        } satisfies MimiSchedulePage);
      }
      if (method === 'schedules.list') return sanitizeSensitiveData(store.listScheduleSummaries());
      if (method === 'schedules.add') {
        const params = object(rawParams);
        const type = requiredString(params.type, 'type');
        if (type !== 'at' && type !== 'interval') throw new Error('type 必须是 at 或 interval');
        const nextRunAt = requiredString(params.nextRunAt, 'nextRunAt');
        if (!Number.isFinite(Date.parse(nextRunAt))) throw new Error('nextRunAt 不是有效时间');
        return sanitizeSensitiveData(store.addSchedule({
          name: requiredString(params.name, 'name'), type, value: requiredString(params.value, 'value'),
          prompt: requiredString(params.prompt, 'prompt'),
          profileId: typeof params.profileId === 'string' ? params.profileId : 'owner',
          sessionKey: params.sessionKey === undefined
            ? undefined
            : assertSessionId(requiredString(params.sessionKey, 'sessionKey')),
          replyRoute: (params.replyRoute as ReplyRoute | undefined) ?? activeAttention.replyRouteFor(),
          trust: params.trust === 'owner' ? 'owner' : 'system', nextRunAt: new Date(nextRunAt).toISOString(),
        }));
      }
      if (method === 'schedules.remove') return store.removeSchedule(requiredString(object(rawParams).id, 'id'));
      if (method === 'shutdown') {
        const params = rawParams === undefined ? {} : object(rawParams);
        for (const key of Object.keys(params)) {
          if (key !== 'force') throw new Error(`shutdown 不支持参数：${key}`);
        }
        if (params.force !== undefined && typeof params.force !== 'boolean') {
          throw new Error('shutdown.force 必须是 boolean');
        }
        const force = params.force === true;
        const status = activeStatus();
        if (!force && daemonHasActiveWork(status)) {
          throw new Error('MimiAgent 仍有活动事件、投递或 Chat 操作；为避免中断外部事务，当前拒绝关闭。');
        }
        if (force) {
          const blockers = forcedRestartBlockers(status);
          if (blockers.length > 0) {
            throw new Error(
              `强制重启仍被不可中断边界阻止：${blockers.join('、')}。请等待这些操作结束；不会重放 uncertain 副作用。`,
            );
          }
        }
        if (!mutationGate.beginShutdown()) {
          throw new Error('MimiAgent 仍有活动管理事务；为避免竞态，当前拒绝关闭。');
        }
        if (force) activeDispatcher.forceStop('Owner 请求强制重启，已中断无在途 Tool 的活动 Run');
        setImmediate(() => { void stop('owner_shutdown'); });
        return { accepted: true, forced: force };
      }
      throw new Error(`未知 MimiAgent RPC 方法：${method}`);
    });
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    signalsRegistered = true;
    await server.start();
    await webhook?.start();
    await runtimeHttp?.start();
    connectors.start();
    dispatcher.start();
    taskSupervisor.start();
    lifecycleEpoch = await lifecycle.transition(lifecycleEpoch.epochId, 'online');
    await waitForAbort(stopping.signal);
  } catch (error) {
    runtimeFailure = error;
    process.exitCode = 1;
    if (lifecycleEpoch.phase !== 'failed') {
      lifecycleEpoch = await lifecycle.transition(lifecycleEpoch.epochId, 'failed', {
        reason: 'runtime_failure',
        exitCode: 1,
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => lifecycleEpoch);
    }
    throw error;
  } finally {
    if (signalsRegistered) {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    }
    const cleanupErrors: string[] = [];
    const cleanup = async (operation: (() => void | Promise<void>) | undefined) => {
      if (!operation) return;
      try {
        await operation();
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    };
    const finalWebhook = webhook;
    const finalRuntimeHttp = runtimeHttp;
    const finalTaskSupervisor = taskSupervisor;
    const finalDispatcher = dispatcher;
    const finalConnectors = connectors;
    const finalServer = server;
    const finalHost = host;
    const finalComputerLifecycle = computerLifecycle;
    await cleanup(finalWebhook ? () => finalWebhook.close() : undefined);
    await cleanup(finalRuntimeHttp ? () => finalRuntimeHttp.close() : undefined);
    await cleanup(finalTaskSupervisor ? () => finalTaskSupervisor.stop() : undefined);
    await cleanup(finalDispatcher ? () => finalDispatcher.stop() : undefined);
    await cleanup(finalConnectors ? () => finalConnectors.stop() : undefined);
    await cleanup(finalServer ? () => finalServer.close() : undefined);
    await cleanup(finalHost ? () => finalHost.close() : undefined);
    await cleanup(finalComputerLifecycle ? () => finalComputerLifecycle.stop() : undefined);
    await cleanup(() => store.close());
    if (!runtimeFailure && cleanupErrors.length > 0) {
      process.exitCode = 1;
      lifecycleEpoch = await lifecycle.transition(lifecycleEpoch.epochId, 'failed', {
        reason: 'cleanup_failure',
        exitCode: 1,
        error: cleanupErrors.join('; '),
      }).catch(() => lifecycleEpoch);
    } else if (!runtimeFailure && stopRequest) {
      lifecycleEpoch = await lifecycle.transition(
        lifecycleEpoch.epochId,
        stopRequest.reason === 'owner_shutdown' ? 'stopped' : 'failed',
        {
          reason: stopRequest.reason,
          ...(stopRequest.signal ? { signal: stopRequest.signal } : {}),
          exitCode: stopRequest.exitCode,
        },
      ).catch(() => lifecycleEpoch);
    }
  }
}

async function waitForDaemonOffline(
  socket: string,
  workerId: string,
  pid: number,
  workspaceRoot: string,
  expectedPermissionMode: AgentPermissionMode,
  allowManagedReplacement: boolean,
): Promise<DaemonStatus | undefined> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    let status: DaemonStatusWire | undefined;
    try {
      status = await mimiRpc<DaemonStatusWire>(socket, 'status', undefined, 500);
    } catch {
      // The IPC socket closes before the daemon finishes draining its runtime.
    }
    if (status && status.workerId !== workerId) {
      assertDaemonWorkspace(status.workspaceRoot, workspaceRoot);
      if (daemonProtocolAction(status, expectedPermissionMode) === 'reuse') return status as DaemonStatus;
      // launchd may immediately restart the new binary with a stale plist. A
      // current, idle worker with the wrong permission can be replaced by the
      // install step below without treating it as an unknown legacy race.
      if (allowManagedReplacement && daemonProtocolState(status) === 'current') return undefined;
      throw new Error('旧版 MimiAgent 退出期间被另一个旧版后台重新启动；当前后台未被强制终止，请重试升级。');
    }
    if (!status && !daemonProcessIsLive(pid)) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('旧版 MimiAgent 已接受关闭请求，但未在 10 秒内安全退出；当前后台未被强制终止。');
}

export async function startMimiDaemon(config: AppConfig): Promise<DaemonStatus> {
  config = await resolveDaemonWorkspaceConfig(config);
  await initializeMimi(config);
  await rememberDaemonWorkspace(config);
  requireProviderApiKey(config);
  let paths = mimiPaths(config);
  const expectedPermissionMode = config.permissionMode ?? 'trusted';
  const { launchAgentInstalled, startupMode } = await daemonSupervisorState(config);
  let existing: DaemonStatusWire | undefined;
  let stoppedExisting = false;
  try {
    existing = await mimiRpc<DaemonStatusWire>(paths.socket, 'status', undefined, 500);
  } catch {
    // No live daemon; continue with the selected supervisor.
  }
  if (existing) {
    assertDaemonWorkspace(existing.workspaceRoot, config.workspaceRoot);
    const protocolAction = daemonProtocolAction(existing, expectedPermissionMode);
    const supervisorAction = daemonSupervisorAction(existing, startupMode, launchAgentInstalled);
    if (protocolAction === 'reuse' && supervisorAction === 'reuse') return existing as DaemonStatus;
    await mimiRpc(paths.socket, 'shutdown', undefined, 2_000);
    const replacement = await waitForDaemonOffline(
      paths.socket,
      existing.workerId,
      existing.pid,
      config.workspaceRoot,
      expectedPermissionMode,
      startupMode === 'launchd',
    );
    if (replacement) return replacement;
    stoppedExisting = true;
  }
  if (stoppedExisting || !existsSync(paths.socket)) {
    config = migrateLegacyMimiDaemon(config);
    paths = mimiPaths(config);
  }
  if (startupMode === 'launchd') {
    await installMimiLaunchAgent(config);
  } else {
    const entry = process.argv[1];
    if (!entry) throw new Error('无法确定 MimiAgent 启动入口');
    mkdirSync(paths.root, { recursive: true, mode: 0o700 });
    chmodSync(paths.root, 0o700);
    await rotateDaemonLogs(paths);
    const stdout = openSync(paths.stdoutLog, 'a', 0o600);
    const stderr = openSync(paths.stderrLog, 'a', 0o600);
    try {
      const child = spawn(process.execPath, [...process.execArgv, entry, 'daemon', 'run'], {
        detached: true,
        stdio: ['ignore', stdout, stderr],
        cwd: config.workspaceRoot,
        env: {
          ...process.env,
          ...daemonLaunchEnvironment(config),
          MIMI_DAEMON_SUPERVISOR: 'detached',
        },
      });
      child.unref();
    } finally {
      closeSync(stdout);
      closeSync(stderr);
    }
  }
  const deadline = Date.now() + 10_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    let status: DaemonStatusWire;
    try {
      status = await mimiRpc<DaemonStatusWire>(paths.socket, 'status', undefined, 500);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }
    assertDaemonWorkspace(status.workspaceRoot, config.workspaceRoot);
    const state = daemonProtocolState(status);
    if (state === 'current'
      && status.permissionMode === expectedPermissionMode
      && status.buildVersion === MIMI_BUILD_VERSION) return status as DaemonStatus;
    if (state === 'current') {
      lastError = new Error(
        `新启动的 MimiAgent 执行档位 ${String(status.permissionMode ?? 'unknown')} 与当前配置 ${expectedPermissionMode} 不一致`,
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }
    if (state === 'newer') {
      throw new Error(
        `新启动的 MimiAgent 协议版本 ${String(status.protocolVersion)} 高于当前 CLI ${DAEMON_PROTOCOL_VERSION}。`,
      );
    }
    lastError = new Error(
      `新启动的 MimiAgent 未返回当前协议/构建 ${DAEMON_PROTOCOL_VERSION}/${MIMI_BUILD_VERSION}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`MimiAgent 启动失败，请查看 ${paths.stderrLog}：${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

export async function stopMimiDaemon(
  config: AppConfig,
  options: { force?: boolean } = {},
): Promise<boolean> {
  config = await resolveDaemonWorkspaceConfig(config);
  const paths = mimiPaths(config);
  let existing: DaemonStatusWire;
  try {
    existing = await mimiRpc<DaemonStatusWire>(paths.socket, 'status', undefined, 500);
  } catch {
    return false;
  }
  assertDaemonWorkspace(existing.workspaceRoot, config.workspaceRoot);
  await mimiRpc(paths.socket, 'shutdown', options.force ? { force: true } : undefined, 2_000);
  const replacement = await waitForDaemonOffline(
    paths.socket,
    existing.workerId,
    existing.pid,
    config.workspaceRoot,
    config.permissionMode ?? 'trusted',
    false,
  );
  if (replacement) {
    throw new Error(`MimiAgent 后台在停止过程中被重新启动（PID ${replacement.pid}）。`);
  }
  return true;
}

export async function restartMimiDaemon(
  config: AppConfig,
  options: { force?: boolean } = {},
): Promise<DaemonStatus> {
  config = await resolveDaemonWorkspaceConfig(config);
  await stopMimiDaemon(config, options);
  return startMimiDaemon(config);
}

export async function waitForRemoteTask(
  config: AppConfig,
  id: string,
  timeoutMs = 24 * 60 * 60_000,
): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = await mimiRpc<{ status: string; result?: unknown; error?: string } | undefined>(
      mimiPaths(config).socket, 'tasks.get', { id }, 2_000,
    );
    if (!task) throw new Error(`Task 不存在：${id}`);
    if (['completed', 'failed', 'cancelled', 'dead_letter', 'paused', 'blocked'].includes(task.status)) {
      return task;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`等待 Task 超时：${id}`);
}

export type { ScheduleRecord };
