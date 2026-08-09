import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  readlink,
  readdir,
  readFile,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import { parse as parseDotenv } from 'dotenv';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  auditConversationTurnEvidence,
  assessScenarioEligibility,
  deriveConversationResumeState,
  materializeConversationTurn,
  parseConversationManifest,
  redactTerminalSecrets,
  sha256,
  stripTerminalControl,
  type ConversationJournalRecord,
  type ConversationLane,
  type ConversationManifest,
  type ConversationScenario,
  type MaterializedTurn,
  type ScenarioCapabilitySnapshot,
} from './conversation-soak-contract.js';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mimiEntry = path.join(repositoryRoot, 'dist', 'index.js');
const ptyHelper = path.join(repositoryRoot, 'scripts', 'run-conversation-pty.py');
const contractFile = path.join(repositoryRoot, 'scripts', 'conversation-soak-contract.ts');
const runnerFile = path.join(repositoryRoot, 'scripts', 'run-conversation-soak.ts');
const defaultManifest = path.join(repositoryRoot, 'evals', 'conversation', 'manifest.v1.json');
const terminalTaskStates = new Set(['completed', 'failed', 'cancelled', 'dead_letter', 'paused', 'blocked']);

type RunMode = 'validate' | 'calibrate' | 'pty-smoke' | 'soak';

interface RunnerOptions {
  mode: RunMode;
  manifestFile: string;
  output?: string;
  resume: boolean;
  skipBuild: boolean;
  retainRuntime: boolean;
  sceneIds: string[];
  lane?: ConversationLane;
  calibrationTurns: number;
  concurrency: number;
  ptyEvidence?: string;
  turnTimeoutMs: number;
  toolTimeoutMs: number;
  cancelGraceMs: number;
  stopDispatchMs: number;
  hardStopMs: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxDiskBytes: number;
  maxEstimatedUsd?: number;
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
}

interface IsolatedRuntime {
  root: string;
  workspace: string;
  dataRoot: string;
  daemonRoot: string;
  environmentFile: string;
  env: NodeJS.ProcessEnv;
  secretNames: string[];
  secrets: string[];
  daemon: ChildProcess;
  exited: Promise<void>;
  logs: Buffer[];
  forcedShardKill: boolean;
}

interface RunSummary {
  id?: string;
  taskId?: string;
  sessionKey?: string;
  status?: string;
}

interface ProcessCapture {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  output: Buffer;
  overflow: boolean;
}

interface AggregateUsage {
  inputTokens: number;
  outputTokens: number;
  estimatedUsd?: number;
  provenTurns: number;
  unprovenTurns: number;
}

interface RunContext {
  options: RunnerOptions;
  manifest: ConversationManifest;
  manifestDigest: string;
  outputRoot: string;
  journalFile: string;
  checkpointFile: string;
  buildDigest: string;
  sourceSnapshot: SourceSnapshot;
  startedAt: number;
  aggregate: AggregateUsage;
  globalStopReason?: string;
}

interface SourceSnapshot {
  schemaVersion: 1;
  digest: string;
  files: Record<string, string>;
}

