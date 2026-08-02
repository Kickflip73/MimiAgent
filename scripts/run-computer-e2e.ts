import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CuaDriverClient } from '../src/extensions/computer/cua-driver-client.js';
import { ComputerManager, type ComputerRunAuthority } from '../src/extensions/computer/manager.js';
import type {
  ComputerConfig,
  ComputerActInput,
  ComputerElement,
  ComputerTargetSummary,
} from '../src/extensions/computer/types.js';

const execFileAsync = promisify(execFile);
const CALCULATOR_BUNDLE = 'com.apple.calculator';
const TEXTEDIT_BUNDLE = 'com.apple.TextEdit';
const iterations = integerEnvironment('MIMI_E2E_ITERATIONS', 10, 1, 100);
const driverCommand = process.env.MIMI_CUA_DRIVER_COMMAND ?? 'cua-driver';
const scenarioNames = new Set(['calculator', 'textedit'] as const);
const scenarios = new Set(
  (process.env.MIMI_COMPUTER_SCENARIOS ?? 'calculator,textedit')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
);
if (!scenarios.size || [...scenarios].some((scenario) => !scenarioNames.has(scenario as 'calculator' | 'textedit'))) {
  throw new Error('MIMI_COMPUTER_SCENARIOS must contain calculator and/or textedit');
}

interface PublicObservation {
  observationId: string;
  target?: ComputerTargetSummary;
  elements?: ComputerElement[];
  data?: unknown;
  screenshot?: { data: string; mediaType: string };
  truncated?: boolean;
  actionable?: boolean;
  blockedReason?: string;
}

interface IterationResult {
  iteration: number;
  success: boolean;
  durationMs: number;
  p95ObservationBytes: number;
  sessionLeak: boolean;
  foregroundChanged: boolean;
  cursorChanged: boolean;
  foregroundEvidenceUnavailable: boolean;
  cursorEvidenceUnavailable: boolean;
  cursorTransitions: Array<{
    action: string;
    before: { x: number; y: number };
    after: { x: number; y: number };
  }>;
  verifiedStates: string[];
  error?: string;
}

interface ActionEvidence {
  cursorChanged: boolean;
  foregroundChanged: boolean;
  foregroundEvidenceUnavailable: boolean;
  cursorEvidenceUnavailable: boolean;
  cursorTransitions: Array<{
    action: string;
    before: { x: number; y: number };
    after: { x: number; y: number };
  }>;
}

function integerEnvironment(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function percentile(values: readonly number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
}

function normalize(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u200e\u200f\u202a-\u202e]/g, '')
    .trim()
    .toLowerCase();
}

async function waitUntil<T>(
  operation: () => Promise<T | undefined>,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`condition timed out${lastError ? `: ${errorText(lastError)}` : ''}`);
}

