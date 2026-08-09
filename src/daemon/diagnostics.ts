import { randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  resolveEnvironmentFile,
  securityProfileSummary,
  type AppConfig,
  type SecurityProfileSummary,
} from '../config.js';
import { providerApiKeyName } from '../provider-config.js';
import { providerBackupRouteFromEnvironment } from '../runtime/run-service.js';
import {
  mimiBuildDiagnostics,
  mimiPaths,
} from './client-runtime.js';
import {
  parseConnectorConfig,
  type ConnectorCapability,
  type ConnectorFileConfig,
} from './connectors.js';
import {
  buildDaemonHealth,
  doctorBlockingHealthRisks,
  type DaemonHealthSnapshot,
} from './health-model.js';
import { mimiRpc } from './ipc.js';
import { pathExists } from './json-file.js';
import { MIMI_LAUNCH_AGENT_LABEL } from './launch-agent-config.js';
import { classifyReadinessUnknown } from './operational-classification.js';
import { launchAgentProviderConfigured } from './provider-environment.js';
import { resourceHostSummary } from './resource-slo.js';
import type { DaemonStatus, MimiActivitySnapshot } from './types.js';

export const DIAGNOSTIC_BUNDLE_SCHEMA_VERSION = 1;

const CAPACITY_THRESHOLDS = Object.freeze({
  logWarningBytes: 10 * 1024 * 1024,
  logCriticalBytes: 100 * 1024 * 1024,
  databaseWarningBytes: 512 * 1024 * 1024,
  databaseCriticalBytes: 2 * 1024 * 1024 * 1024,
  memoryWarningBytes: 1024 * 1024 * 1024,
  memoryCriticalBytes: 4 * 1024 * 1024 * 1024,
});

export type DiagnosticCapacityState = 'ok' | 'warning' | 'critical';

export interface DiagnosticFileMetric {
  exists: boolean;
  bytes: number;
  updatedAt?: string;
}

export interface DiagnosticDirectoryMetric extends DiagnosticFileMetric {
  files: number;
  unreadableEntries: number;
}

export interface DiagnosticStorageSnapshot {
  database: DiagnosticFileMetric;
  databaseWal: DiagnosticFileMetric;
  databaseSharedMemory: DiagnosticFileMetric;
  stdoutLog: DiagnosticFileMetric;
  stderrLog: DiagnosticFileMetric;
  memory: DiagnosticDirectoryMetric;
  capacity: {
    state: DiagnosticCapacityState;
    database: DiagnosticCapacityState;
    logs: DiagnosticCapacityState;
    memory: DiagnosticCapacityState;
    thresholds: typeof CAPACITY_THRESHOLDS;
  };
}

export interface RedactedDiagnosticBundle {
  schemaVersion: number;
  generatedAt: string;
  privacy: {
    redacted: true;
    excluded: string[];
  };
  runtime: {
    platform: NodeJS.Platform;
    node: string;
    provider: AppConfig['provider'];
    providerConfigured: boolean;
    securityProfile: SecurityProfileSummary;
  };
  daemon: {
    running: boolean;
    protocolVersion?: number;
    buildVersion?: string;
    startedAt?: string;
    effectiveCapability?: {
      schemaVersion: number;
      snapshotDigest: string;
      observedAt: string;
    };
    providerHealth?: NonNullable<MimiDoctorReport['daemon']['status']>['providerHealth'];
    providerHealthRoutes?: NonNullable<MimiDoctorReport['daemon']['status']>['providerHealthRoutes'];
    taskWorkerRuntime?: NonNullable<MimiDoctorReport['daemon']['status']>['taskWorkerRuntime'];
    health?: {
      state: 'ready' | 'degraded' | 'unhealthy';
      checkedAt: string;
      risks: Array<{ code: string; severity: 'warning' | 'error' }>;
      backlog: DaemonHealthSnapshot['backlog'];
      connectors: {
        enabled: number;
        online: number;
        ready: number;
        offline: number;
        unavailable: number;
        stale: number;
        unknown: number;
      };
    };
  };
  capabilities: {
    connectors: {
      configured: boolean;
      total: number;
      enabled: number;
      missingScripts: number;
      runtime?: {
        online: number;
        offline: number;
        inboundReady: number;
        outboundReady: number;
        unavailable: number;
      };
    };
    systemBinaries: { total: number; available: number };
    launchAgentInstalled: boolean;
    computer: { configured: boolean; ready?: boolean };
  };
  storage: DiagnosticStorageSnapshot;
  resources: {
    host: ReturnType<typeof resourceHostSummary>;
    daily: NonNullable<MimiDoctorReport['daemon']['activity']>['resourceTrends'];
    bySource24h: NonNullable<MimiDoctorReport['daemon']['activity']>['runUsageBySource'];
    autonomousBudgetExhaustions: NonNullable<MimiDoctorReport['daemon']['activity']>['autonomousBudgetExhaustions'];
  };
  failureClassification: NonNullable<MimiDoctorReport['daemon']['activity']>['failureClassification'];
}

