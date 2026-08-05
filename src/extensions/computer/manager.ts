import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ActionFailedSafeError } from '../../core/action-intent.js';
import { withExclusiveFileLock } from '../../core/state-file.js';
import type {
  BackendObservation,
  BackendSession,
  ComputerAccess,
  ComputerActInput,
  ComputerBackend,
  ComputerConfig,
  ComputerElement,
  ComputerAction,
  ComputerObserveInput,
  ComputerTargetSummary,
} from './types.js';
import { computerActInputSchema, ComputerActionUncertainError } from './types.js';
import { ComputerArtifactStore } from './artifact-store.js';

const ACCESS_LEVEL: Record<ComputerAccess, number> = {
  none: 0, observe: 1, background: 2, foreground: 3, admin: 4,
};
const OBSERVATION_TTL_MS = 30_000;
const MAX_MODEL_OBSERVATION_BYTES = 16 * 1024;
const MAX_SEMANTIC_TEXT_CHARS = 8_000;
const DEFAULT_MODEL_ELEMENTS = 40;
const AX_WINDOW_SETTLE_ATTEMPTS = 20;

export interface ComputerRunAuthority {
  runId: string;
  access: ComputerAccess;
  allowedApps?: readonly string[];
  deniedApps?: readonly string[];
  supportsImageInput?: boolean;
}

export interface ComputerReadProbeReceipt {
  boundary: 'computer_manager';
  effect: 'read';
  registered: true;
  ready: true;
  fresh: true;
  targetVerified: true;
  actionResult: true;
  target: Pick<ComputerTargetSummary, 'bundleId' | 'pid' | 'windowId'>;
}

export interface ComputerManagerStatus {
  configured: true;
  backend: ComputerBackend['kind'];
  strategy: 'background-preferred';
  defaultAccess: ComputerAccess;
  activeSessions: number;
  foregroundLeaseActive: boolean;
  operationalReadiness: 'unknown' | 'ready' | 'degraded';
  operationalCheckedAt?: string;
  lastOperationalFailure?: string;
}

export interface ComputerHostObservation {
  observationId: string;
  target: ComputerTargetSummary;
  frontmost?: boolean;
  dimensions: { width: number; height: number };
  elements: readonly ComputerElement[];
  truncated: boolean;
}

const PROTECTED_CONTROL_PLANE_APPS = new Set([
  'com.googlecode.iterm2',
  'com.microsoft.VSCode',
  'com.openai.codex',
]);

const OBSERVE_ONLY_CONTROL_PLANE_APPS = new Set([
  'com.apple.Terminal',
]);

const PROTECTED_CONTROL_PLANE_PREFIXES = [
  'com.jetbrains.',
];

interface StoredObservation extends BackendObservation {
  id: string;
  runId: string;
  capturedAt: number;
  expiresAt: number;
  valid: boolean;
  actionable: boolean;
  blockedReason?: string;
}

interface RunState {
  session?: BackendSession;
  observations: Map<string, StoredObservation>;
  preferredTargets: Map<string, ComputerTargetSummary>;
  actions: number;
  screenshots: number;
  foregroundRestore?: {
    target: ComputerTargetSummary;
    timer: ReturnType<typeof setTimeout>;
  };
  activeArtifactId?: string;
}

function targetKey(target: Pick<ComputerTargetSummary, 'pid' | 'windowId'>): string {
  return `${target.pid}:${target.windowId}`;
}

function launchedDocumentName(urls: readonly string[] | undefined): string | undefined {
  for (const value of urls ?? []) {
    try {
      const name = path.basename(decodeURIComponent(new URL(value).pathname));
      if (name) return name.normalize('NFKC').toLowerCase();
    } catch {
      continue;
    }
  }
  return undefined;
}

function requiresAccess(input: ComputerObserveInput | ComputerActInput): ComputerAccess {
  if ('scope' in input) return input.scope === 'desktop' ? 'foreground' : 'observe';
  const action = input.action;
  if (action.type === 'move_cursor') return action.scope === 'desktop' ? 'foreground' : 'background';
  if (['kill_app', 'start_recording', 'stop_recording', 'replay_trajectory', 'set_driver_config', 'set_agent_cursor', 'request_permissions'].includes(action.type)) return 'admin';
  if (['escalate_session', 'bring_to_front', 'handoff_to_user', 'release_foreground'].includes(action.type)) return 'foreground';
  if ('dispatch' in action && action.dispatch === 'foreground') return 'foreground';
  return 'background';
}

function hasAccess(actual: ComputerAccess, required: ComputerAccess): boolean {
  return ACCESS_LEVEL[actual] >= ACCESS_LEVEL[required];
}