async function frontmostBundle(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('/usr/bin/osascript', [
      '-e',
      'tell application "System Events" to get bundle identifier of first application process whose frontmost is true',
    ], { encoding: 'utf8', timeout: 5_000 });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function cursorPosition(): Promise<{ x: number; y: number } | undefined> {
  try {
    const { stdout } = await execFileAsync(driverCommand, [
      'call', 'get_cursor_position', '{}',
    ], { encoding: 'utf8', timeout: 5_000, maxBuffer: 64 * 1024 });
    const value = JSON.parse(stdout) as Record<string, unknown>;
    return typeof value.x === 'number' && typeof value.y === 'number'
      ? { x: value.x, y: value.y }
      : undefined;
  } catch {
    return undefined;
  }
}

async function exactTarget(
  backend: CuaDriverClient,
  bundleId: string,
  excludedPids: ReadonlySet<number>,
  title?: string,
): Promise<ComputerTargetSummary> {
  return waitUntil(async () => {
    const candidates = await backend.listTargets({ query: bundleId, limit: 50 });
    return candidates.find((candidate) => candidate.bundleId === bundleId
      && !excludedPids.has(candidate.pid)
      && (!title || normalize(candidate.title).includes(normalize(title))));
  }, 15_000);
}

async function observeWindow(
  manager: ComputerManager,
  authority: ComputerRunAuthority,
  target: ComputerTargetSummary,
  observationBytes: number[],
  includeScreenshot = false,
): Promise<PublicObservation> {
  const result = await manager.observeTarget(authority, target, includeScreenshot) as PublicObservation;
  const { screenshot: _screenshot, ...semanticResult } = result;
  const bytes = Buffer.byteLength(JSON.stringify(semanticResult));
  observationBytes.push(bytes);
  if (bytes > 16 * 1024) throw new Error(`Computer observation exceeded 16 KiB: ${bytes}`);
  if (result.actionable !== true) {
    throw new Error(result.blockedReason ?? 'Computer observation is not actionable');
  }
  return result;
}

async function recognizeScreenshot(
  screenshot: NonNullable<PublicObservation['screenshot']>,
  directory: string,
  iteration: number,
): Promise<string> {
  if (screenshot.mediaType !== 'image/png') {
    throw new Error(`unsupported Calculator screenshot type: ${screenshot.mediaType}`);
  }
  const imagePath = path.join(directory, `calculator-${iteration}.png`);
  await writeFile(imagePath, Buffer.from(screenshot.data, 'base64'));
  const helper = fileURLToPath(new URL('../examples/connectors/macos-screen-ocr.swift', import.meta.url));
  const { stdout } = await execFileAsync('/usr/bin/swift', [
    helper,
    imagePath,
    '4000',
    '200',
    'accurate',
    'en-US,zh-Hans',
  ], { encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024 });
  const result = JSON.parse(stdout) as { text?: unknown };
  return typeof result.text === 'string' ? result.text : '';
}

async function backgroundAction(
  manager: ComputerManager,
  authority: ComputerRunAuthority,
  input: ComputerActInput,
  evidence: ActionEvidence,
): Promise<unknown> {
  const beforeFrontmost = await frontmostBundle();
  const beforeCursor = await cursorPosition();
  if (beforeFrontmost === undefined) evidence.foregroundEvidenceUnavailable = true;
  if (beforeCursor === undefined) evidence.cursorEvidenceUnavailable = true;
  if (beforeFrontmost === undefined || beforeCursor === undefined) {
    throw new Error('Computer safety evidence was unavailable before the action');
  }
  const result = await manager.act(authority, input);
  const afterCursor = await cursorPosition();
  const afterFrontmost = await frontmostBundle();
  if (afterFrontmost === undefined) evidence.foregroundEvidenceUnavailable = true;
  if (afterCursor === undefined) evidence.cursorEvidenceUnavailable = true;
  if (afterFrontmost === undefined || afterCursor === undefined) {
    throw new Error('Computer safety evidence was unavailable after the action');
  }
  if (beforeCursor.x !== afterCursor.x || beforeCursor.y !== afterCursor.y) {
    evidence.cursorTransitions.push({
      action: input.action.type,
      before: beforeCursor,
      after: afterCursor,
    });
    const action = input.action;
    const couldMovePhysicalCursor = action.type === 'drag'
      || (action.type === 'move_cursor' && action.scope === 'desktop')
      || (['click', 'double_click', 'type_text', 'scroll'].includes(action.type)
        && 'x' in action && action.x !== undefined);
    if (couldMovePhysicalCursor) evidence.cursorChanged = true;
  }
  if (beforeFrontmost !== afterFrontmost
    && input.action.type === 'launch_app'
    && input.action.bundleId === afterFrontmost) {
    evidence.foregroundChanged = true;
  }
  return result;
}

async function pressKey(
  manager: ComputerManager,
  authority: ComputerRunAuthority,
  target: ComputerTargetSummary,
  keys: string[],
  observationBytes: number[],
  evidence: ActionEvidence,
): Promise<void> {
  try {
    const observation = await observeWindow(manager, authority, target, observationBytes);
    await backgroundAction(manager, authority, {
      observationId: observation.observationId,
      action: { type: 'keypress', keys, dispatch: 'background' },
    }, evidence);
  } catch (error) {
    throw new Error(`Calculator key ${JSON.stringify(keys)} failed: ${errorText(error)}`, { cause: error });
  }
}

const managerBackendMap = new WeakMap<ComputerManager, CuaDriverClient>();

function managerBackend(manager: ComputerManager): CuaDriverClient {
  const backend = managerBackendMap.get(manager);
  if (!backend) throw new Error('ComputerManager backend was not registered');
  return backend;
}

async function cleanupTarget(
  manager: ComputerManager,
  authority: ComputerRunAuthority,
  target: ComputerTargetSummary | undefined,
  evidence: ActionEvidence,
): Promise<void> {
  if (!target) return;
  const existing = (await managerBackend(manager).listTargets({ query: target.bundleId, limit: 50 }))
    .find((candidate) => candidate.pid === target.pid);
  if (!existing) return;
  try {
    await backgroundAction(manager, { ...authority, access: 'admin' }, {
      action: { type: 'kill_app', pid: target.pid, reason: 'Mimi Computer E2E emergency cleanup' },
    }, evidence);
  } catch (error) {
    const remaining = await managerBackend(manager).listTargets({ query: target.bundleId, limit: 50 });
    if (!remaining.some((candidate) => candidate.pid === target.pid)) return;
    throw error;
  }
  await waitUntil(async () => {
    const remaining = await managerBackend(manager).listTargets({ query: target.bundleId, limit: 50 });
    return remaining.some((candidate) => candidate.pid === target.pid) ? undefined : true;
  }, 5_000);
}

async function runCalculator(
  manager: ComputerManager,
  backend: CuaDriverClient,
  authority: ComputerRunAuthority,
  observationBytes: number[],
  verifiedStates: string[],
  directory: string,
  iteration: number,
  onTarget: (target: ComputerTargetSummary) => void,
  evidence: ActionEvidence,
): Promise<ComputerTargetSummary | undefined> {
  const existing = new Set((await backend.listTargets({ query: CALCULATOR_BUNDLE, limit: 50 })).map((target) => target.pid));
  try {
    await backgroundAction(manager, authority, {
      action: { type: 'launch_app', bundleId: CALCULATOR_BUNDLE, urls: [], newInstance: true },
    }, evidence);
  } catch (error) {
    throw new Error(`Calculator launch failed: ${errorText(error)}`, { cause: error });
  }
  const target = await exactTarget(backend, CALCULATOR_BUNDLE, existing);
  onTarget(target);
  if (target.frontmost !== false) throw new Error('Calculator test window is frontmost or focus state is unknown');
  await pressKey(manager, authority, target, ['7'], observationBytes, evidence);
  await pressKey(manager, authority, target, ['SHIFT', '8'], observationBytes, evidence);
  await pressKey(manager, authority, target, ['8'], observationBytes, evidence);
  await pressKey(manager, authority, target, ['ENTER'], observationBytes, evidence);
  const result = await observeWindow(manager, authority, target, observationBytes, true);
  const semantic = JSON.stringify(result.data);
  const recognized = result.screenshot
    ? await recognizeScreenshot(result.screenshot, directory, iteration)
    : '';
  if (!/(?:display[^\n]*56|\b56\b)/i.test(`${semantic}\n${recognized}`)) {
    throw new Error(`Calculator verification did not observe 56: semantic=${semantic} ocr=${recognized}`);
  }
  verifiedStates.push(result.screenshot ? 'calculator:56:vision' : 'calculator:56:ax');
  return target;
}

async function runTextEdit(
  manager: ComputerManager,
  backend: CuaDriverClient,
  authority: ComputerRunAuthority,
  observationBytes: number[],
  verifiedStates: string[],
  directory: string,
  iteration: number,
  onTarget: (target: ComputerTargetSummary) => void,
  evidence: ActionEvidence,
): Promise<ComputerTargetSummary | undefined> {
  const existing = new Set((await backend.listTargets({ query: TEXTEDIT_BUNDLE, limit: 50 })).map((target) => target.pid));
  const file = path.join(directory, `mimi-computer-e2e-${iteration}.txt`);
  const initial = `Mimi TextEdit fixture ${iteration}`;
  const expected = `${initial}\nVerified by Mimi ${iteration}`;
  await writeFile(file, initial, 'utf8');
  try {
    await backgroundAction(manager, authority, {
      action: {
        type: 'launch_app',
        bundleId: TEXTEDIT_BUNDLE,
        urls: [pathToFileURL(file).toString()],
        newInstance: true,
      },
    }, evidence);
  } catch (error) {
    throw new Error(`TextEdit launch failed: ${errorText(error)}`, { cause: error });
  }
  const target = await exactTarget(backend, TEXTEDIT_BUNDLE, existing, path.basename(file));
  onTarget(target);
  if (target.frontmost !== false) throw new Error('TextEdit test window is frontmost or focus state is unknown');
  const observation = await observeWindow(manager, authority, target, observationBytes);
  if (!JSON.stringify(observation.data).includes(initial)) {
    throw new Error(`TextEdit initial content was not observable: ${JSON.stringify(observation.data)}`);
  }
  const editor = observation.elements?.find((element) => /text(?:area|view|field)/i.test(element.role));
  if (!editor) throw new Error(`TextEdit writable AX element not found: ${JSON.stringify(observation.elements?.slice(0, 40))}`);
  try {
    await backgroundAction(manager, authority, {
      observationId: observation.observationId,
      action: {
        type: 'set_value',
        elementIndex: editor.index,
        value: expected,
      },
    }, evidence);
  } catch (error) {
    throw new Error(`TextEdit set_value failed: ${errorText(error)}`, { cause: error });
  }
  const changed = await observeWindow(manager, authority, target, observationBytes);
  if (!JSON.stringify(changed.data).includes(`Verified by Mimi ${iteration}`)) {
    throw new Error(`TextEdit updated content was not observable: ${JSON.stringify(changed.data)}`);
  }
  verifiedStates.push('textedit:read-write-observe');
  return target;
}

async function runIteration(
  manager: ComputerManager,
  backend: CuaDriverClient,
  directory: string,
  iteration: number,
): Promise<IterationResult> {
  const started = Date.now();
  const runId = `computer-e2e-${iteration}`;
  const authority: ComputerRunAuthority = {
    runId,
    access: 'background',
    allowedApps: [CALCULATOR_BUNDLE, TEXTEDIT_BUNDLE],
    supportsImageInput: true,
  };
  const observations: number[] = [];
  const verifiedStates: string[] = [];
  const actionEvidence: ActionEvidence = {
    cursorChanged: false,
    foregroundChanged: false,
    foregroundEvidenceUnavailable: false,
    cursorEvidenceUnavailable: false,
    cursorTransitions: [],
  };
  let calculatorTarget: ComputerTargetSummary | undefined;
  let textEditTarget: ComputerTargetSummary | undefined;
  let failure: string | undefined;
  try {
    if (scenarios.has('calculator')) {
      calculatorTarget = await runCalculator(
        manager,
        backend,
        authority,
        observations,
        verifiedStates,
        directory,
        iteration,
        (target) => { calculatorTarget = target; },
        actionEvidence,
      );
    }
    if (scenarios.has('textedit')) {
      textEditTarget = await runTextEdit(
        manager,
        backend,
        authority,
        observations,
        verifiedStates,
        directory,
        iteration,
        (target) => { textEditTarget = target; },
        actionEvidence,
      );
    }
  } catch (error) {
    failure = errorText(error);
  } finally {
    await cleanupTarget(manager, authority, calculatorTarget, actionEvidence).catch((error) => {
      failure ??= `Calculator cleanup failed: ${errorText(error)}`;
    });
    await cleanupTarget(manager, authority, textEditTarget, actionEvidence).catch((error) => {
      failure ??= `TextEdit cleanup failed: ${errorText(error)}`;
    });
    await manager.endRun(runId).catch((error) => {
      failure ??= `session cleanup failed: ${errorText(error)}`;
    });
  }
  const foregroundChanged = actionEvidence.foregroundChanged;
  if (foregroundChanged) failure ??= 'frontmost application changed during a background Computer action';
  const cursorChanged = actionEvidence.cursorChanged;
  if (cursorChanged) failure ??= 'physical cursor moved during a background Computer action';
  if (actionEvidence.foregroundEvidenceUnavailable) {
    failure ??= 'frontmost application evidence was unavailable during a Computer action';
  }
  if (actionEvidence.cursorEvidenceUnavailable) {
    failure ??= 'cursor evidence was unavailable during a Computer action';
  }
  const sessionLeak = manager.status().activeSessions !== 0;
  if (sessionLeak) failure ??= `ComputerManager retained ${manager.status().activeSessions} sessions`;
  return {
    iteration,
    success: failure === undefined,
    durationMs: Date.now() - started,
    p95ObservationBytes: percentile(observations, 0.95),
    sessionLeak,
    foregroundChanged,
    cursorChanged,
    foregroundEvidenceUnavailable: actionEvidence.foregroundEvidenceUnavailable,
    cursorEvidenceUnavailable: actionEvidence.cursorEvidenceUnavailable,
    cursorTransitions: actionEvidence.cursorTransitions,
    verifiedStates,
    ...(failure ? { error: failure } : {}),
  };
}

const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'mimi-computer-e2e-'));
const config: ComputerConfig = {
  backend: 'cua',
  driverCommand,
  actionTimeoutMs: integerEnvironment('MIMI_COMPUTER_ACTION_TIMEOUT_MS', 30_000, 1_000, 300_000),
  maxActionsPerRun: 50,
  maxScreenshotsPerRun: 12,
  pauseWhenTargetFrontmost: true,
  defaultAccess: 'background',
  foregroundLeaseSeconds: 30,
  artifactMaxBytes: 16 * 1024 * 1024,
};
const backend = new CuaDriverClient(config.driverCommand, config.actionTimeoutMs);
const manager = new ComputerManager(config, backend, dataRoot);
managerBackendMap.set(manager, backend);
const results: IterationResult[] = [];
try {
  await backend.health();
  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    const result = await runIteration(manager, backend, dataRoot, iteration);
    results.push(result);
    process.stderr.write(`[computer-e2e] ${iteration}/${iterations} ${result.success ? 'pass' : 'fail'} ${result.durationMs}ms${result.error ? `: ${result.error}` : ''}\n`);
  }
} finally {
  await manager.close().catch(() => undefined);
  await rm(dataRoot, { recursive: true, force: true });
}