async function fileMetric(file: string): Promise<DiagnosticFileMetric> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) return { exists: false, bytes: 0 };
    return { exists: true, bytes: info.size, updatedAt: info.mtime.toISOString() };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false, bytes: 0 };
    throw error;
  }
}

async function directoryMetric(root: string): Promise<DiagnosticDirectoryMetric> {
  const result: DiagnosticDirectoryMetric = {
    exists: false,
    bytes: 0,
    files: 0,
    unreadableEntries: 0,
  };
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
      result.exists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') result.unreadableEntries += 1;
      continue;
    }
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        pending.push(target);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const info = await lstat(target);
        result.files += 1;
        result.bytes += info.size;
        const updatedAt = info.mtime.toISOString();
        if (!result.updatedAt || updatedAt > result.updatedAt) result.updatedAt = updatedAt;
      } catch {
        result.unreadableEntries += 1;
      }
    }
  }
  return result;
}

function capacityState(
  bytes: number,
  warningBytes: number,
  criticalBytes: number,
): DiagnosticCapacityState {
  if (bytes >= criticalBytes) return 'critical';
  if (bytes >= warningBytes) return 'warning';
  return 'ok';
}

function maximumCapacityState(states: DiagnosticCapacityState[]): DiagnosticCapacityState {
  if (states.includes('critical')) return 'critical';
  if (states.includes('warning')) return 'warning';
  return 'ok';
}

export async function buildRedactedDiagnosticBundle(
  config: AppConfig,
  doctor: MimiDoctorReport,
): Promise<RedactedDiagnosticBundle> {
  const storage = await inspectDiagnosticStorage(config);
  const health = doctor.daemon.health;
  return {
    schemaVersion: DIAGNOSTIC_BUNDLE_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    privacy: {
      redacted: true,
      excluded: [
        'event payloads and message bodies',
        'reply targets and recipient identifiers',
        'tokens, credentials, environment values, and Connector arguments',
        'Session transcripts, run answers, and errors',
        'private Memory content and filesystem paths',
      ],
    },
    runtime: {
      platform: doctor.platform,
      node: doctor.node,
      provider: doctor.provider.id,
      providerConfigured: doctor.provider.configured,
      securityProfile: securityProfileSummary(config),
    },
    daemon: {
      running: doctor.daemon.running,
      ...(doctor.daemon.status ? {
        protocolVersion: doctor.daemon.status.protocolVersion,
        ...(doctor.daemon.status.buildVersion ? { buildVersion: doctor.daemon.status.buildVersion } : {}),
        startedAt: doctor.daemon.status.startedAt,
        ...(doctor.daemon.status.effectiveCapability
          ? { effectiveCapability: doctor.daemon.status.effectiveCapability }
          : {}),
        ...(doctor.daemon.status.providerHealth
          ? { providerHealth: doctor.daemon.status.providerHealth }
          : {}),
        ...(doctor.daemon.status.providerHealthRoutes
          ? { providerHealthRoutes: doctor.daemon.status.providerHealthRoutes }
          : {}),
        ...(doctor.daemon.status.taskWorkerRuntime
          ? { taskWorkerRuntime: doctor.daemon.status.taskWorkerRuntime }
          : {}),
      } : {}),
      ...(health ? {
        health: {
          state: health.state,
          checkedAt: health.checkedAt,
          risks: health.risks.map((risk) => ({ code: risk.code, severity: risk.severity })),
          backlog: health.backlog,
          connectors: {
            enabled: health.connectors.enabled,
            online: health.connectors.online,
            ready: health.connectors.ready,
            offline: health.connectors.offline.length,
            unavailable: health.connectors.unavailable.length,
            stale: health.connectors.stale.length,
            unknown: health.connectors.unknown.length,
          },
        },
      } : {}),
    },
    capabilities: {
      connectors: {
        configured: doctor.connectors.configured,
        total: doctor.connectors.total,
        enabled: doctor.connectors.enabled.length,
        missingScripts: doctor.connectors.missingScripts.length,
        ...(doctor.connectors.runtime ? {
          runtime: {
            online: doctor.connectors.runtime.online.length,
            offline: doctor.connectors.runtime.offline.length,
            inboundReady: doctor.connectors.runtime.inboundReady.length,
            outboundReady: doctor.connectors.runtime.outboundReady.length,
            unavailable: doctor.connectors.runtime.unavailable.length,
          },
        } : {}),
      },
      systemBinaries: {
        total: doctor.systemBinaries.length,
        available: doctor.systemBinaries.filter((binary) => binary.available).length,
      },
      launchAgentInstalled: doctor.launchAgent.installed,
      computer: {
        configured: doctor.computer.configured,
        ...(doctor.computer.ready !== undefined ? { ready: doctor.computer.ready } : {}),
      },
    },
    storage,
    resources: {
      host: resourceHostSummary(),
      daily: doctor.daemon.activity?.resourceTrends ?? [],
      bySource24h: doctor.daemon.activity?.runUsageBySource ?? [],
      autonomousBudgetExhaustions: doctor.daemon.activity?.autonomousBudgetExhaustions ?? [],
    },
    failureClassification: doctor.daemon.activity?.failureClassification ?? {
      deadLetters: [],
      digest: [],
      readinessUnknown: [],
      unclassifiedDeadLetters: doctor.daemon.health?.backlog.taskDeadLetters ?? 0,
    },
  };
}