function actionCoordinates(action: ComputerActInput['action']): Array<{ x: number; y: number }> {
  if (action.type === 'click' && action.x !== undefined && action.y !== undefined) return [{ x: action.x, y: action.y }];
  if (action.type === 'double_click' && action.x !== undefined && action.y !== undefined) return [{ x: action.x, y: action.y }];
  if (action.type === 'type_text' && action.x !== undefined && action.y !== undefined) return [{ x: action.x, y: action.y }];
  if (action.type === 'scroll' && action.x !== undefined && action.y !== undefined) return [{ x: action.x, y: action.y }];
  if (action.type === 'drag') return action.path;
  return [];
}

function withForegroundDelivery(input: ComputerActInput): ComputerActInput {
  if (!('dispatch' in input.action)) return input;
  return computerActInputSchema.parse({
    ...input,
    action: { ...input.action, dispatch: 'foreground' },
  });
}

function actionElement(action: ComputerActInput['action'], observation: StoredObservation): ComputerElement | undefined {
  if (!('elementIndex' in action) || action.elementIndex === undefined) return undefined;
  const element = observation.elements?.find((candidate) => candidate.index === action.elementIndex);
  if (!element) throw new Error(`Observation 中不存在 elementIndex ${action.elementIndex}`);
  if (action.type === 'type_text' && element.secure) throw new Error('拒绝向 secure/password field 输入文本');
  if (action.type === 'set_value' && element.writable !== true) throw new Error('目标元素未声明 value 可写');
  return element;
}

function compactObservationData(data: unknown): unknown {
  if (typeof data === 'string') return data.slice(0, MAX_SEMANTIC_TEXT_CHARS);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const value = data as Record<string, unknown>;
  if (typeof value.semanticText === 'string') {
    return {
      semanticText: value.semanticText.slice(0, MAX_SEMANTIC_TEXT_CHARS),
      ...(typeof value.sourceElementCount === 'number'
        ? { sourceElementCount: value.sourceElementCount }
        : {}),
      ...(typeof value.visibleElementCount === 'number'
        ? { visibleElementCount: value.visibleElementCount }
        : {}),
      ...(value.degraded === true ? { degraded: true } : {}),
      ...(typeof value.degradedReason === 'string'
        ? { degradedReason: value.degradedReason.slice(0, 1_000) }
        : {}),
      ...(value.escalation && typeof value.escalation === 'object'
        ? { escalation: value.escalation }
        : {}),
      ...(value.screenshotError && typeof value.screenshotError === 'object'
        ? { screenshotError: value.screenshotError }
        : {}),
    };
  }
  const encoded = JSON.stringify(data);
  return Buffer.byteLength(encoded) <= 4_000
    ? data
    : { truncated: true, preview: encoded.slice(0, 3_500), originalBytes: Buffer.byteLength(encoded) };
}

function observationReadiness(observation: BackendObservation): {
  actionable: boolean;
  blockedReason?: string;
} {
  const data = observation.data && typeof observation.data === 'object' && !Array.isArray(observation.data)
    ? observation.data as Record<string, unknown>
    : {};
  if (data.degraded !== true) return { actionable: true };
  const meaningfulElement = observation.elements?.some((element) => (
    !/^AX(?:Application|Window|Group|Unknown)$/iu.test(element.role)
    && (element.label !== undefined
      || element.value !== undefined
      || element.actions?.length
      || element.writable === true)
  ));
  if (observation.screenshot || meaningfulElement) return { actionable: true };
  const reason = typeof data.degradedReason === 'string'
    ? data.degradedReason
    : 'driver returned a degraded observation without semantic elements or a screenshot';
  return {
    actionable: false,
    blockedReason: `observation_unusable: ${reason.slice(0, 1_000)}`,
  };
}

function modelObservation(observation: StoredObservation): Record<string, unknown> {
  const elements = observation.elements?.map((element) => ({
    ...element,
    ...(element.label ? { label: element.label.slice(0, 240) } : {}),
    ...(element.description ? { description: element.description.slice(0, 240) } : {}),
    ...(element.identifier ? { identifier: element.identifier.slice(0, 160) } : {}),
    ...(element.actions ? { actions: element.actions.slice(0, 8) } : {}),
  })) ?? [];
  const view: Record<string, unknown> = {
    observationId: observation.id,
    capturedAt: new Date(observation.capturedAt).toISOString(),
    expiresAt: new Date(observation.expiresAt).toISOString(),
    target: observation.target,
    frontmost: observation.frontmost,
    dimensions: observation.dimensions,
    elements,
    truncated: observation.truncated ?? false,
    data: compactObservationData(observation.data),
    actionable: observation.actionable,
    ...(observation.blockedReason ? { blockedReason: observation.blockedReason } : {}),
  };
  while (elements.length > 0 && Buffer.byteLength(JSON.stringify(view)) > MAX_MODEL_OBSERVATION_BYTES) {
    elements.pop();
    view.truncated = true;
  }
  if (Buffer.byteLength(JSON.stringify(view)) > MAX_MODEL_OBSERVATION_BYTES) {
    const data = view.data as Record<string, unknown> | undefined;
    if (data && typeof data.semanticText === 'string') {
      data.semanticText = data.semanticText.slice(0, 2_000);
      view.truncated = true;
    }
  }
  if (Buffer.byteLength(JSON.stringify(view)) > MAX_MODEL_OBSERVATION_BYTES) {
    view.data = { truncated: true, message: 'Semantic observation exceeded the model payload budget.' };
    view.truncated = true;
  }
  if (observation.screenshot) view.screenshot = observation.screenshot;
  return view;
}