const successes = results.filter((result) => result.success).length;
const report = {
  schemaVersion: 1,
  kind: 'mimi-computer-real-e2e',
  scenarios: [...scenarios],
  iterations,
  successes,
  successRate: iterations ? successes / iterations : 0,
  medianDurationMs: percentile(results.map((result) => result.durationMs), 0.5),
  p95DurationMs: percentile(results.map((result) => result.durationMs), 0.95),
  p95ObservationBytes: percentile(results.map((result) => result.p95ObservationBytes), 0.95),
  sessionLeaks: results.filter((result) => result.sessionLeak).length,
  foregroundChanges: results.filter((result) => result.foregroundChanged).length,
  cursorChanges: results.filter((result) => result.cursorChanged).length,
  foregroundEvidenceUnavailable: results.filter((result) => result.foregroundEvidenceUnavailable).length,
  cursorEvidenceUnavailable: results.filter((result) => result.cursorEvidenceUnavailable).length,
  results,
};
process.stdout.write(`${JSON.stringify(report)}\n`);
if (successes !== iterations
  || report.sessionLeaks !== 0
  || report.foregroundChanges !== 0
  || report.cursorChanges !== 0
  || report.foregroundEvidenceUnavailable !== 0
  || report.cursorEvidenceUnavailable !== 0
  || report.p95ObservationBytes > 16 * 1024) process.exitCode = 1;