export async function inspectDiagnosticStorage(config: AppConfig): Promise<DiagnosticStorageSnapshot> {
  const paths = mimiPaths(config);
  const [database, databaseWal, databaseSharedMemory, stdoutLog, stderrLog, memory] = await Promise.all([
    fileMetric(paths.database),
    fileMetric(`${paths.database}-wal`),
    fileMetric(`${paths.database}-shm`),
    fileMetric(paths.stdoutLog),
    fileMetric(paths.stderrLog),
    directoryMetric(path.join(config.dataRoot, 'memory')),
  ]);
  const databaseBytes = database.bytes + databaseWal.bytes + databaseSharedMemory.bytes;
  const logBytes = stdoutLog.bytes + stderrLog.bytes;
  const databaseCapacity = capacityState(
    databaseBytes,
    CAPACITY_THRESHOLDS.databaseWarningBytes,
    CAPACITY_THRESHOLDS.databaseCriticalBytes,
  );
  const logCapacity = capacityState(
    logBytes,
    CAPACITY_THRESHOLDS.logWarningBytes,
    CAPACITY_THRESHOLDS.logCriticalBytes,
  );
  const memoryCapacity = capacityState(
    memory.bytes,
    CAPACITY_THRESHOLDS.memoryWarningBytes,
    CAPACITY_THRESHOLDS.memoryCriticalBytes,
  );
  return {
    database,
    databaseWal,
    databaseSharedMemory,
    stdoutLog,
    stderrLog,
    memory,
    capacity: {
      state: maximumCapacityState([databaseCapacity, logCapacity, memoryCapacity]),
      database: databaseCapacity,
      logs: logCapacity,
      memory: memoryCapacity,
      thresholds: CAPACITY_THRESHOLDS,
    },
  };
}

function diagnosticErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Produces the product-level Doctor report without adding policy to the daemon composition root. */
export async function doctorMimi(config: AppConfig) {
  const paths = mimiPaths(config);
  const issues: string[] = [];
  try {
    providerBackupRouteFromEnvironment(config.provider);
  } catch (error) {
    issues.push(`Provider 主备配置无效：${diagnosticErrorMessage(error)}`);
  }
  let connectorConfig: ConnectorFileConfig | undefined;
  if (await pathExists(paths.connectorsConfig)) {
    try {
      connectorConfig = parseConnectorConfig(JSON.parse(await readFile(paths.connectorsConfig, 'utf8')) as unknown);
    } catch (error) {
      issues.push(`Connector 配置无效：${diagnosticErrorMessage(error)}`);
    }
  } else {
    issues.push('尚未初始化 connectors.json');
  }
  const enabled = connectorConfig
    ? Object.entries(connectorConfig.connectors).filter(([, connector]) => connector.enabled).map(([id]) => id)
    : [];
  if (connectorConfig && enabled.length === 0) issues.push('没有启用任何 Connector');
  const scriptPaths = connectorConfig
    ? [...new Set(Object.values(connectorConfig.connectors)
      .flatMap((connector) => connector.args)
      .filter((argument) => path.isAbsolute(argument) && /\.(?:mjs|cjs|js)$/.test(argument)))]
    : [];
  const missingScripts: string[] = [];
  for (const script of scriptPaths) if (!await pathExists(script)) missingScripts.push(script);
  if (missingScripts.length) issues.push(`${missingScripts.length} 个 Connector 脚本不存在`);
  const configured = Boolean(process.env[providerApiKeyName(config.provider)]?.trim());
  if (!configured) issues.push(`${config.provider} API Key 未配置`);
  const launchAgentFile = path.join(
    os.homedir(),
    'Library',
    'LaunchAgents',
    `${MIMI_LAUNCH_AGENT_LABEL}.plist`,
  );
  const launchAgentInstalled = await pathExists(launchAgentFile);
  const persistentProviderKey = await launchAgentProviderConfigured(config);
  if (launchAgentInstalled && !persistentProviderKey) {
    issues.push(`launchd 持久环境文件缺少 ${providerApiKeyName(config.provider)}`);
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
    else issues.push(`无法读取 Connector 在线状态：${diagnosticErrorMessage(connectorResult.reason)}`);
    if (activityResult.status === 'fulfilled') activity = activityResult.value;
    else issues.push(`无法读取 MimiAgent 活动状态：${diagnosticErrorMessage(activityResult.reason)}`);
  } else if (configured && connectorConfig) {
    issues.push('MimiAgent 后台服务未运行');
  }
  const computerStatus = daemonStatus?.computer;
  if (config.computer && daemonStatus && computerStatus?.ready !== true) {
    issues.push(`Computer Use 不可用：${computerStatus?.lastOperationalFailure ?? computerStatus?.lastFailure ?? 'Daemon 未报告 ready'}`);
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
        autonomousBudgetExhaustions: activity?.autonomousBudgetExhaustions?.length,
        unknownRunSources: activity?.unknownRunSources,
      })
    : undefined;
  if (health) {
    issues.push(...doctorBlockingHealthRisks(
      health,
      activity?.failureClassification?.unclassifiedDeadLetters ?? taskDeadLetters,
    ).map((risk) => risk.message));
  }
  const build = mimiBuildDiagnostics(daemonStatus?.buildVersion, config.workspaceRoot);
  if (build.aligned === false) {
    issues.push(`构建漂移：installed=${build.installed}，running=${build.running ?? 'unknown'}`);
  }
  let storage: DiagnosticStorageSnapshot | undefined;
  const capacityRisks = [
    ['database', 'SQLite', '运行 mimi daemon activity 检查保留策略和积压，再安排数据库备份与维护'],
    ['logs', 'Daemon 日志', '安全重启 MimiAgent 以轮转超限日志，并检查重复错误'],
    ['memory', 'Memory', '检查 MemoryHub 页面、索引和备份增长'],
  ] as const;
  try {
    storage = await inspectDiagnosticStorage(config);
    for (const [key, label] of capacityRisks) {
      if (storage.capacity[key] !== 'ok') issues.push(`${label} 容量达到 ${storage.capacity[key]} 阈值`);
    }
  } catch (error) {
    issues.push(`无法读取本地容量指标：${diagnosticErrorMessage(error)}`);
  }
  const nextActions: string[] = [];
  if (!connectorConfig) nextActions.push('运行 mimi 完成自动初始化');
  if (!configured) nextActions.push(`在 ~/.mimi-agent/.env（或旧目录）配置 ${providerApiKeyName(config.provider)}`);
  if (launchAgentInstalled && !persistentProviderKey && configured) {
    nextActions.push(`把 ${providerApiKeyName(config.provider)} 写入 ${resolveEnvironmentFile()} 后重新运行 mimi`);
  }
  if (missingScripts.length) nextActions.push('重新运行 npm install 或修复 Connector 脚本路径');
  if (!daemonStatus && configured && connectorConfig) nextActions.push('运行 mimi，后台服务会自动启动');
  if (build.aligned === false) nextActions.push('满足安全切换门禁后，从同一 clean package 部署运行构建');
  if (health) {
    for (const action of health.risks.map((risk) => risk.nextAction)) {
      if (!nextActions.includes(action)) nextActions.push(action);
    }
  }
  for (const [key, , action] of capacityRisks) {
    if (storage && storage.capacity[key] !== 'ok') nextActions.push(action);
  }
  return {
    ready: issues.length === 0,
    platform: process.platform,
    node: process.version,
    provider: { id: config.provider, configured },
    build,
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
    systemBinaries: [] as Array<{ path: string; available: boolean }>,
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
          runUsageBySource: activity.runUsageBySource ?? [],
          autonomousBudgetExhaustions: activity.autonomousBudgetExhaustions ?? [],
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
    launchAgent: { installed: launchAgentInstalled, file: launchAgentFile },
    computer: {
      configured: Boolean(config.computer),
      ...(config.computer ? { backend: config.computer.backend, ready: computerStatus?.ready === true } : {}),
      ...(computerStatus ? { diagnostics: { ...computerStatus } as Record<string, unknown> } : {}),
    },
    ...(storage ? { storage } : {}),
    issues,
    nextActions,
  };
}

export type MimiDoctorReport = Awaited<ReturnType<typeof doctorMimi>>;

export async function writeRedactedDiagnosticBundle(
  outputFile: string,
  bundle: RedactedDiagnosticBundle,
): Promise<string> {
  const target = path.resolve(outputFile);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(bundle, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await link(temporary, target);
    await chmod(target, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
  return target;
}