export class ComputerManager {
  private readonly runs = new Map<string, RunState>();
  private actionQueue: Promise<void> = Promise.resolve();
  private readonly artifacts: ComputerArtifactStore;
  private operationalReadiness: ComputerManagerStatus['operationalReadiness'] = 'unknown';
  private operationalCheckedAt?: string;
  private lastOperationalFailure?: string;

  constructor(
    private readonly config: ComputerConfig,
    private readonly backend: ComputerBackend,
    private readonly dataRoot: string,
  ) {
    this.artifacts = new ComputerArtifactStore(
      path.join(dataRoot, 'computer-artifacts'),
      config.artifactMaxBytes,
    );
  }

  async listApps(
    authority: ComputerRunAuthority,
    query?: string,
    signal?: AbortSignal,
  ) {
    this.authorize(authority, 'observe');
    const apps = await this.backend.listApps({ query, limit: query ? 10 : 50 }, signal);
    return apps.filter((app) => (
      (!authority.allowedApps?.length || authority.allowedApps.includes(app.bundleId))
      && !authority.deniedApps?.includes(app.bundleId)
    ));
  }

  async observeApp(
    authority: ComputerRunAuthority,
    app: string,
    includeScreenshot: boolean,
    signal?: AbortSignal,
  ) {
    this.authorize(authority, 'observe');
    const target = await this.targetForApp(authority, app, signal);
    if (!target) {
      const apps = await this.listApps(authority, app, signal);
      return {
        ok: false,
        reason: apps.length === 0
          ? 'app_not_found'
          : apps.some((candidate) => candidate.running) ? 'window_not_found' : 'app_not_running',
        apps,
        ...(apps.length === 0 ? {
          next: 'computer_observe',
          message: '没有发现匹配应用；省略 app 列出可用应用后，使用精确 apps[].bundleId 继续',
        } : {}),
      };
    }
    const screenshotSupported = authority.supportsImageInput !== false;
    const result = await this.observeTarget(
      authority,
      target,
      includeScreenshot && screenshotSupported,
      signal,
    );
    if (!includeScreenshot || screenshotSupported || !result || typeof result !== 'object') {
      return result;
    }
    return {
      ...result,
      screenshotStatus: {
        requested: true,
        included: false,
        reason: 'vision_unavailable',
        message: '当前模型未声明图像输入能力，已返回 AX 语义观察',
      },
    };
  }

  async listHostTargets(
    authority: ComputerRunAuthority,
    app: string,
    signal?: AbortSignal,
  ): Promise<ComputerTargetSummary[]> {
    this.authorize(authority, 'observe');
    const targets = await this.backend.listTargets({ query: app, limit: 50 }, signal);
    return targets.filter((target) => {
      try {
        this.authorizeApp(authority, target.bundleId);
        return target.bundleId.normalize('NFKC').toLowerCase()
          === app.normalize('NFKC').toLowerCase();
      } catch {
        return false;
      }
    }).map((target) => structuredClone(target));
  }

  async observeHostTarget(
    authority: ComputerRunAuthority,
    target: ComputerTargetSummary,
    signal?: AbortSignal,
  ): Promise<ComputerHostObservation> {
    this.authorize(authority, 'observe');
    this.authorizeApp(authority, target.bundleId);
    const result = await this.observe(authority, {
      scope: 'window',
      target: { bundleId: target.bundleId, pid: target.pid, windowId: target.windowId },
      includeScreenshot: false,
      maxElements: 400,
      maxDepth: 12,
    }, signal);
    if ((result as { actionable?: boolean }).actionable !== true) {
      const reason = (result as { blockedReason?: string }).blockedReason
        ?? 'window observation is not actionable';
      throw new Error(`computer_unavailable: ${reason}`);
    }
    const observation = this.latestTargetObservation(authority.runId);
    if (!observation.target || !observation.dimensions) {
      throw new Error('observation_unusable：Host Adapter 没有取得精确窗口和尺寸');
    }
    return {
      observationId: observation.id,
      target: { ...observation.target },
      frontmost: observation.frontmost,
      dimensions: { ...observation.dimensions },
      elements: structuredClone(observation.elements ?? []),
      truncated: observation.truncated ?? false,
    };
  }