interface EvidenceArtifact {
  kind: string;
  path: string;
  sha256: string;
  bytes: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function integerArgument(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = argument(name);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function optionalPositiveEnvironment(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
}

function parseOptions(): RunnerOptions {
  const mode = (argument('--mode') ?? 'validate') as RunMode;
  if (!['validate', 'calibrate', 'pty-smoke', 'soak'].includes(mode)) {
    throw new Error('--mode must be validate, calibrate, pty-smoke, or soak');
  }
  const lane = argument('--lane') as ConversationLane | undefined;
  if (lane && !['S', 'W', 'F', 'V', 'L'].includes(lane)) throw new Error('--lane is invalid');
  const sceneIds = (argument('--scenes') ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  return {
    mode,
    manifestFile: path.resolve(argument('--manifest') ?? defaultManifest),
    output: argument('--output') ? path.resolve(argument('--output')!) : undefined,
    resume: process.argv.includes('--resume'),
    skipBuild: process.argv.includes('--skip-build'),
    retainRuntime: process.argv.includes('--retain-runtime'),
    sceneIds,
    lane,
    calibrationTurns: integerArgument('--turns', 5, 1, 30),
    concurrency: integerArgument('--concurrency', 2, 1, 4),
    ptyEvidence: argument('--pty-evidence') ? path.resolve(argument('--pty-evidence')!) : undefined,
    turnTimeoutMs: integerArgument('--turn-timeout-ms', 120_000, 1_000, 600_000),
    toolTimeoutMs: integerArgument('--tool-timeout-ms', 180_000, 1_000, 900_000),
    cancelGraceMs: integerArgument('--cancel-grace-ms', 15_000, 1_000, 60_000),
    stopDispatchMs: integerArgument('--stop-dispatch-ms', 11.5 * 60 * 60_000, 60_000, 24 * 60 * 60_000),
    hardStopMs: integerArgument('--hard-stop-ms', 12 * 60 * 60_000, 60_000, 24 * 60 * 60_000),
    maxInputTokens: optionalPositiveEnvironment('MIMI_CONVERSATION_MAX_INPUT_TOKENS'),
    maxOutputTokens: optionalPositiveEnvironment('MIMI_CONVERSATION_MAX_OUTPUT_TOKENS'),
    maxDiskBytes: optionalPositiveEnvironment('MIMI_CONVERSATION_MAX_DISK_BYTES') ?? 20 * 1024 * 1024 * 1024,
    maxEstimatedUsd: optionalPositiveEnvironment('MIMI_CONVERSATION_MAX_ESTIMATED_USD'),
    inputUsdPerMillion: optionalPositiveEnvironment('MIMI_CONVERSATION_INPUT_USD_PER_MILLION'),
    outputUsdPerMillion: optionalPositiveEnvironment('MIMI_CONVERSATION_OUTPUT_USD_PER_MILLION'),
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(() => true, () => false);
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, 'utf8')) as unknown;
}

async function readOptionalJson(file: string): Promise<Record<string, unknown>> {
  try {
    return record(await readJson(file)) ?? {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

async function writeExclusive(file: string, value: string | Buffer): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, value, { flag: 'wx', mode: 0o600 });
  await chmod(file, 0o600);
}

async function writeExclusiveJson(file: string, value: unknown): Promise<void> {
  await writeExclusive(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeEvidenceJson(
  outputRoot: string,
  file: string,
  value: unknown,
): Promise<EvidenceArtifact> {
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  await writeExclusive(file, contents);
  return {
    kind: 'json',
    path: path.relative(outputRoot, file),
    sha256: sha256(contents),
    bytes: Buffer.byteLength(contents),
  };
}

async function appendJournal(file: string, value: ConversationJournalRecord): Promise<void> {
  const operation = journalWriteQueue.then(async () => {
    await appendFile(file, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
    await chmod(file, 0o600);
  });
  journalWriteQueue = operation.then(() => undefined, () => undefined);
  await operation;
}

let journalWriteQueue: Promise<void> = Promise.resolve();

async function readJournal(file: string): Promise<ConversationJournalRecord[]> {
  if (!await exists(file)) return [];
  return (await readFile(file, 'utf8')).split('\n').filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line) as ConversationJournalRecord;
    } catch {
      throw new Error(`journal line ${index + 1} is corrupt; append-only evidence cannot be repaired in place`);
    }
  });
}

async function writeCheckpoint(context: RunContext): Promise<void> {
  const checkpoint = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    manifestDigest: context.manifestDigest,
    buildDigest: context.buildDigest,
    aggregate: context.aggregate,
    globalStopReason: context.globalStopReason,
  };
  const temporary = `${context.checkpointFile}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(checkpoint, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await rename(temporary, context.checkpointFile);
  await chmod(context.checkpointFile, 0o600);
}

async function hashRepositoryPath(relative: string): Promise<string> {
  const absolute = path.join(repositoryRoot, relative);
  try {
    const before = await lstat(absolute);
    if (before.isSymbolicLink()) return sha256(`symlink\0${await readlink(absolute)}`);
    if (!before.isFile()) return sha256(`non-file\0${before.mode}`);
    const contents = await readFile(absolute);
    const after = await lstat(absolute);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) {
      throw new Error(`source path changed while hashing: ${relative}`);
    }
    return sha256(Buffer.concat([
      Buffer.from(`file\0${before.mode & 0o777}\0${contents.byteLength}\0`),
      contents,
    ]));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return sha256('missing');
    throw error;
  }
}

async function captureSourceSnapshot(): Promise<SourceSnapshot> {
  const { stdout } = await execFileAsync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const names = [...new Set(stdout.split('\0').filter(Boolean))].sort();
  const files: Record<string, string> = {};
  for (const name of names) files[name] = await hashRepositoryPath(name);
  return { schemaVersion: 1, digest: sha256(JSON.stringify(files)), files };
}

function changedSourcePaths(expected: SourceSnapshot, actual: SourceSnapshot): string[] {
  const paths = new Set([...Object.keys(expected.files), ...Object.keys(actual.files)]);
  return [...paths].filter((name) => expected.files[name] !== actual.files[name]).sort();
}

async function digestTree(root: string): Promise<string> {
  const digest = createHash('sha256');
  const visit = async (directory: string, relativeRoot: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = path.posix.join(relativeRoot, entry.name);
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        digest.update(`directory\0${relative}\0`);
        await visit(absolute, relative);
      } else if (entry.isSymbolicLink()) {
        digest.update(`symlink\0${relative}\0${await readlink(absolute)}\0`);
      } else if (entry.isFile()) {
        const contents = await readFile(absolute);
        digest.update(`file\0${relative}\0${contents.byteLength}\0`);
        digest.update(contents);
      } else {
        throw new Error(`unsupported dist entry type: ${relative}`);
      }
    }
  };
  await visit(root, '');
  return digest.digest('hex');
}

async function runtimeClosureDigest(distDigest: string, manifestFile: string): Promise<string> {
  const files = [
    runnerFile,
    contractFile,
    ptyHelper,
    manifestFile,
    path.join(repositoryRoot, 'package.json'),
    path.join(repositoryRoot, 'package-lock.json'),
  ];
  const closure = await Promise.all(files.map(async (file) => ({
    file: path.relative(repositoryRoot, file),
    sha256: sha256(await readFile(file)),
  })));
  return sha256(JSON.stringify({ distDigest, closure }));
}

function boundedBuildEnvironment(): NodeJS.ProcessEnv {
  const names = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR'];
  return Object.fromEntries(names.flatMap((name) => process.env[name] ? [[name, process.env[name]!]] : []));
}

async function cleanBuild(outputRoot: string, manifestFile: string): Promise<string> {
  const buildLog = path.join(outputRoot, 'build.log');
  const result = await execFileAsync('npm', ['run', 'build'], {
    cwd: repositoryRoot,
    env: boundedBuildEnvironment(),
    encoding: 'utf8',
    timeout: 10 * 60_000,
    maxBuffer: 16 * 1024 * 1024,
  }).then(
    ({ stdout, stderr }) => ({ code: 0, output: `${stdout}${stderr}` }),
    (error: unknown) => {
      const value = error as { stdout?: string; stderr?: string; code?: number };
      return { code: value.code ?? 1, output: `${value.stdout ?? ''}${value.stderr ?? ''}` };
    },
  );
  const sanitized = redactTerminalSecrets(result.output, []).text;
  await writeExclusive(buildLog, sanitized);
  if (result.code !== 0) throw new Error(`clean build failed; see ${buildLog}`);
  return runtimeClosureDigest(await digestTree(path.join(repositoryRoot, 'dist')), manifestFile);
}

async function isolatedProviderEnvironment(configRoot: string, reuse: boolean): Promise<{
  values: NodeJS.ProcessEnv;
  secretNames: string[];
  secrets: string[];
  environmentContents: string;
  modelsFile: string;
  configDigest: string;
}> {
  const modelsSource = process.env.MIMI_CONVERSATION_MODELS_CONFIG?.trim();
  if (!modelsSource) {
    throw new Error('real calibration requires MIMI_CONVERSATION_MODELS_CONFIG with one selected target');
  }
  const modelsFile = path.join(configRoot, 'models.json');
  if (process.env.MIMI_CONVERSATION_PROVIDER_ENV_ALLOWLIST?.trim()) {
    throw new Error('MIMI_CONVERSATION_PROVIDER_ENV_ALLOWLIST is forbidden; select exactly one Provider key');
  }
  const source = path.resolve(modelsSource);
  const parsed = record(await readJson(source));
  const routing = record(parsed?.routing);
  const target = record(routing?.globalDefault);
  const providerId = typeof target?.providerId === 'string' ? target.providerId : undefined;
  const modelId = typeof target?.modelId === 'string' ? target.modelId : undefined;
  const providers = Array.isArray(parsed?.providers) ? parsed.providers.map(record).filter(Boolean) : [];
  const provider = providers.find((item) => item?.id === providerId);
  const models = Array.isArray(provider?.models) ? provider.models.map(record).filter(Boolean) : [];
  const selectedModel = models.find((item) => {
    const selectedTarget = record(item?.target);
    return selectedTarget?.providerId === providerId && selectedTarget?.modelId === modelId;
  });
  if (!provider || !selectedModel || typeof provider.apiKeyEnv !== 'string'
    || !/^[A-Z][A-Z0-9_]*$/u.test(provider.apiKeyEnv)
    || !providerId || !modelId) {
    throw new Error('isolated models config must expose one valid global-default Provider/Model target');
  }
  const projected = {
    version: 1,
    routeVersion: typeof parsed?.routeVersion === 'number' ? parsed.routeVersion : 1,
    providers: [{ ...provider, models: [selectedModel] }],
    routing: {
      globalDefault: { providerId, modelId },
      scenarios: {},
    },
  };
  const projectedContents = `${JSON.stringify(projected, null, 2)}\n`;
  if (reuse) {
    if (!await exists(modelsFile)) throw new Error('resume runtime bundle is missing models.json');
    if (sha256(projectedContents) !== sha256(await readFile(modelsFile))) {
      throw new Error('resume Provider model config digest changed');
    }
  } else {
    await writeExclusive(modelsFile, projectedContents);
  }
  await chmod(modelsFile, 0o600);

  const credentialSource = path.resolve(
    process.env.MIMI_CONVERSATION_PROVIDER_ENV_FILE?.trim()
      || path.join(os.homedir(), '.mimi-agent', '.env'),
  );
  const credentialValues = await exists(credentialSource)
    ? parseDotenv(await readFile(credentialSource, 'utf8'))
    : {};
  const secretName = provider.apiKeyEnv;
  const secretValue = process.env[secretName] ?? credentialValues[secretName];
  if (!secretValue || secretValue.includes('\0') || /[\r\n]/u.test(secretValue)) {
    throw new Error(`selected Provider credential ${secretName} is not configured as one bounded line`);
  }
  const environmentContents = `${secretName}=${JSON.stringify(secretValue)}\n`;
  if (parseDotenv(environmentContents)[secretName] !== secretValue) {
    throw new Error(`selected Provider credential ${secretName} cannot be safely serialized`);
  }
  const nonSecret = ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR'];
  const values: NodeJS.ProcessEnv = {};
  for (const name of nonSecret) {
    if (process.env[name]) values[name] = process.env[name];
  }
  return {
    values,
    secretNames: [secretName],
    secrets: [secretValue],
    environmentContents,
    modelsFile,
    configDigest: sha256(JSON.stringify({
      models: sha256(projectedContents),
      values,
      secretNames: [secretName],
    })),
  };
}

function securityFor(lane: ConversationLane): { profile: string; permission: string } {
  if (lane === 'S') return { profile: 'safe', permission: 'read-only' };
  if (lane === 'W' || lane === 'F') return { profile: 'workstation', permission: 'workspace' };
  throw new Error(`lane ${lane} is not eligible on the unattended host`);
}

async function startIsolatedRuntime(context: RunContext, scenario: ConversationScenario): Promise<IsolatedRuntime> {
  const bundlesRoot = path.join(context.outputRoot, 'runtime-bundles');
  await mkdir(bundlesRoot, { recursive: true, mode: 0o700 });
  await chmod(bundlesRoot, 0o700);
  const root = path.join(bundlesRoot, scenario.scenarioId);
  const markerFile = path.join(root, 'bundle.json');
  const reuse = await exists(markerFile);
  if (!reuse) {
    if (await exists(root)) throw new Error(`incomplete runtime bundle exists without marker: ${root}`);
    await mkdir(root, { recursive: false, mode: 0o700 });
  } else if (!context.options.resume) {
    throw new Error(`runtime bundle already exists without --resume: ${root}`);
  }
  await chmod(root, 0o700);
  const workspace = path.join(root, 'workspace');
  const dataRoot = path.join(root, 'data');
  const daemonRoot = path.join(root, 'daemon');
  const home = path.join(root, 'home');
  const temporary = path.join(root, 'tmp');
  const configRoot = path.join(root, 'config');
  for (const directory of [workspace, dataRoot, daemonRoot, home, temporary, configRoot]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }
  const environmentFile = path.join(configRoot, '.env');
  const connectorsFile = path.join(configRoot, 'connectors.json');
  const assistantFile = path.join(configRoot, 'assistant.json');
  const mcpFile = path.join(configRoot, 'mcp.json');
  if (!reuse) {
    await Promise.all([
      writeExclusiveJson(connectorsFile, { backgroundDefaultsVersion: 0, connectors: {} }),
      writeExclusiveJson(mcpFile, { mcpServers: {} }),
    ]);
  } else {
    for (const required of [connectorsFile, mcpFile]) {
      if (!await exists(required)) throw new Error(`resume runtime bundle is missing ${path.basename(required)}`);
      await chmod(required, 0o600);
    }
  }
  const provider = await isolatedProviderEnvironment(configRoot, reuse);
  await writeFile(environmentFile, provider.environmentContents, { mode: 0o600 });
  await chmod(environmentFile, 0o600);
  const security = securityFor(scenario.lane);
  const marker = {
    schemaVersion: 1,
    scenarioId: scenario.scenarioId,
    manifestDigest: context.manifestDigest,
    buildDigest: context.buildDigest,
    runtimeContract: scenario.runtimeContract,
    providerConfigDigest: provider.configDigest,
    providerSecretNames: [...provider.secretNames].sort(),
  };
  if (reuse) {
    const existing = record(await readJson(markerFile));
    if (JSON.stringify(existing) !== JSON.stringify(marker)) {
      throw new Error(`resume runtime bundle identity changed for ${scenario.scenarioId}`);
    }
  } else {
    await writeExclusiveJson(markerFile, marker);
  }
  const baseNames = ['PATH', 'LANG', 'LC_ALL', 'TZ', 'TERM'];
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(baseNames.flatMap((name) => process.env[name] ? [[name, process.env[name]!]] : [])),
    ...provider.values,
    HOME: home,
    TMPDIR: temporary,
    MIMI_CONFIG_VERSION: '4',
    MIMI_WORKSPACE: workspace,
    MIMI_DATA_DIR: dataRoot,
    MIMI_DAEMON_DATA_DIR: daemonRoot,
    MIMI_DAEMON_SUPERVISOR: 'foreground',
    MIMI_ENV_FILE: environmentFile,
    MIMI_MODELS_CONFIG: provider.modelsFile,
    MIMI_CONNECTORS_CONFIG: connectorsFile,
    MIMI_ASSISTANT_CONFIG: assistantFile,
    MIMI_MCP_CONFIG: mcpFile,
    MIMI_SKILLS_DIR: path.join(workspace, 'skills'),
    MIMI_COMPUTER_BACKEND: 'off',
    MIMI_SECURITY_PROFILE: security.profile,
    MIMI_PERMISSION_MODE: security.permission,
    MIMI_SESSION_MAX_CONCURRENCY: '1',
    MIMI_CONVERSATION_RUN_POLICY: 'benchmark-no-tools-v1',
    MIMI_CONVERSATION_SECRET_NAMES: provider.secretNames.join(','),
  };
  const logs: Buffer[] = [];
  const daemon = spawn(process.execPath, [mimiEntry, 'daemon', 'run'], {
    cwd: workspace,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  const append = (chunk: Buffer) => {
    logs.push(Buffer.from(chunk));
    while (Buffer.concat(logs).byteLength > 4 * 1024 * 1024) logs.shift();
  };
  daemon.stdout?.on('data', append);
  daemon.stderr?.on('data', append);
  const exited = new Promise<void>((resolve) => daemon.once('exit', () => resolve()));
  const runtime: IsolatedRuntime = {
    root,
    workspace,
    dataRoot,
    daemonRoot,
    environmentFile,
    env,
    secretNames: provider.secretNames,
    secrets: provider.secrets,
    daemon,
    exited,
    logs,
    forcedShardKill: false,
  };
  try {
    for (let attempt = 0; attempt < 150; attempt += 1) {
      if (daemon.exitCode !== null) break;
      try {
        const status = record(await mimiJson(runtime, ['daemon', 'status', '--json'], 1_000));
        if (typeof status?.pid === 'number') return runtime;
      } catch {
        // The socket is not ready yet.
      }
      await delay(100);
    }
    const sanitized = redactTerminalSecrets(Buffer.concat(logs).toString('utf8'), runtime.secrets).text;
    throw new Error(`isolated foreground Daemon did not become ready: ${sanitized.slice(-4_000)}`);
  } catch (error) {
    await stopIsolatedRuntime(runtime, true);
    throw error;
  }
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid || child.pid <= 1) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

async function stopIsolatedRuntime(runtime: IsolatedRuntime, retain: boolean): Promise<void> {
  try {
    try {
      await mimiText(runtime, ['daemon', 'stop'], 15_000);
    } catch {
      signalGroup(runtime.daemon, 'SIGTERM');
    }
    await Promise.race([runtime.exited, delay(15_000)]);
    if (runtime.daemon.exitCode === null && runtime.daemon.signalCode === null) {
      runtime.forcedShardKill = true;
      signalGroup(runtime.daemon, 'SIGKILL');
      await runtime.exited;
    }
  } finally {
    await writeFile(
      runtime.environmentFile,
      '# provider credential removed after isolated runtime shutdown\n',
      { mode: 0o600 },
    );
    await chmod(runtime.environmentFile, 0o600);
  }
  if (!retain) throw new Error('runtime bundle deletion is disabled until durable evidence archival is proven');
}

async function mimiText(runtime: IsolatedRuntime, args: string[], timeoutMs = 30_000): Promise<string> {
  const { stdout } = await execFileAsync(process.execPath, [mimiEntry, ...args], {
    cwd: runtime.workspace,
    env: runtime.env,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

async function mimiJson(runtime: IsolatedRuntime, args: string[], timeoutMs = 30_000): Promise<unknown> {
  return JSON.parse(await mimiText(runtime, args, timeoutMs)) as unknown;
}

async function listRuns(runtime: IsolatedRuntime): Promise<RunSummary[]> {
  const value = await mimiJson(runtime, ['daemon', 'runs', '100']);
  return Array.isArray(value) ? value.map((item) => record(item) as RunSummary).filter(Boolean) : [];
}

async function sessionSnapshot(runtime: IsolatedRuntime, sessionId: string): Promise<Record<string, unknown>> {
  return readOptionalJson(path.join(runtime.dataRoot, 'sessions', `${sessionId}.json`));
}

async function traceSnapshot(runtime: IsolatedRuntime, sessionId: string): Promise<string> {
  try {
    return await readFile(path.join(runtime.dataRoot, 'traces', `${sessionId}.jsonl`), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

function traceDelta(before: string, after: string): unknown[] {
  if (!after.startsWith(before)) throw new Error('Trace rotated or was rewritten during a turn; proof is ambiguous');
  return after.slice(before.length).split('\n').filter(Boolean).map((line) => JSON.parse(line) as unknown);
}

function waitForChild(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function captureCliTurn(
  runtime: IsolatedRuntime,
  prompt: string,
  sessionId: string,
  timeoutMs: number,
  onTimeout: () => Promise<void>,
): Promise<ProcessCapture> {
  const child = spawn(process.execPath, [mimiEntry, prompt], {
    cwd: runtime.workspace,
    env: { ...runtime.env, MIMI_SESSION: sessionId },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  const chunks: Buffer[] = [];
  let bytes = 0;
  let overflow = false;
  const collect = (chunk: Buffer) => {
    if (bytes >= 16 * 1024 * 1024) {
      overflow = true;
      return;
    }
    const bounded = chunk.subarray(0, 16 * 1024 * 1024 - bytes);
    chunks.push(Buffer.from(bounded));
    bytes += bounded.length;
    if (bounded.length !== chunk.length) overflow = true;
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  const exited = waitForChild(child);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; }, timeoutMs);
  timer.unref();
  while (!timedOut && child.exitCode === null && child.signalCode === null) await delay(50);
  if (timedOut) {
    await onTimeout();
    await Promise.race([exited, delay(15_000)]);
    if (child.exitCode === null && child.signalCode === null) signalGroup(child, 'SIGTERM');
    await Promise.race([exited, delay(2_000)]);
    if (child.exitCode === null && child.signalCode === null) signalGroup(child, 'SIGKILL');
  }
  clearTimeout(timer);
  const terminal = child.exitCode !== null || child.signalCode !== null
    ? { code: child.exitCode, signal: child.signalCode }
    : await exited;
  return {
    exitCode: terminal.code,
    signal: terminal.signal,
    timedOut,
    output: Buffer.concat(chunks),
    overflow,
  };
}

async function findNewRun(
  runtime: IsolatedRuntime,
  sessionId: string,
  previousIds: Set<string>,
  timeoutMs = 5_000,
): Promise<RunSummary | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = (await listRuns(runtime)).find((item) => item.sessionKey === sessionId
      && item.id && !previousIds.has(item.id));
    if (found) return found;
    await delay(100);
  }
  return undefined;
}

async function cancelTimedOutTask(
  runtime: IsolatedRuntime,
  sessionId: string,
  previousIds: Set<string>,
  cancelGraceMs: number,
): Promise<void> {
  const current = await findNewRun(runtime, sessionId, previousIds);
  if (!current?.taskId) throw new Error('timed-out CLI did not expose a Task id for cancellation');
  const controlRoot = path.join(runtime.root, 'control', randomUUID());
  await mkdir(controlRoot, { recursive: true, mode: 0o700 });
  const actions = path.join(controlRoot, 'actions.json');
  const transcript = path.join(controlRoot, 'terminal.raw');
  const result = path.join(controlRoot, 'result.json');
  await writeExclusiveJson(actions, [
    {
      kind: 'terminal_action',
      text: `/task cancel ${current.taskId} benchmark-timeout-no-retry`,
      waitFor: '已请求取消后台任务',
      timeoutMs: cancelGraceMs,
    },
    { kind: 'terminal_action', text: '/exit', waitForExit: true, timeoutMs: cancelGraceMs },
  ]);
  await execFileAsync('python3', [
    ptyHelper,
    '--actions', actions,
    '--transcript', transcript,
    '--result', result,
    '--startup-timeout-ms', '30000',
    '--', process.execPath, mimiEntry,
  ], {
    cwd: runtime.workspace,
    env: { ...runtime.env, MIMI_SESSION: `benchmark-control-${randomUUID()}` },
    encoding: 'utf8',
    timeout: cancelGraceMs + 45_000,
    maxBuffer: 1_000_000,
  });
  const deadline = Date.now() + cancelGraceMs;
  while (Date.now() < deadline) {
    const task = record(await mimiJson(runtime, ['daemon', 'show', 'task', current.taskId], 2_000));
    if (terminalTaskStates.has(String(task?.status))) return;
    await delay(100);
  }
  runtime.forcedShardKill = true;
  signalGroup(runtime.daemon, 'SIGKILL');
  throw new Error(`Task ${current.taskId} did not reach a terminal state after cancellation`);
}

function protocolItems(snapshot: Record<string, unknown>): unknown[] {
  return Array.isArray(snapshot.items) ? snapshot.items : [];
}

function activeSessionRun(snapshot: Record<string, unknown>): boolean {
  return record(snapshot.checkpoint)?.status === 'running';
}

function answerUsage(run: unknown): { inputTokens: number; outputTokens: number } {
  const usage = record(record(record(run)?.answer)?.usage);
  const input = usage?.runInputTokens ?? usage?.inputTokens;
  const output = usage?.runOutputTokens ?? usage?.outputTokens;
  return {
    inputTokens: typeof input === 'number' && Number.isFinite(input) ? input : 0,
    outputTokens: typeof output === 'number' && Number.isFinite(output) ? output : 0,
  };
}

function runtimeRunIdFromTrace(trace: unknown[]): string | undefined {
  for (const raw of trace) {
    const event = record(raw);
    const data = record(event?.data);
    if (event?.type === 'model_binding_event'
      && data?.workUnitKind === 'conversation'
      && typeof data.workUnitId === 'string') return data.workUnitId;
  }
  return undefined;
}

function assistantTextForNonce(items: readonly unknown[], nonce: string): string | undefined {
  const assistant = items.find((item) => {
    const value = record(item);
    return value?.role === 'assistant' && JSON.stringify(item).includes(nonce);
  });
  if (!assistant) return undefined;
  const collect = (value: unknown): string[] => {
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value.flatMap(collect);
    const item = record(value);
    return item ? Object.values(item).flatMap(collect) : [];
  };
  return collect(record(assistant)?.content).join('\n').trim();
}

function terminalContainsAssistant(raw: string, start: number, end: number, assistant: string): boolean {
  const visible = stripTerminalControl(raw.slice(start, end)).replace(/\s+/gu, ' ').trim();
  const answer = assistant.replace(/NONCE=mimi-[a-f0-9]+/gu, '').replace(/\s+/gu, ' ').trim();
  if (answer.length < 20) return false;
  const probe = answer.slice(0, Math.min(80, answer.length));
  return visible.includes(probe);
}

async function activeOutboxForTask(runtime: IsolatedRuntime, taskId: string): Promise<boolean> {
  const value = await mimiJson(runtime, ['daemon', 'outbox', '100']);
  if (!Array.isArray(value)) return true;
  return value.some((item) => {
    const output = record(item);
    return output?.taskId === taskId && ['pending', 'sending'].includes(String(output.status));
  });
}

async function directoryBytes(directory: string): Promise<number> {
  const { stdout } = await execFileAsync('du', ['-sk', directory], { encoding: 'utf8', maxBuffer: 1_000_000 });
  const kibibytes = Number(stdout.trim().split(/\s+/u)[0] ?? 0);
  return Number.isFinite(kibibytes) ? kibibytes * 1024 : Number.MAX_SAFE_INTEGER;
}

function estimatedCost(options: RunnerOptions, usage: AggregateUsage): number | undefined {
  if (options.inputUsdPerMillion === undefined || options.outputUsdPerMillion === undefined) return undefined;
  return (usage.inputTokens / 1_000_000) * options.inputUsdPerMillion
    + (usage.outputTokens / 1_000_000) * options.outputUsdPerMillion;
}

async function enforceDispatchBudget(context: RunContext): Promise<void> {
  if (Date.now() - context.startedAt >= context.options.hardStopMs) {
    context.globalStopReason = '12h hard-stop boundary reached';
  }
  if (Date.now() - context.startedAt >= context.options.stopDispatchMs) {
    context.globalStopReason = '11h30 dispatch boundary reached';
  }
  const atNinetyPercent = (used: number, limit: number | undefined) => limit !== undefined && used >= limit * 0.9;
  if (atNinetyPercent(context.aggregate.inputTokens, context.options.maxInputTokens)) {
    context.globalStopReason = 'input token stop-loss reached 90%';
  }
  if (atNinetyPercent(context.aggregate.outputTokens, context.options.maxOutputTokens)) {
    context.globalStopReason = 'output token stop-loss reached 90%';
  }
  context.aggregate.estimatedUsd = estimatedCost(context.options, context.aggregate);
  if (context.options.maxEstimatedUsd !== undefined
    && context.aggregate.estimatedUsd !== undefined
    && context.aggregate.estimatedUsd >= context.options.maxEstimatedUsd * 0.9) {
    context.globalStopReason = 'explicit estimated USD stop-loss reached 90%';
  }
  if (await directoryBytes(context.outputRoot) >= context.options.maxDiskBytes * 0.9) {
    context.globalStopReason = 'disk stop-loss reached 90%';
  }
  if (context.globalStopReason) throw new Error(context.globalStopReason);
}

async function runHeadlessTurn(
  context: RunContext,
  runtime: IsolatedRuntime,
  scenario: ConversationScenario,
  turn: MaterializedTurn,
  sessionId: string,
): Promise<void> {
  await enforceDispatchBudget(context);
  const beforeSourceSnapshot = await captureSourceSnapshot();
  const changedBeforeDispatch = changedSourcePaths(context.sourceSnapshot, beforeSourceSnapshot);
  if (changedBeforeDispatch.length) {
    context.globalStopReason = `P0 source changed before dispatch: ${changedBeforeDispatch.slice(0, 20).join(', ')}`;
    throw new Error(context.globalStopReason);
  }
  const beforeSession = await sessionSnapshot(runtime, sessionId);
  const beforeItems = protocolItems(beforeSession);
  const beforeTrace = await traceSnapshot(runtime, sessionId);
  const beforeRuns = await listRuns(runtime);
  const beforeRunIds = new Set(beforeRuns.map((item) => item.id).filter((id): id is string => Boolean(id)));
  await appendJournal(context.journalFile, {
    kind: 'turn_dispatch_started',
    occurredAt: new Date().toISOString(),
    scenarioId: scenario.scenarioId,
    turn: turn.turn,
    nonce: turn.nonce,
    sessionId,
    evidenceKind: scenario.evidenceKind,
    denominatorEligible: false,
  });
  let cancellationError: string | undefined;
  const capture = await captureCliTurn(
    runtime,
    turn.prompt,
    sessionId,
    context.options.turnTimeoutMs,
    async () => {
      try {
        await cancelTimedOutTask(runtime, sessionId, beforeRunIds, context.options.cancelGraceMs);
      } catch (error) {
        cancellationError = error instanceof Error ? error.message : String(error);
      }
    },
  );
  const redacted = redactTerminalSecrets(capture.output.toString('utf8'), runtime.secrets);
  const normalized = stripTerminalControl(redacted.text);
  const turnDirectory = path.join(context.outputRoot, 'turns', scenario.scenarioId);
  const prefix = `turn-${String(turn.turn).padStart(2, '0')}`;
  const rawFile = path.join(turnDirectory, `${prefix}.terminal.ansi`);
  const normalizedFile = path.join(turnDirectory, `${prefix}.terminal.txt`);
  await Promise.all([
    writeExclusive(rawFile, redacted.text),
    writeExclusive(normalizedFile, normalized),
  ]);
  if (redacted.hits > 0) context.globalStopReason = `P0 secret hit in ${turn.key}`;
  if (capture.overflow) context.globalStopReason = `P0 terminal output overflow in ${turn.key}`;
  if (cancellationError) context.globalStopReason = `P0 cancellation failed in ${turn.key}: ${cancellationError}`;
  if (capture.timedOut && scenario.lane !== 'S') {
    context.globalStopReason = `P0 write/fixture turn became uncertain: ${turn.key}`;
  }

  const afterRuns = await listRuns(runtime);
  const newRuns = afterRuns.filter((item) => item.id && !beforeRunIds.has(item.id) && item.sessionKey === sessionId);
  const summary = newRuns.length === 1 ? newRuns[0] : undefined;
  const run = summary?.id ? await mimiJson(runtime, ['daemon', 'show', 'run', summary.id]) : undefined;
  const task = summary?.taskId
    ? record(await mimiJson(runtime, ['daemon', 'show', 'task', summary.taskId]))
    : undefined;
  const eventId = typeof task?.triggerEventId === 'string' ? task.triggerEventId : '';
  const event = eventId ? await mimiJson(runtime, ['daemon', 'show', 'event', eventId]) : undefined;
  const afterSession = await sessionSnapshot(runtime, sessionId);
  const afterItems = protocolItems(afterSession);
  const sessionDelta = afterItems.slice(beforeItems.length);
  const traces = traceDelta(beforeTrace, await traceSnapshot(runtime, sessionId));
  const currentSourceSnapshot = await captureSourceSnapshot();
  const changedPaths = changedSourcePaths(context.sourceSnapshot, currentSourceSnapshot);
  const sourceTreeChanged = changedPaths.length > 0;
  if (sourceTreeChanged) {
    context.globalStopReason = `P0 source path content changed outside the temporary root during ${turn.key}: ${changedPaths.slice(0, 20).join(', ')}`;
  }
  const pendingTask = !terminalTaskStates.has(String(task?.status));
  const pendingOutbox = summary?.taskId ? await activeOutboxForTask(runtime, summary.taskId) : true;
  const canonicalEvent = event ?? null;
  const canonicalTask = task ?? null;
  const canonicalRun = run ?? null;
  const entityArtifacts = {
    event: await writeEvidenceJson(context.outputRoot, path.join(turnDirectory, `${prefix}.event.json`), canonicalEvent),
    task: await writeEvidenceJson(context.outputRoot, path.join(turnDirectory, `${prefix}.task.json`), canonicalTask),
    run: await writeEvidenceJson(context.outputRoot, path.join(turnDirectory, `${prefix}.daemon-run.json`), canonicalRun),
    session: await writeEvidenceJson(context.outputRoot, path.join(turnDirectory, `${prefix}.session.json`), afterSession),
    trace: await writeEvidenceJson(context.outputRoot, path.join(turnDirectory, `${prefix}.trace.json`), traces),
  };
  const evidence = {
    scenario,
    turn,
    sessionId,
    eventId,
    taskId: summary?.taskId ?? '',
    daemonRunId: summary?.id ?? '',
    runtimeRunId: runtimeRunIdFromTrace(traces),
    cliExitCode: capture.exitCode,
    cliTimedOut: capture.timedOut,
    event: canonicalEvent,
    task: canonicalTask,
    run: canonicalRun,
    sessionSnapshot: afterSession,
    sessionDelta,
    traceDelta: traces,
    expectedAdvertisedTools: [],
    evidenceRoot: context.outputRoot,
    entityArtifacts,
    terminal: {
      rawPath: path.relative(context.outputRoot, rawFile),
      rawSha256: sha256(redacted.text),
      rawBytes: Buffer.byteLength(redacted.text),
      normalizedPath: path.relative(context.outputRoot, normalizedFile),
      normalizedSha256: sha256(normalized),
      normalizedBytes: Buffer.byteLength(normalized),
      normalizedText: normalized,
    },
    // Calibration verifies the transport/protocol oracle only. Scenario-specific
    // semantic oracles remain a formal-soak gate and these turns never count in
    // the requested 3000-turn denominator.
    oraclePassed: context.options.mode === 'calibrate',
    leaks: {
      pendingTask,
      pendingOutbox,
      activeSessionRun: activeSessionRun(afterSession),
      sourceTreeChanged,
    },
  };
  const audit = await auditConversationTurnEvidence(evidence);
  const usage = answerUsage(run);
  context.aggregate.inputTokens += usage.inputTokens;
  context.aggregate.outputTokens += usage.outputTokens;
  if (audit.proven) context.aggregate.provenTurns += 1;
  else context.aggregate.unprovenTurns += 1;
  await appendJournal(context.journalFile, {
    kind: audit.proven ? 'turn_proof' : 'turn_unproven',
    occurredAt: new Date().toISOString(),
    scenarioId: scenario.scenarioId,
    turn: turn.turn,
    nonce: turn.nonce,
    sessionId,
    eventId,
    taskId: summary?.taskId,
    daemonRunId: summary?.id,
    runtimeRunId: evidence.runtimeRunId,
    cli: {
      exitCode: capture.exitCode,
      signal: capture.signal,
      timedOut: capture.timedOut,
      overflow: capture.overflow,
    },
    providerUsage: usage,
    finalizationOutcome: audit.finalizationOutcome,
    toolCalls: audit.toolCalls,
    reasons: audit.reasons,
    evidenceKind: scenario.evidenceKind,
    denominatorEligible: false,
    calibrationOnly: true,
    terminal: {
      rawPath: evidence.terminal.rawPath,
      rawSha256: evidence.terminal.rawSha256,
      rawBytes: evidence.terminal.rawBytes,
      normalizedPath: evidence.terminal.normalizedPath,
      normalizedSha256: evidence.terminal.normalizedSha256,
      normalizedBytes: evidence.terminal.normalizedBytes,
    },
    entityArtifacts,
    leaks: evidence.leaks,
    secretHits: redacted.hits,
  });
  await writeCheckpoint(context);
  if (context.globalStopReason) throw new Error(context.globalStopReason);
  if (!audit.proven) throw new Error(`turn ${turn.key} is unproven: ${audit.reasons.join('; ')}`);
}

function selectedCalibrationScenarios(manifest: ConversationManifest, options: RunnerOptions): ConversationScenario[] {
  let scenarios = manifest.scenarios.filter((scenario) => scenario.entry === 'headless-cli'
    && scenario.unattendedEligible
    && scenario.enabledByDefault
    && (options.lane ? scenario.lane === options.lane : scenario.lane === 'S')
    && scenario.runtimeContract.allowedTools.length === 0
    && scenario.expectedTools.length === 0
    && scenario.expectedToolsAnyOf.length === 0
    && scenario.toolExpectation.mode === 'none');
  if (options.sceneIds.length) {
    const requested = new Set(options.sceneIds);
    scenarios = scenarios.filter((scenario) => requested.has(scenario.scenarioId));
    const missing = options.sceneIds.filter((id) => !scenarios.some((scenario) => scenario.scenarioId === id));
    if (missing.length) throw new Error(`requested scenarios are not eligible for calibration: ${missing.join(', ')}`);
  } else {
    scenarios = scenarios.slice(0, 2);
  }
  if (scenarios.length < 1) throw new Error('no eligible calibration scenarios were selected');
  return scenarios;
}

async function runScenarioCalibration(context: RunContext, scenario: ConversationScenario): Promise<void> {
  const runtime = await startIsolatedRuntime(context, scenario);
  let failed = false;
  const sessionId = `benchmark-${scenario.scenarioId}-${context.manifestDigest.slice(0, 8)}`;
  try {
    const planned = Array.from({ length: context.options.calibrationTurns }, (_, index) => (
      materializeConversationTurn(context.manifest, scenario, index + 1)
    ));
    const journal = await readJournal(context.journalFile);
    const resume = deriveConversationResumeState(planned, journal);
    for (const uncertain of resume.uncertain) {
      await appendJournal(context.journalFile, {
        kind: 'turn_quarantined',
        occurredAt: new Date().toISOString(),
        scenarioId: scenario.scenarioId,
        turn: uncertain.turn,
        nonce: uncertain.nonce,
        reason: 'previous dispatch has no terminal proof; no replay permitted',
        denominatorEligible: false,
      });
    }
    let consecutiveTimeouts = 0;
    for (const turn of resume.pending) {
      if (context.globalStopReason) break;
      try {
        await runHeadlessTurn(context, runtime, scenario, turn, sessionId);
        consecutiveTimeouts = 0;
      } catch (error) {
        failed = true;
        const message = error instanceof Error ? error.message : String(error);
        if (/timed out/iu.test(message)) consecutiveTimeouts += 1;
        if (consecutiveTimeouts >= 2) {
          await appendJournal(context.journalFile, {
            kind: 'scenario_quarantined',
            occurredAt: new Date().toISOString(),
            scenarioId: scenario.scenarioId,
            reason: 'two consecutive infrastructure timeouts',
          });
          break;
        }
        if (context.globalStopReason) throw error;
      }
    }
    if (failed) throw new Error(`scenario ${scenario.scenarioId} has one or more unproven calibration turns`);
  } finally {
    await stopIsolatedRuntime(runtime, true);
    await appendJournal(context.journalFile, {
      kind: 'runtime_retained',
      occurredAt: new Date().toISOString(),
      scenarioId: scenario.scenarioId,
      runtimePath: path.relative(context.outputRoot, runtime.root),
      failed,
      forcedShardKill: runtime.forcedShardKill,
    });
  }
}

async function runWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      await operation(values[index]!);
    }
  });
  await Promise.all(workers);
}

async function runPtySmoke(context: RunContext): Promise<void> {
  const scenario = context.manifest.scenarios.find((item) => item.entry === 'persistent-pty'
    && item.lane === 'S');
  if (!scenario) throw new Error('manifest does not contain an eligible persistent PTY scenario');
  const runtime = await startIsolatedRuntime(context, scenario);
  let passed = false;
  try {
    const sessionId = `benchmark-pty-${context.manifestDigest.slice(0, 8)}`;
    const turns = [1, 2].map((number) => materializeConversationTurn(context.manifest, scenario, number));
    const actions = path.join(runtime.root, 'pty-actions.json');
    const rawFile = path.join(context.outputRoot, 'pty-smoke.terminal.ansi');
    const resultFile = path.join(context.outputRoot, 'pty-smoke.helper.json');
    const normalizedFile = path.join(context.outputRoot, 'pty-smoke.terminal.txt');
    await writeExclusiveJson(actions, [
      ...turns.map((turn) => ({
        kind: 'model_turn',
        text: turn.prompt,
        timeoutMs: context.options.turnTimeoutMs,
      })),
      {
        kind: 'terminal_action',
        text: '/exit',
        waitForExit: true,
        timeoutMs: context.options.cancelGraceMs,
      },
    ]);
    const beforeRuns = await listRuns(runtime);
    const beforeRunIds = new Set(beforeRuns.map((item) => item.id).filter((id): id is string => Boolean(id)));
    const child = await execFileAsync('python3', [
      ptyHelper,
      '--actions', actions,
      '--transcript', rawFile,
      '--result', resultFile,
      '--startup-timeout-ms', '30000',
      '--', process.execPath, mimiEntry,
    ], {
      cwd: runtime.workspace,
      env: { ...runtime.env, MIMI_SESSION: sessionId },
      encoding: 'utf8',
      timeout: turns.length * context.options.turnTimeoutMs + 60_000,
      maxBuffer: 1_000_000,
    }).then(() => ({ exitCode: 0 }), (error: unknown) => ({
      exitCode: Number((error as { code?: number }).code ?? 1),
    }));
    const helper = record(await readJson(resultFile));
    const raw = await readFile(rawFile, 'utf8');
    const normalized = stripTerminalControl(raw);
    await writeExclusive(normalizedFile, normalized);
    const session = await sessionSnapshot(runtime, sessionId);
    const items = protocolItems(session);
    const trace = (await traceSnapshot(runtime, sessionId)).split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as unknown);
    const runs = (await listRuns(runtime)).filter((item) => item.id && !beforeRunIds.has(item.id)
      && item.sessionKey === sessionId);
    const runDetails = await Promise.all(runs.map((run) => mimiJson(runtime, ['daemon', 'show', 'run', run.id!]))) ;
    const actionsResult = Array.isArray(helper?.actions) ? helper.actions.map(record).filter(Boolean) : [];
    const modelActions = actionsResult.filter((item) => item?.kind === 'model_turn');
    const startupObserved = helper?.startupObserved === true;
    const tty = helper?.tty === true && helper?.childTtyChecked === true;
    const assistantTexts = turns.map((turn) => assistantTextForNonce(items, turn.nonce));
    const assistantVisible = modelActions.length === turns.length && modelActions.every((item, index) => {
      const start = typeof item?.startRawOffset === 'number' ? item.startRawOffset : -1;
      const end = typeof item?.endRawOffset === 'number' ? item.endRawOffset : -1;
      const assistant = assistantTexts[index];
      return start >= 0 && end > start && assistant !== undefined
        && terminalContainsAssistant(raw, start, end, assistant);
    });
    const transportChunksObserved = modelActions.length === turns.length && modelActions.every((item) => (
      record(item?.modelRun)?.transportChunksObserved === true
      && record(item?.modelRun)?.promptReadyAfterBusy === true
      && record(item?.modelRun)?.provenTerminal === true
    )) && assistantVisible;
    const noncesInSession = turns.every((turn) => items.some((item) => JSON.stringify(item).includes(turn.nonce)));
    const noncesInTerminal = turns.every((turn) => normalized.includes(turn.nonce));
    const traceStarts = trace.filter((item) => record(item)?.type === 'turn_start').length;
    const traceBindings = trace.filter((item) => record(item)?.type === 'model_binding_event'
      && record(record(item)?.data)?.workUnitKind === 'conversation').length;
    const bindingRunIds = new Set(trace.filter((item) => record(item)?.type === 'model_binding_event'
      && record(record(item)?.data)?.workUnitKind === 'conversation')
      .map((item) => record(record(item)?.data)?.workUnitId)
      .filter((id): id is string => typeof id === 'string'));
    const toolSurfaces = trace.filter((item) => record(item)?.type === 'model_tool_surface');
    const emptyToolDigest = `sha256:${sha256(JSON.stringify([]))}`;
    const toolSurfaceProven = toolSurfaces.length === turns.length && toolSurfaces.every((item) => {
      const entry = record(item);
      const data = record(entry?.data);
      return entry?.sessionId === sessionId
        && data?.phase === 'before_model_dispatch'
        && typeof data.runId === 'string'
        && bindingRunIds.has(data.runId)
        && Array.isArray(data.advertisedTools)
        && data.advertisedTools.length === 0
        && data.advertisedToolCount === 0
        && data.toolSetDigest === emptyToolDigest;
    });
    const traceEnds = trace.filter((item) => record(item)?.type === 'turn_end').length;
    const usage = runDetails.map(answerUsage);
    const usageProven = usage.length === turns.length
      && usage.every((item) => item.inputTokens > 0 && item.outputTokens > 0);
    const secretHits = typeof helper?.secretHits === 'number' ? helper.secretHits : 1;
    passed = child.exitCode === 0
      && helper?.passed === true
      && tty
      && startupObserved
      && transportChunksObserved
      && noncesInSession
      && noncesInTerminal
      && traceStarts >= turns.length
      && traceBindings >= turns.length
      && toolSurfaceProven
      && traceEnds >= turns.length
      && usageProven
      && modelActions.every((item) => runs.some((run) => run.id === record(item?.modelRun)?.daemonRunId))
      && secretHits === 0
      && !activeSessionRun(session);
    await appendJournal(context.journalFile, {
      kind: 'pty_smoke',
      occurredAt: new Date().toISOString(),
      scenarioId: scenario.scenarioId,
      turns: turns.map((turn) => ({ turn: turn.turn, nonce: turn.nonce })),
      sessionId,
      tty,
      startupObserved,
      transportChunksObserved,
      assistantOutputVisibleAfterInputEcho: assistantVisible,
      cliExitCode: child.exitCode,
      runCount: runs.length,
      usageProven,
      trace: {
        starts: traceStarts,
        bindings: traceBindings,
        toolSurfaces: toolSurfaces.length,
        toolSurfaceProven,
        ends: traceEnds,
      },
      noncesInSession,
      noncesInTerminal,
      activeSessionRun: activeSessionRun(session),
      secretHits,
      rawTerminal: {
        path: path.relative(context.outputRoot, rawFile),
        sha256: sha256(raw),
      },
      normalizedTerminal: {
        path: path.relative(context.outputRoot, normalizedFile),
        sha256: sha256(normalized),
      },
      passed,
      denominatorEligible: false,
    });
    await writeExclusiveJson(path.join(context.outputRoot, 'pty-smoke.proof.json'), {
      schemaVersion: 1,
      kind: 'persistent-pty-prerequisite',
      manifestDigest: context.manifestDigest,
      buildDigest: context.buildDigest,
      passed,
      tty,
      startupObserved,
      transportChunksObserved,
      assistantOutputVisibleAfterInputEcho: assistantVisible,
      exitCode: child.exitCode,
      turns: turns.length,
      generatedAt: new Date().toISOString(),
    });
    if (!passed) throw new Error('persistent PTY smoke did not satisfy its proof contract');
  } finally {
    await stopIsolatedRuntime(runtime, true);
  }
}

async function verifyPtyPrerequisite(context: RunContext): Promise<void> {
  if (!context.options.ptyEvidence) throw new Error('formal soak requires --pty-evidence from pty-smoke mode');
  const proof = record(await readJson(context.options.ptyEvidence));
  if (proof?.kind !== 'persistent-pty-prerequisite'
    || proof.passed !== true
    || proof.tty !== true
    || proof.manifestDigest !== context.manifestDigest
    || proof.buildDigest !== context.buildDigest) {
    throw new Error('PTY prerequisite is missing, failed, or belongs to a different manifest/build');
  }
}

async function initializeRun(
  options: RunnerOptions,
  manifest: ConversationManifest,
  manifestRaw: string,
): Promise<RunContext> {
  const manifestDigest = sha256(manifestRaw);
  const runName = `mimi-conversation-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${manifestDigest.slice(0, 8)}`;
  const outputRoot = options.output ?? path.join(os.tmpdir(), runName);
  const journalFile = path.join(outputRoot, 'evidence.jsonl');
  const checkpointFile = path.join(outputRoot, 'checkpoint.json');
  if (!options.resume) {
    await mkdir(outputRoot, { recursive: false, mode: 0o700 });
    await chmod(outputRoot, 0o700);
    await writeExclusive(path.join(outputRoot, 'manifest.json'), manifestRaw);
  } else {
    const metadata = record(await readJson(path.join(outputRoot, 'run.json')));
    if (metadata?.manifestDigest !== manifestDigest) throw new Error('resume manifest digest does not match');
  }
  let buildDigest = 'not-built';
  if (options.mode !== 'validate') {
    if (process.env.MIMI_CONVERSATION_CONFIRM_REAL_PROVIDER !== 'YES') {
      throw new Error('real Provider execution requires MIMI_CONVERSATION_CONFIRM_REAL_PROVIDER=YES');
    }
    if (options.maxInputTokens === undefined || options.maxOutputTokens === undefined
      || options.maxEstimatedUsd === undefined
      || options.inputUsdPerMillion === undefined || options.outputUsdPerMillion === undefined) {
      throw new Error([
        'real Provider calibration requires explicit input/output token caps,',
        'an estimated USD cap, and explicit input/output USD-per-million ceiling rates',
      ].join(' '));
    }
    if (!options.skipBuild) buildDigest = await cleanBuild(outputRoot, options.manifestFile);
    else {
      if (!await exists(mimiEntry)) throw new Error('--skip-build requires dist/index.js');
      buildDigest = await runtimeClosureDigest(
        await digestTree(path.join(repositoryRoot, 'dist')),
        options.manifestFile,
      );
    }
  }
  const sourceSnapshot = await captureSourceSnapshot();
  const context: RunContext = {
    options,
    manifest,
    manifestDigest,
    outputRoot,
    journalFile,
    checkpointFile,
    buildDigest,
    sourceSnapshot,
    startedAt: Date.now(),
    aggregate: { inputTokens: 0, outputTokens: 0, provenTurns: 0, unprovenTurns: 0 },
  };
  if (!options.resume) {
    await writeExclusiveJson(path.join(outputRoot, 'run.json'), {
      schemaVersion: 1,
      kind: 'mimi-real-terminal-conversation-benchmark',
      mode: options.mode,
      manifestDigest,
      buildDigest,
      seed: manifest.seed,
      startedAt: new Date(context.startedAt).toISOString(),
      requestedConcurrency: options.concurrency,
      turnTimeoutMs: options.turnTimeoutMs,
      toolTimeoutMs: options.toolTimeoutMs,
      stopDispatchMs: options.stopDispatchMs,
      hardStopMs: options.hardStopMs,
      costBudgetConfigured: options.maxEstimatedUsd !== undefined
        && options.inputUsdPerMillion !== undefined
        && options.outputUsdPerMillion !== undefined,
      denominatorEligible: false,
      note: 'validate/calibration/PTY-smoke skeleton; no turn is counted toward the formal 3000-turn denominator',
    });
    await appendJournal(journalFile, {
      kind: 'run_started',
      occurredAt: new Date().toISOString(),
      mode: options.mode,
      manifestDigest,
      buildDigest,
      seed: manifest.seed,
    });
  }
  return context;
}

async function main(): Promise<void> {
  const options = parseOptions();
  const manifestRaw = await readFile(options.manifestFile, 'utf8');
  const manifest = parseConversationManifest(JSON.parse(manifestRaw) as unknown);
  if (options.mode === 'validate') {
    process.stdout.write(`${JSON.stringify({
      valid: true,
      manifest: options.manifestFile,
      digest: sha256(manifestRaw),
      scenarios: manifest.scenarios.length,
      turns: manifest.scenarios.reduce((total, scenario) => total + scenario.turnCount, 0),
      suites: new Set(manifest.scenarios.map((scenario) => scenario.suite)).size,
      unattendedDisabled: manifest.scenarios
        .filter((scenario) => scenario.lane === 'V' || scenario.lane === 'L').length,
      realProviderTurnsExecuted: 0,
      calibrationGate: 'GO only for isolated S-lane no-tools calibration with pre-dispatch Trace receipt',
      formalExecutionGate: 'NO-GO: fixture/action/oracle execution and resumable 100x30 proof remain incomplete',
    }, null, 2)}\n`);
    return;
  }
  if (options.mode === 'soak') {
    throw new Error([
      'formal 100x30 dispatch remains fail-closed:',
      'persistent scenario actions, fixture setup receipts, semantic state oracles, and resumable aggregate proof are incomplete.',
      'No formal turn was dispatched or counted.',
    ].join(' '));
  }
  if (options.resume) {
    throw new Error('real calibration resume remains disabled until aggregate/start/build continuity is fully restored');
  }
  if (options.lane && options.lane !== 'S') {
    throw new Error('only S-lane no-tools calibration is enabled; W/F/V/L remain fail-closed');
  }
  const context = await initializeRun(options, manifest, manifestRaw);
  try {
    if (options.mode === 'pty-smoke') {
      await runPtySmoke(context);
    } else if (options.mode === 'calibrate') {
      const scenarios = selectedCalibrationScenarios(manifest, options);
      await runWithConcurrency(scenarios, options.concurrency, (scenario) => (
        runScenarioCalibration(context, scenario)
      ));
      const requestedTurns = scenarios.length * options.calibrationTurns;
      if (context.aggregate.provenTurns !== requestedTurns || context.aggregate.unprovenTurns !== 0) {
        throw new Error(
          `calibration proof mismatch: requested=${requestedTurns} proven=${context.aggregate.provenTurns} unproven=${context.aggregate.unprovenTurns}`,
        );
      }
    } else {
      await verifyPtyPrerequisite(context);
    }
    await appendJournal(context.journalFile, {
      kind: 'run_finished',
      occurredAt: new Date().toISOString(),
      aggregate: context.aggregate,
      globalStopReason: context.globalStopReason,
      denominatorEligible: false,
    });
  } finally {
    await writeCheckpoint(context);
  }
  process.stdout.write(`${JSON.stringify({
    output: context.outputRoot,
    mode: options.mode,
    aggregate: context.aggregate,
    formalDenominatorTurns: 0,
    realProviderCalibrationExecuted: true,
  }, null, 2)}\n`);
}

await main();