  async observeTarget(
    authority: ComputerRunAuthority,
    target: Pick<ComputerTargetSummary, 'bundleId' | 'pid' | 'windowId'>,
    includeScreenshot: boolean,
    signal?: AbortSignal,
  ) {
    let lastResult: Awaited<ReturnType<ComputerManager['observe']>> | undefined;
    for (let attempt = 0; attempt < AX_WINDOW_SETTLE_ATTEMPTS; attempt += 1) {
      const result = await this.observe(authority, {
        scope: 'window',
        target,
        includeScreenshot,
        maxElements: DEFAULT_MODEL_ELEMENTS,
        maxDepth: 12,
      }, signal);
      const blockedReason = result && typeof result === 'object' && 'blockedReason' in result
        ? String(result.blockedReason ?? '')
        : '';
      if (!blockedReason.includes('ax_window_unresolved') || includeScreenshot) return result;
      lastResult = result;
      await delay(100, undefined, { signal });
    }
    if (authority.supportsImageInput === false) return lastResult!;
    return this.observe(authority, {
      scope: 'window',
      target,
      includeScreenshot: true,
      maxElements: DEFAULT_MODEL_ELEMENTS,
      maxDepth: 12,
    }, signal);
  }

  async observe(authority: ComputerRunAuthority, input: ComputerObserveInput, signal?: AbortSignal) {
    this.authorize(authority, requiresAccess(input));
    if ((('includeScreenshot' in input && input.includeScreenshot) || input.scope === 'region')
      && authority.supportsImageInput === false) {
      throw new Error(
        'vision_unavailable：当前模型未声明图像输入能力；仅截图和 region 观察不可用，'
        + '仍可使用 targets、includeScreenshot=false 的语义窗口观察，以及无需观察的 launch_app',
      );
    }
    if (input.scope === 'targets') {
      const targets = await this.backend.listTargets(input, signal);
      return {
        targets: authority.deniedApps?.length
          ? targets.filter((target) => !authority.deniedApps!.includes(target.bundleId))
          : targets,
      };
    }
    const run = await this.run(authority.runId, signal);
    if (((input.scope === 'window' || input.scope === 'desktop') && input.includeScreenshot) || input.scope === 'region') {
      if (run.screenshots >= this.config.maxScreenshotsPerRun) throw new Error(`当前 Run 已达到 ${this.config.maxScreenshotsPerRun} 张截图上限`);
      run.screenshots += 1;
    }
    let parent: StoredObservation | undefined;
    if (input.scope === 'region') {
      parent = this.freshObservation(run, authority.runId, input.observationId);
      if (!parent.target || !parent.dimensions) throw new Error('region 只能引用带窗口尺寸的有效 Observation');
      this.assertRect(input.rect.x, input.rect.y, input.rect.width, input.rect.height, parent.dimensions);
    }
    const result = await this.backend.observe(run.session!, { input, target: parent?.target }, signal);
    if (input.scope === 'window' && result.target && !result.dimensions) {
      const { width, height } = result.target.bounds;
      if (width > 0 && height > 0) result.dimensions = { width, height };
    }
    if (parent) {
      result.target = parent.target;
      result.frontmost = parent.frontmost;
      result.fromZoom = true;
    }
    if (input.scope === 'driver' || input.scope === 'session') return result.data ?? {};
    if (result.target) this.authorizeApp(authority, result.target.bundleId);
    if (result.data && !result.target && !result.screenshot && !result.elements) return result.data;
    const now = Date.now();
    const readiness = observationReadiness(result);
    if (input.scope === 'window') {
      this.operationalReadiness = readiness.actionable ? 'ready' : 'degraded';
      this.operationalCheckedAt = new Date().toISOString();
      this.lastOperationalFailure = readiness.blockedReason;
    }
    const observation: StoredObservation = {
      ...result,
      ...readiness,
      id: randomUUID(),
      runId: authority.runId,
      capturedAt: now,
      expiresAt: now + OBSERVATION_TTL_MS,
      valid: true,
    };
    if (observation.target) {
      for (const previous of run.observations.values()) {
        if (previous.target?.pid === observation.target.pid && previous.target.windowId === observation.target.windowId) previous.valid = false;
      }
    }
    run.observations.set(observation.id, observation);
    return modelObservation(observation);
  }

  bindLatestRegion(
    authority: ComputerRunAuthority,
    rect: Extract<ComputerObserveInput, { scope: 'region' }>['rect'],
  ): ComputerObserveInput {
    return {
      scope: 'region',
      observationId: this.latestTargetObservation(authority.runId).id,
      rect,
    };
  }

  bindLatestAction(
    authority: ComputerRunAuthority,
    action: ComputerAction,
  ): ComputerActInput {
    if ([
      'click',
      'double_click',
      'type_text',
      'set_value',
      'keypress',
      'scroll',
      'drag',
    ].includes(action.type)) {
      return computerActInputSchema.parse({
        observationId: this.latestTargetObservation(authority.runId).id,
        action,
      });
    }
    return computerActInputSchema.parse({ action });
  }

  async observeStableBackgroundWindow(
    authority: ComputerRunAuthority,
    signal?: AbortSignal,
    expectedTarget?: Pick<ComputerTargetSummary, 'bundleId' | 'pid' | 'windowId'>,
  ): Promise<ComputerReadProbeReceipt> {
    this.authorize(authority, 'observe');
    if (!authority.allowedApps?.length) {
      throw new Error('computerApps allowlist 不能为空');
    }
    try {
      const targets = await this.backend.listTargets({ limit: 50 }, signal);
      const candidates = targets.filter((candidate) => (
        authority.allowedApps!.includes(candidate.bundleId)
        && candidate.frontmost === false
        && (!expectedTarget
          || (candidate.bundleId === expectedTarget.bundleId
            && candidate.pid === expectedTarget.pid
            && candidate.windowId === expectedTarget.windowId))
      ));
      if (candidates.length === 0) {
        const focusUnknown = targets.some((candidate) => (
          authority.allowedApps!.includes(candidate.bundleId)
          && candidate.frontmost !== false
        ));
        throw new Error(focusUnknown
          ? 'target_in_use：allowlist 目标 frontmost 或焦点状态未知，拒绝后台观察'
          : 'target_not_found：没有可验证的 allowlist 后台窗口');
      }
      let lastUnusableReason: string | undefined;
      for (const target of candidates) {
        const observation = await this.observe(authority, {
          scope: 'window',
          target: {
            bundleId: target.bundleId,
            pid: target.pid,
            windowId: target.windowId,
          },
          includeScreenshot: false,
          maxElements: 100,
          maxDepth: 8,
        }, signal);
        if ((observation as { actionable?: boolean }).actionable !== true) {
          const reason = (observation as { blockedReason?: string }).blockedReason
            ?? 'window observation is not actionable';
          if (!expectedTarget && reason.includes('ax_window_unresolved')) {
            lastUnusableReason = reason;
            continue;
          }
          throw new Error(`computer_unavailable: ${reason}`);
        }
        const after = await this.backend.listTargets({ query: target.bundleId, limit: 50 }, signal);
        const verified = after.find((candidate) => (
          candidate.bundleId === target.bundleId
          && candidate.pid === target.pid
          && candidate.windowId === target.windowId
        ));
        if (!verified || verified.frontmost !== false) {
          throw new Error('target drift：Computer read probe 后目标窗口漂移、进入前台或焦点状态未知');
        }
        return {
          boundary: 'computer_manager',
          effect: 'read',
          registered: true,
          ready: true,
          fresh: true,
          targetVerified: true,
          actionResult: true,
          target: {
            bundleId: target.bundleId,
            pid: target.pid,
            windowId: target.windowId,
          },
        };
      }
      throw new Error(`computer_unavailable: ${lastUnusableReason ?? 'window observation is not actionable'}`);
    } finally {
      await this.endRun(authority.runId);
    }
  }

  async act(authority: ComputerRunAuthority, input: ComputerActInput, signal?: AbortSignal) {
    const requiredAccess = requiresAccess(input);
    this.authorize(authority, requiredAccess);
    if (input.action.type === 'set_driver_config') {
      const entries = Object.entries(input.action.values);
      if (entries.length !== 1 || entries[0]?.[0] !== 'max_image_dimension'
        || !Number.isSafeInteger(entries[0][1]) || Number(entries[0][1]) < 0 || Number(entries[0][1]) > 4_096) {
        throw new Error('set_driver_config 第一阶段只允许 max_image_dimension=0..4096 的安全整数');
      }
    }
    const run = await this.run(authority.runId, signal);
    if (run.actions >= this.config.maxActionsPerRun) throw new Error(`当前 Run 已达到 ${this.config.maxActionsPerRun} 个写动作上限`);
    let observation: StoredObservation | undefined;
    let target: ComputerTargetSummary | undefined;
    let element: ComputerElement | undefined;
    let backendInput = input;
    let effectiveAccess = requiredAccess;
    const promoteToForeground = () => {
      if (!hasAccess(authority.access, 'foreground')) return false;
      backendInput = withForegroundDelivery(backendInput);
      effectiveAccess = 'foreground';
      return true;
    };
    let foregroundRestoreTarget: ComputerTargetSummary | undefined;
    let artifactId: string | undefined;
    let artifactPath: string | undefined;
    let targetsBeforeLaunch: Set<string> | undefined;
    if (input.action.type === 'start_recording') {
      if (run.activeArtifactId) throw new Error('当前 Run 已有活跃录制');
      const pending = await this.artifacts.create(authority.runId);
      artifactId = pending.artifactId;
      artifactPath = pending.directory;
    } else if (input.action.type === 'stop_recording') {
      if (!run.activeArtifactId) throw new Error('当前 Run 没有活跃录制');
      artifactId = run.activeArtifactId;
    } else if (input.action.type === 'replay_trajectory') {
      const replay = await this.artifacts.openReplay(input.action.trajectoryId, input.action.manifestSha256);
      artifactId = replay.manifest.artifactId;
      artifactPath = replay.directory;
    }
    if ('observationId' in input) {
      observation = this.freshObservation(run, authority.runId, input.observationId);
      target = observation.target;
      if (!target || !observation.dimensions) throw new Error('UI 动作必须引用带精确窗口目标和尺寸的 Observation');
      if (!observation.actionable) {
        throw new Error(
          `${observation.blockedReason ?? 'observation_unusable'}；拒绝投递 UI 动作，请修复 AX/截图能力后重新观察`,
        );
      }
      this.authorizeApp(authority, target.bundleId, 'act');
      if (this.config.pauseWhenTargetFrontmost && requiredAccess === 'background' && observation.frontmost !== false) {
        if (!promoteToForeground()) {
          throw new ActionFailedSafeError('target_in_use：目标应用处于前台或焦点状态未知，当前 Run 没有前台权限');
        }
      }
      for (const point of actionCoordinates(input.action)) this.assertPoint(point.x, point.y, observation.dimensions);
      element = actionElement(input.action, observation);
    } else if (input.action.type === 'launch_app' && input.action.bundleId) {
      this.authorizeApp(authority, input.action.bundleId, 'act');
    } else if (input.action.type === 'launch_app') {
      throw new Error('launch_app 必须使用经过发现的精确 bundleId，不能仅按名称启动');
    } else if (input.action.type === 'bring_to_front' || input.action.type === 'handoff_to_user' || input.action.type === 'kill_app') {
      const controlAction = input.action;
      const targets = await this.backend.listTargets({ limit: 50 }, signal);
      target = targets.find((candidate) => candidate.pid === controlAction.pid
        && (controlAction.type === 'kill_app' || controlAction.windowId === undefined || candidate.windowId === controlAction.windowId));
      if (!target) throw new Error('target_not_found：无法把 pid 解析为精确应用窗口');
      this.authorizeApp(authority, target.bundleId, 'act');
      if (input.action.type === 'bring_to_front') {
        if (run.foregroundRestore) throw new Error('当前 Run 已持有 foreground lease，请先释放');
        foregroundRestoreTarget = targets.find((candidate) => candidate.frontmost && candidate.pid !== target!.pid);
        if (!foregroundRestoreTarget) throw new Error('无法确定可恢复的原前台窗口，拒绝获取 foreground lease');
      }
    } else if (input.action.type === 'release_foreground') {
      if (!run.foregroundRestore) return {
        status: 'applied', delivery: 'foreground', requiredAccess, verified: true, requiresObservation: false,
      };
      const restore = run.foregroundRestore.target;
      backendInput = { action: { type: 'bring_to_front', pid: restore.pid, windowId: restore.windowId } };
      target = restore;
    }
    run.actions += 1;
    if (observation) observation.valid = false;
    const execute = async () => withExclusiveFileLock(
      path.join(this.dataRoot, 'computer-action'),
      async () => {
        if (input.action.type === 'launch_app' && input.action.bundleId) {
          targetsBeforeLaunch = new Set((await this.backend.listTargets({
            query: input.action.bundleId,
            limit: 50,
          }, signal)).map(targetKey));
        }
        if (target) {
          const currentTarget = target;
          const freshTargets = await this.backend.listTargets({ query: currentTarget.bundleId, limit: 50 }, signal);
          const fresh = freshTargets.find((candidate) => candidate.bundleId === currentTarget.bundleId
            && candidate.pid === currentTarget.pid && candidate.windowId === currentTarget.windowId);
          if (!fresh) throw new Error('stale_observation：目标窗口身份已变化，请重新观察');
          if (this.config.pauseWhenTargetFrontmost && effectiveAccess === 'background' && fresh.frontmost !== false) {
            if (!promoteToForeground()) {
              throw new ActionFailedSafeError('target_in_use：目标应用处于前台或焦点状态未知，当前 Run 没有前台权限');
            }
          }
        }
        if (input.action.type === 'drag' && input.action.path.length !== 2) {
          throw new Error('当前 Cua Driver 版本的 drag 只支持起点和终点两个路径点');
        }
        let applied = await this.backend.act(run.session!, {
          input: backendInput, target, element, fromZoom: observation?.fromZoom, artifactPath,
        }, signal);
        // This is the only Backend result that proves the first delivery did not apply.
        if (applied.status === 'background_unsupported'
          && effectiveAccess === 'background'
          && 'dispatch' in input.action
          && promoteToForeground()) {
          applied = await this.backend.act(run.session!, {
            input: backendInput, target, element, fromZoom: observation?.fromZoom, artifactPath,
          }, signal);
        }
        if (effectiveAccess === 'background' && applied.delivery === 'foreground') {
          throw new ComputerActionUncertainError(
            'foreground_violation：驱动把后台动作升级为前台投递，停止后续动作',
          );
        }
        if (target && effectiveAccess === 'background') {
          const currentTarget = target;
          const after = await this.backend.listTargets({ query: currentTarget.bundleId, limit: 50 }, signal);
          const fresh = after.find((candidate) => candidate.pid === currentTarget.pid
            && candidate.windowId === currentTarget.windowId);
          if (fresh && fresh.frontmost !== false) {
            throw new ComputerActionUncertainError('foreground_violation：后台动作后目标成为前台或焦点状态未知，停止后续动作');
          }
        }
        return applied;
      },
      signal,
    );
    const result = await this.enqueueAction(execute);
    if (result.status === 'applied' && input.action.type === 'launch_app' && input.action.bundleId) {
      const launchedTarget = await this.findLaunchedTarget(
        input.action.bundleId,
        targetsBeforeLaunch ?? new Set(),
        input.action.urls,
        input.action.newInstance,
        signal,
      );
      if (launchedTarget) {
        target = launchedTarget;
        run.preferredTargets.set(input.action.bundleId, launchedTarget);
      }
    }
    let artifactResult: Record<string, unknown> = {};
    if (input.action.type === 'start_recording' && artifactId) {
      run.activeArtifactId = artifactId;
      artifactResult = { artifactId };
    } else if (input.action.type === 'stop_recording' && artifactId) {
      const manifest = await this.artifacts.seal(artifactId, authority.runId).catch((error) => {
        throw new ComputerActionUncertainError(`录制已停止但 artifact 封存失败：${error instanceof Error ? error.message : String(error)}`);
      });
      delete run.activeArtifactId;
      artifactResult = {
        trajectoryId: manifest.artifactId,
        manifestSha256: manifest.manifestSha256,
        actionCount: manifest.actionCount,
      };
    } else if (input.action.type === 'replay_trajectory' && artifactId) {
      artifactResult = { trajectoryId: artifactId };
    }
    if (input.action.type === 'bring_to_front' && foregroundRestoreTarget) {
      const seconds = input.action.leaseSeconds ?? this.config.foregroundLeaseSeconds;
      const timer = setTimeout(() => void this.restoreForeground(authority.runId), seconds * 1_000);
      timer.unref?.();
      run.foregroundRestore = { target: foregroundRestoreTarget, timer };
    } else if (input.action.type === 'handoff_to_user' && run.foregroundRestore) {
      clearTimeout(run.foregroundRestore.timer);
      delete run.foregroundRestore;
    } else if (input.action.type === 'release_foreground' && run.foregroundRestore) {
      clearTimeout(run.foregroundRestore.timer);
      delete run.foregroundRestore;
    }
    if (result.status === 'uncertain') throw new ComputerActionUncertainError();
    if (result.status === 'background_unsupported') return {
      status: 'background_unsupported', requiredAccess: effectiveAccess, requiresObservation: true, target,
    };
    return {
      status: 'applied',
      delivery: result.delivery ?? (effectiveAccess === 'background' ? 'background' : 'foreground'),
      requiredAccess: effectiveAccess,
      verified: false,
      requiresObservation: true,
      ...(input.action.type === 'handoff_to_user' ? { foregroundDisposition: 'retained_for_user' } : {}),
      target,
      ...artifactResult,
    };
  }

  async endRun(runId: string): Promise<void> {
    const state = this.runs.get(runId);
    await this.restoreForeground(runId);
    this.runs.delete(runId);
    if (state?.session) await this.backend.endSession(state.session);
    if (state?.activeArtifactId) await this.artifacts.seal(state.activeArtifactId, runId).catch(() => undefined);
  }

  async close(): Promise<void> {
    await Promise.all([...this.runs.keys()].map((runId) => this.endRun(runId)));
    await this.backend.close();
  }

  status(): ComputerManagerStatus {
    return {
      configured: true,
      backend: this.backend.kind,
      strategy: 'background-preferred',
      defaultAccess: this.config.defaultAccess,
      activeSessions: [...this.runs.values()].filter((state) => state.session).length,
      foregroundLeaseActive: [...this.runs.values()].some((state) => state.foregroundRestore),
      operationalReadiness: this.operationalReadiness,
      ...(this.operationalCheckedAt ? { operationalCheckedAt: this.operationalCheckedAt } : {}),
      ...(this.lastOperationalFailure ? { lastOperationalFailure: this.lastOperationalFailure } : {}),
    };
  }

  private async run(runId: string, signal?: AbortSignal): Promise<RunState> {
    let state = this.runs.get(runId);
    if (!state) {
      state = { observations: new Map(), preferredTargets: new Map(), actions: 0, screenshots: 0 };
      this.runs.set(runId, state);
    }
    if (!state.session) state.session = await this.backend.startSession({ sessionId: `mimi-${randomUUID()}`, captureScope: 'auto' }, signal);
    return state;
  }

  private async targetForApp(
    authority: ComputerRunAuthority,
    app: string,
    signal?: AbortSignal,
  ): Promise<ComputerTargetSummary | undefined> {
    const normalized = app.normalize('NFKC').trim().toLowerCase();
    const targets = (await this.backend.listTargets({ query: app, limit: 50 }, signal))
      .filter((target) => (
        (!authority.allowedApps?.length || authority.allowedApps.includes(target.bundleId))
        && !authority.deniedApps?.includes(target.bundleId)
      ));
    const score = (target: ComputerTargetSummary) => {
      if (target.bundleId.normalize('NFKC').toLowerCase() === normalized) return 100;
      if (target.appName.normalize('NFKC').toLowerCase() === normalized) return 90;
      if (target.title.normalize('NFKC').toLowerCase() === normalized) return 80;
      return 0;
    };
    const preferred = targets.find((candidate) => {
      const selected = this.runs.get(authority.runId)?.preferredTargets.get(candidate.bundleId);
      return selected !== undefined && targetKey(selected) === targetKey(candidate);
    });
    return preferred ?? [...targets].sort((left, right) => score(right) - score(left))[0];
  }

  private freshObservation(state: RunState, runId: string, id: string): StoredObservation {
    const observation = state.observations.get(id);
    if (!observation || observation.runId !== runId || !observation.valid || observation.expiresAt <= Date.now()) {
      throw new Error('stale_observation：请重新观察目标窗口');
    }
    return observation;
  }

  private latestTargetObservation(runId: string): StoredObservation {
    const state = this.runs.get(runId);
    const observation = state && [...state.observations.values()]
      .filter((candidate) => candidate.runId === runId
        && candidate.valid
        && candidate.expiresAt > Date.now()
        && candidate.target !== undefined
        && candidate.dimensions !== undefined
        && candidate.actionable)
      .sort((left, right) => right.capturedAt - left.capturedAt)[0];
    if (!observation) {
      throw new Error('stale_observation：当前 Run 没有可绑定的最新窗口观察');
    }
    return observation;
  }

  private authorize(authority: ComputerRunAuthority, required: ComputerAccess): void {
    if (!hasAccess(authority.access, required)) throw new Error(`approval_required：Computer 动作需要 ${required}，当前授权为 ${authority.access}`);
  }

  private authorizeApp(
    authority: ComputerRunAuthority,
    bundleId: string,
    operation: 'observe' | 'act' = 'observe',
  ): void {
    if (operation === 'act' && OBSERVE_ONLY_CONTROL_PLANE_APPS.has(bundleId)) {
      throw new Error(`应用 ${bundleId} 是只读控制面，Computer 可以观察但不得注入输入`);
    }
    if (PROTECTED_CONTROL_PLANE_APPS.has(bundleId)
      || PROTECTED_CONTROL_PLANE_PREFIXES.some((prefix) => bundleId.startsWith(prefix))) {
      throw new Error(`应用 ${bundleId} 是受保护控制面，Computer 不得观察或注入输入`);
    }
    if (authority.deniedApps?.includes(bundleId)) {
      throw new Error(`应用 ${bundleId} 已由正式 Connector 声明 route owner，Computer 不能跨执行面接管`);
    }
    if (authority.allowedApps !== undefined && !authority.allowedApps.includes(bundleId)) {
      throw new Error(`应用 ${bundleId} 不在当前 Run 的 computerApps allowlist`);
    }
  }

  private assertPoint(x: number, y: number, dimensions: { width: number; height: number }): void {
    if (x < 0 || y < 0 || x >= dimensions.width || y >= dimensions.height) throw new Error('坐标超出 Observation 窗口边界');
  }

  private assertRect(x: number, y: number, width: number, height: number, dimensions: { width: number; height: number }): void {
    if (x < 0 || y < 0 || x + width > dimensions.width || y + height > dimensions.height) throw new Error('region 超出 Observation 窗口边界');
  }

  private enqueueAction<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.actionQueue.then(operation, operation);
    this.actionQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async findLaunchedTarget(
    bundleId: string,
    existing: ReadonlySet<string>,
    urls: readonly string[] | undefined,
    newInstance: boolean,
    signal?: AbortSignal,
  ): Promise<ComputerTargetSummary | undefined> {
    const documentName = launchedDocumentName(urls);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const targets = await this.backend.listTargets({ query: bundleId, limit: 50 }, signal);
      const documentTarget = documentName
        ? targets.find((candidate) => candidate.title.normalize('NFKC').toLowerCase().includes(documentName))
        : undefined;
      const freshTarget = targets.find((candidate) => !existing.has(targetKey(candidate)));
      const selected = documentTarget ?? freshTarget ?? (!newInstance && !urls?.length ? targets[0] : undefined);
      if (selected) return selected;
      await delay(100, undefined, { signal });
    }
    return undefined;
  }

  private async restoreForeground(runId: string): Promise<void> {
    const state = this.runs.get(runId);
    const restore = state?.foregroundRestore;
    if (!state?.session || !restore) return;
    clearTimeout(restore.timer);
    delete state.foregroundRestore;
    await this.enqueueAction(() => withExclusiveFileLock(
      path.join(this.dataRoot, 'computer-action'),
      () => this.backend.act(state.session!, {
        input: { action: { type: 'bring_to_front', pid: restore.target.pid, windowId: restore.target.windowId } },
        target: restore.target,
      }),
    )).catch(() => undefined);
  }
}
