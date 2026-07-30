import { randomUUID } from 'node:crypto';
import type { MimiAgent } from './agent.js';
import { SECURITY_PROFILES } from './config.js';
import type { ModelProvider, SecurityProfile, SecurityProfileSummary } from './config.js';
import type { MemoryRef, MemoryScope } from './core/memory.js';
import {
  modelTargetSchema,
  type ModelControlRequest,
  type ModelTarget,
} from './core/model-routing.js';
import type { SessionSummary } from './core/session.js';
import { OUTPUT_LEVELS, type OutputLevel } from './terminal.js';

export type CommandResult = 'handled' | 'exit' | 'pass';
type MaybePromise<T> = T | Promise<T>;

export interface BackgroundTaskSummary {
  taskId: string;
  status: string;
  objective?: string;
  strategy?: string;
  executor?: 'mimi' | 'codex';
  workspaceAccess?: 'read' | 'write';
  sessionId?: string;
  originSessionId?: string;
  parentTaskId?: string;
  depth?: number;
  attempts?: number;
  createdAt?: string;
  updatedAt?: string;
  result?: unknown;
  error?: string;
  previousAttemptError?: string;
  execution?: {
    leaseActive: boolean;
    leaseUntil?: string;
  };
  codex?: {
    runnerPid?: number;
    codexPid?: number;
    threadId?: string;
    startedAt?: string;
    checkpointedAt?: string;
    lastEvent?: string;
    outputJsonlPath?: string;
    summaryPath?: string;
    logBytes?: number;
    logUpdatedAt?: string;
    latestActivity?: string;
    recentEvents?: Array<{
      type: string;
      itemType?: string;
      status?: string;
      summary?: string;
    }>;
  };
  worker?: {
    pid?: number;
    workerId?: string;
    spawnedAt?: string;
    heartbeatAt?: string;
  };
  recentEvents?: Array<{
    sequence?: number;
    kind: string;
    tone?: string;
    title?: string;
    next?: string;
    steps?: Array<{
      description: string;
      status: string;
    }>;
  }>;
  plan?: Array<{
    description: string;
    status: string;
  }>;
  checkpoint?: {
    phase: string;
    lastEvent?: string;
    nextAction?: string;
    updatedAt: string;
  };
}

export type BackgroundTaskCancelResult =
  | { state: 'cancelled' }
  | { state: 'already_terminal' }
  | { state: 'not_found' };

export type BackgroundTaskPauseResult =
  | { state: 'paused' }
  | { state: 'pause_requested' }
  | { state: 'already_paused' }
  | { state: 'not_pauseable' }
  | { state: 'already_terminal' }
  | { state: 'not_found' };

export type BackgroundTaskResumeResult =
  | { state: 'resumed' }
  | { state: 'not_resumable' }
  | { state: 'not_found' };

export interface CommandRunOptions {
  resumeState?: boolean;
  approvedPersonalMessageText?: string;
}

export interface ModelChoice {
  provider: string;
  providerLabel: string;
  model: string;
}

export interface CommandTarget {
  readonly currentSessionId: string;
  readonly sessionReady?: boolean;
  readonly toolNames: MaybePromise<string[]>;
  runtimeInfo(): ReturnType<MimiAgent['runtimeInfo']>;
  availableModels(): MaybePromise<ReturnType<MimiAgent['availableModels']>>;
  modelControl(request: ModelControlRequest): ReturnType<MimiAgent['modelControl']>;
  switchModel(model: string): ReturnType<MimiAgent['switchModel']>;
  availableModes(): MaybePromise<ReturnType<MimiAgent['availableModes']>>;
  switchMode(mode: string): ReturnType<MimiAgent['switchMode']>;
  switchSecurityProfile(profile: string): ReturnType<MimiAgent['switchSecurityProfile']>;
  switchSession(sessionId: string): ReturnType<MimiAgent['switchSession']>;
  prepareNewSession?(sessionId?: string): MaybePromise<void>;
  listSessionSummaries(): ReturnType<MimiAgent['listSessionSummaries']>;
  history(): ReturnType<MimiAgent['history']>;
  clearSession(): ReturnType<MimiAgent['clearSession']>;
  listUndoableRuns?(limit?: number): ReturnType<MimiAgent['listUndoableRuns']>;
  previewUndo?(runId: string): ReturnType<MimiAgent['previewUndo']>;
  undoRun?(runId: string): ReturnType<MimiAgent['undoRun']>;
  listSkills(): MaybePromise<ReturnType<MimiAgent['listSkills']>>;
  activeSkills?(): ReturnType<MimiAgent['activeSkills']>;
  deactivateSkill?(name: string): ReturnType<MimiAgent['deactivateSkill']>;
  setSkillEnabled?(name: string, scope: 'project' | 'user', enabled: boolean): ReturnType<MimiAgent['setSkillEnabled']>;
  reloadSkills(): ReturnType<MimiAgent['reloadSkills']>;
  mcpStatuses(): MaybePromise<ReturnType<MimiAgent['mcpStatuses']>>;
  reloadMcp(): ReturnType<MimiAgent['reloadMcp']>;
  contextInfo(): ReturnType<MimiAgent['contextInfo']>;
  compactContext(): ReturnType<MimiAgent['compactContext']>;
  guidanceInfo(): ReturnType<MimiAgent['guidanceInfo']>;
  memoryList(scope?: MemoryScope | 'all'): ReturnType<MimiAgent['memoryList']>;
  memorySearch(query: string, scope?: MemoryScope | 'all'): ReturnType<MimiAgent['memorySearch']>;
  memoryRead(ref: MemoryRef): ReturnType<MimiAgent['memoryRead']>;
  memoryForget(ref: MemoryRef): ReturnType<MimiAgent['memoryForget']>;
  memoryIngest(path: string, signal?: AbortSignal): ReturnType<MimiAgent['memoryIngest']>;
  memoryCaptureRound(roundRef?: string): ReturnType<MimiAgent['memoryCaptureRound']>;
  memoryLint(): ReturnType<MimiAgent['memoryLint']>;
  memoryRefresh(limit?: number): ReturnType<MimiAgent['memoryRefresh']>;
  memoryConflicts(limit?: number): ReturnType<MimiAgent['memoryConflicts']>;
  memoryAudit(limit?: number): ReturnType<MimiAgent['memoryAudit']>;
  memoryMaintain?(): MaybePromise<unknown>;
  memoryReindex(): ReturnType<MimiAgent['memoryReindex']>;
  memoryStatus(): ReturnType<MimiAgent['memoryStatus']>;
  currentPlan(): ReturnType<MimiAgent['currentPlan']>;
  currentTeam(): ReturnType<MimiAgent['currentTeam']>;
  currentGoal(): ReturnType<MimiAgent['currentGoal']>;
  setGoal(objective: string): ReturnType<MimiAgent['setGoal']>;
  resumePrompt(): ReturnType<MimiAgent['resumePrompt']>;
  listBackgroundTasks?(limit?: number): MaybePromise<BackgroundTaskSummary[]>;
  inspectBackgroundTask?(taskId: string): MaybePromise<BackgroundTaskSummary>;
  cancelBackgroundTask?(taskId: string, reason?: string): MaybePromise<BackgroundTaskCancelResult>;
  pauseBackgroundTask?(taskId: string, reason?: string): MaybePromise<BackgroundTaskPauseResult>;
  resumeBackgroundTask?(taskId: string, context?: string): MaybePromise<BackgroundTaskResumeResult>;
}

export const COMMANDS = [
  { value: '/status', description: '查看运行状态' },
  { value: '/security', description: '查看或临时调整当前运行权限' },
  { value: '/models', description: '列出全部已注册模型及硬能力' },
  { value: '/model', description: '查看或切换模型' },
  { value: '/mode', description: '查看或切换运行模式' },
  { value: '/output', description: '调整执行过程展示等级' },
  { value: '/new', description: '新建对话' },
  { value: '/sessions', description: '选择最近对话' },
  { value: '/switch', description: '按 ID 切换对话' },
  { value: '/history', description: '查看当前历史' },
  { value: '/clear', description: '清空当前对话' },
  { value: '/undo', description: '预览或安全撤销某个 Run 的文件变更' },
  { value: '/skills', description: '列出 Skills' },
  { value: '/tools', description: '列出可用工具' },
  { value: '/mcp', description: '查看 MCP 连接' },
  { value: '/context', description: '查看上下文用量' },
  { value: '/compact', description: '压缩并归档较早上下文' },
  { value: '/instructions', description: '查看持久指令文件' },
  { value: '/memory', description: '搜索、读取、导入、检查或遗忘 Memory' },
  { value: '/plan', description: '查看任务计划' },
  { value: '/team', description: '查看 Ultra Team 任务板' },
  { value: '/tasks', description: '查看后台任务' },
  { value: '/task', description: '查看、暂停、继续或取消后台任务' },
  { value: '/goal', description: '查看或设置长期目标' },
  { value: '/confirm-send', description: '确认发送个人消息的精确正文' },
  { value: '/resume', description: '依据持久任务状态继续' },
  { value: '/retry', description: '重试上一条输入' },
  { value: '/help', description: '显示命令帮助' },
  { value: '/exit', description: '退出 MimiAgent CLI' },
] as const;

const HELP = `内置命令：
  /status             查看模型、会话和扩展状态
  /security [profile] 查看或临时调整当前运行权限
  /models             列出全部精确模型 target、能力和配置状态
  /model [name]       使用兼容选择器查看或切换当前模型
  /model current|inspect <target>|use <target>|auto
  /model routes|route <scenario> <target|auto>|doctor [target]
                      查看或调整当前 Session 与场景模型路由
  /mode [name]        查看或切换运行模式
  /output [level]     调整答案、思考、工具或详细事件展示
  /new [id]           新建并切换对话
  /sessions           选择并切换最近对话
  /switch <id>        按 ID 切换对话
  /history            查看当前对话历史
  /clear              清空当前对话
  /undo [run-id] [--apply]
                      列出、预览或显式确认撤销某个 Run 的文件变更
  /skills [reload|active|deactivate <name>]
                      列出、重新加载或管理当前 Session 的 Skills
  /skills <enable|disable> <project|user> <name>
                      持久启用或停用项目/用户范围 Skill
  /tools              列出当前可用工具
  /mcp [reload]       查看或重新连接 MCP Server
  /context            查看上下文、记忆和计划用量
  /compact            归档较早历史，保留最近两轮
  /instructions       查看 Soul 与项目开发指令
  /memory <操作>      status/list/search/read/ingest/capture/lint/conflicts/audit/forget/reindex/maintain
  /plan               查看当前任务计划
  /team               查看 Ultra Team 子任务、依赖和结果
  /tasks [limit]      查看最近的后台任务
  /task <id>          查看后台任务详情
  /task cancel <id>   取消后台任务，可在 ID 后填写原因
  /task pause <id>    暂停后台任务
  /task resume <id>   继续后台任务，可在 ID 后补充上下文
  /goal [objective]   查看或设置当前长期目标
  /confirm-send <text>
                      在当前个人消息 Session 中确认一次精确发送正文
  /resume             依据 Checkpoint / Goal / Plan / Team 尽力续跑
  /retry              重新执行上一条用户输入
  /help               显示帮助
  /exit               退出

交互快捷键：Esc 停止当前任务 · Shift+Tab 切换模式 · Shift+Enter 换行 · Command+←/→ 跳到行首/行尾 · 输入 / 查看命令 · ↑↓ 选择 · Enter 执行 · Tab 补全`;

export interface CommandUI {
  write?: (text: string) => void;
  resetScreen?: () => void | Promise<void>;
  restoreSession?: () => void | Promise<void>;
  selectSession?: (sessions: SessionSummary[]) => Promise<string | undefined>;
  selectModel?: (
    models: ModelChoice[],
    current: Pick<ModelChoice, 'provider' | 'model'>,
  ) => Promise<ModelChoice | undefined>;
  switchProvider?: (provider: ModelProvider, model: string) => void | Promise<void>;
  selectMode?: (modes: ReturnType<MimiAgent['availableModes']>, current: string) => Promise<string | undefined>;
  selectSecurityProfile?: (
    profiles: SecurityProfileSummary[],
    current: SecurityProfile,
  ) => Promise<string | undefined>;
  getOutputLevel?: () => OutputLevel;
  setOutputLevel?: (level: OutputLevel) => void | Promise<void>;
  selectOutputLevel?: (current: OutputLevel) => Promise<string | undefined>;
}

const TASK_STATUS_LABELS: Record<string, string> = {
  queued: '排队中',
  running: '运行中',
  paused: '已暂停',
  blocked: '等待输入',
  completed: '已完成',
  ignored: '已忽略',
  digested: '已归档摘要',
  dead_letter: '失败',
  archived: '已归档',
};

const CONTEXT_SECTION_LABELS: Record<string, string> = {
  'base-instructions': '基础指令',
  'session-state': '会话状态',
  soul: 'Soul',
  'behavior-preferences': '行为偏好',
  'runtime-context': '运行上下文',
  'project-guidance': '项目指引',
  'goal-plan-team': '目标/计划/团队',
  recovery: '恢复信息',
  'memory-cards': '相关记忆',
  'skill-catalog': 'Skill 目录',
  'active-skills': '已激活 Skill',
  'work-snapshot': '工作快照',
  archive: '历史归档',
  'recent-history': '最近对话',
  'current-input': '当前输入',
  'tool-schemas': '工具 Schema',
};

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(value);
}

function formatPercentage(value: number, total: number): string {
  return `${total > 0 ? Math.round((value / total) * 100) : 0}%`;
}

function modelControlChoices(value: unknown): ModelChoice[] {
  if (!Array.isArray(value)) throw new Error('模型控制面返回了无效列表');
  return value.flatMap((item): ModelChoice[] => {
    if (!item || typeof item !== 'object') return [];
    const record = item as {
      kind?: unknown;
      target?: unknown;
      provider?: unknown;
    };
    if (record.kind !== 'agent') return [];
    const target = modelTargetSchema.safeParse(record.target);
    if (!target.success) return [];
    const provider = record.provider && typeof record.provider === 'object'
      ? record.provider as { label?: unknown }
      : undefined;
    return [{
      provider: target.data.providerId,
      providerLabel: typeof provider?.label === 'string'
        ? provider.label
        : target.data.providerId,
      model: target.data.modelId,
    }];
  });
}

function currentModelTarget(value: unknown): ModelTarget | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as { next?: unknown; sessionTarget?: unknown };
  if (record.next && typeof record.next === 'object') {
    const next = modelTargetSchema.safeParse((record.next as { target?: unknown }).target);
    if (next.success) return next.data;
  }
  const sessionTarget = modelTargetSchema.safeParse(record.sessionTarget);
  return sessionTarget.success ? sessionTarget.data : undefined;
}

function resolveModelChoice(
  model: string,
  choices: readonly ModelChoice[],
  currentProvider: string,
): ModelChoice {
  const exact = choices.find((choice) => `${choice.provider}/${choice.model}` === model);
  if (exact) return exact;
  const matches = choices.filter((choice) => choice.model === model);
  const selected = matches.find((choice) => choice.provider === currentProvider) ?? matches[0];
  if (!selected) {
    throw new Error(`模型不可用：${model}；当前已配置模型：${choices.map((choice) => choice.model).join('、')}`);
  }
  if (matches.length > 1 && !matches.some((choice) => choice.provider === currentProvider)) {
    throw new Error(`模型名称 ${model} 同时属于多个 Provider，请通过 /model 选择器切换`);
  }
  return selected;
}

function parseModelTarget(value: string): ModelTarget {
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1) {
    throw new Error(`模型 target 必须是 providerId/modelId：${value || '(empty)'}`);
  }
  return modelTargetSchema.parse({
    providerId: value.slice(0, slash),
    modelId: value.slice(slash + 1),
  });
}

function exactArguments(
  action: string,
  values: readonly string[],
  count: number,
): void {
  if (values.length !== count) {
    throw new Error(`/model ${action} 参数数量无效`);
  }
}

function modelSlashRequest(values: readonly string[]): ModelControlRequest | undefined {
  const [action, ...arguments_] = values;
  if (!action) return undefined;
  if (action === 'current' || action === 'auto' || action === 'routes') {
    exactArguments(action, arguments_, 0);
    return { action };
  }
  if (action === 'inspect' || action === 'use') {
    exactArguments(action, arguments_, 1);
    return { action, target: parseModelTarget(arguments_[0]!) };
  }
  if (action === 'doctor') {
    if (arguments_.length > 1) throw new Error('/model doctor 最多接受一个 target');
    return {
      action,
      ...(arguments_[0] ? { target: parseModelTarget(arguments_[0]) } : {}),
    };
  }
  if (action === 'route') {
    exactArguments(action, arguments_, 2);
    const [scenario, target] = arguments_;
    if (target === 'auto') return { action, scenario: scenario!, routeAuto: true };
    return { action, scenario: scenario!, target: parseModelTarget(target!) };
  }
  return undefined;
}

function taskStatus(status: string): string {
  return TASK_STATUS_LABELS[status] ?? status;
}

function taskValue(value: unknown, maxLength = 1_200): string {
  let rendered: string;
  if (typeof value === 'string') rendered = value;
  else {
    try {
      rendered = JSON.stringify(value, null, 2);
    } catch {
      rendered = String(value);
    }
  }
  const normalized = rendered.trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}…` : normalized;
}

function taskListLine(task: BackgroundTaskSummary): string {
  const objective = task.objective?.replace(/\s+/g, ' ').trim() || '未记录目标';
  return `- [${taskStatus(task.status)}] ${task.taskId} · ${objective}`;
}

function taskProgress(task: BackgroundTaskSummary): string[] {
  const events = task.recentEvents ?? [];
  const latestPlan = [...events].reverse().find((event) => event.kind === 'plan' && event.steps?.length);
  const latestStatus = [...events].reverse().find((event) => event.kind === 'status');
  const plan = latestPlan?.steps?.length ? latestPlan.steps : task.plan;
  const lines: string[] = [];
  if (plan?.length) {
    const completed = plan.filter((step) => step.status === 'completed').length;
    const active = plan.find((step) => step.status === 'running');
    lines.push(`计划进度  ${completed}/${plan.length}${active ? ` · ${active.description}` : ''}`);
  }
  if (latestStatus) {
    const action = latestStatus.next || latestStatus.title;
    if (action) lines.push(`当前动作  ${action}`);
  } else if (task.checkpoint) {
    const action = task.checkpoint.lastEvent || task.checkpoint.nextAction || task.checkpoint.phase;
    if (action) lines.push(`当前动作  ${action}`);
  }
  return lines;
}

function taskDetails(task: BackgroundTaskSummary): string {
  return [
    `任务      ${task.taskId}`,
    `状态      ${taskStatus(task.status)}`,
    `目标      ${task.objective ?? '未记录'}`,
    task.strategy ? `策略      ${task.strategy}` : '',
    task.executor ? `执行器    ${task.executor}` : '',
    task.workspaceAccess ? `工作区    ${task.workspaceAccess === 'read' ? '只读' : '可写（独占）'}` : '',
    task.sessionId ? `任务会话  ${task.sessionId}` : '',
    task.originSessionId ? `来源会话  ${task.originSessionId}` : '',
    task.parentTaskId ? `父任务    ${task.parentTaskId}` : '',
    task.depth !== undefined ? `委派深度  ${task.depth}` : '',
    task.attempts !== undefined ? `尝试次数  ${task.attempts}` : '',
    task.worker ? `工作进程  ${task.worker.pid ?? task.worker.workerId ?? '启动中'}` : '',
    task.worker?.heartbeatAt ? `最近心跳  ${task.worker.heartbeatAt}` : '',
    task.codex?.runnerPid ? `追踪进程  ${task.codex.runnerPid}` : '',
    task.codex?.codexPid ? `Codex PID ${task.codex.codexPid}` : '',
    task.codex?.threadId ? `Codex 线程 ${task.codex.threadId}` : '',
    task.codex?.lastEvent ? `Codex 状态 ${task.codex.lastEvent}` : '',
    task.codex?.latestActivity ? `Codex 进度 ${task.codex.latestActivity}` : '',
    task.codex?.logUpdatedAt ? `日志更新  ${task.codex.logUpdatedAt}` : '',
    task.codex?.logBytes !== undefined ? `日志大小  ${task.codex.logBytes} bytes` : '',
    task.execution?.leaseActive ? `执行租约  活跃至 ${task.execution.leaseUntil}` : '',
    task.codex?.outputJsonlPath ? `事件产物  ${task.codex.outputJsonlPath}` : '',
    task.codex?.summaryPath ? `结果产物  ${task.codex.summaryPath}` : '',
    ...taskProgress(task),
    task.createdAt ? `创建时间  ${task.createdAt}` : '',
    task.updatedAt ? `更新时间  ${task.updatedAt}` : '',
    task.result !== undefined ? `结果\n${taskValue(task.result)}` : '',
    task.error ? `错误\n${task.error}` : '',
    task.previousAttemptError ? `上次尝试错误\n${task.previousAttemptError}` : '',
  ].filter(Boolean).join('\n');
}

export class CommandHandler {
  private lastInputs = new Map<string, string>();

  constructor(
    private readonly agent: CommandTarget,
    private readonly runTask: (
      input: string,
      signal?: AbortSignal,
      options?: CommandRunOptions,
    ) => Promise<void>,
    private readonly ui: CommandUI = {},
  ) {}

  remember(input: string): void {
    this.lastInputs.set(this.agent.currentSessionId, input);
  }

  async execute(input: string, signal?: AbortSignal): Promise<CommandResult> {
    if (!input.startsWith('/')) return 'pass';
    const [command, ...rest] = input.split(/\s+/);
    const argument = rest.join(' ').trim();

    if (command === '/exit') return 'exit';
    if (command === '/help') return this.handled(HELP);
    if (command === '/status') {
      const info = await this.agent.runtimeInfo();
      const executionAccess = info.mode.id === 'plan'
        ? '当前模式只读（Shell 关闭）'
        : info.permissionMode === 'trusted'
          ? '本机完整（Shell 可用）'
          : info.permissionMode === 'workspace'
            ? '工作区受限（Shell 关闭）'
            : '只读（Shell 关闭）';
      const securityLabel = info.securityProfile?.label ?? (
        info.permissionMode === 'trusted'
          ? 'Full Owner'
          : info.permissionMode === 'workspace' ? 'Workstation' : 'Safe'
      );
      return this.handled([
        `模型      ${info.provider} / ${info.model}`,
        `模式      ${info.mode.label}`,
        `安全档位  ${securityLabel}`,
        `执行      ${executionAccess}`,
        `输出      ${this.ui.getOutputLevel?.() ?? 'tools'}`,
        `会话      ${info.sessionId}`,
        `工作区    ${info.workspaceRoot}`,
        `最大轮数  ${info.maxTurns ?? '不限（由状态、取消与超时控制）'}`,
        `Skills    ${info.skillCount}`,
        `Memories  ${info.memoryCount}`,
        `MCP       ${info.mcpServers.join(', ') || '未连接'}`,
        `Computer  ${info.computer?.configured ? `已配置（${info.computer.backend ?? 'unknown'}）` : '未配置'}`,
        `Team      ${info.team.total ? `${info.team.completed}/${info.team.total} 完成 · ${info.team.running} 运行` : '未启用'}`,
        `Guidance  ${info.guidanceFiles.length ? `${info.guidanceFiles.length} 个已加载` : '未配置'}`,
      ].join('\n'));
    }
    if (command === '/security') {
      const info = await this.agent.runtimeInfo();
      const active = info.securityProfile?.id ?? (
        info.permissionMode === 'trusted'
          ? 'full-owner'
          : info.permissionMode === 'workspace' ? 'workstation' : 'safe'
      );
      const profiles = Object.values(SECURITY_PROFILES);
      const selected = argument || await this.ui.selectSecurityProfile?.(profiles, active);
      if (selected) {
        await this.agent.switchSecurityProfile(selected);
        const updated = await this.agent.runtimeInfo();
        const profile = updated.securityProfile ?? SECURITY_PROFILES[
          updated.permissionMode === 'trusted'
            ? 'full-owner'
            : updated.permissionMode === 'workspace' ? 'workstation' : 'safe'
        ];
        return this.handled(
          `已临时调整当前运行权限为 ${profile.label} (${profile.id}/${profile.permissionMode})；`
          + `${profile.ephemeralSensitiveModelAccess
            ? '认证直接 Owner 本轮提交的敏感值可临时发送给配置模型 Provider；'
            : '敏感值不会发送给模型 Provider；'}从下一轮开始生效，重启后恢复启动配置。`,
        );
      }
      if (this.ui.selectSecurityProfile) return 'handled';
      const effective = info.securityProfile;
      return this.handled([
        `当前权限  ${SECURITY_PROFILES[active].label} (${active}/${info.permissionMode ?? SECURITY_PROFILES[active].permissionMode})`,
        `当前能力  ${effective?.shell ? 'Shell' : '无 Shell'} · ${effective?.externalTransactions ? '外部写事务' : '无外部写事务'} · ${effective?.computerUse ? 'Computer Use 已配置' : 'Computer Use 未配置'} · ${effective?.trustedWorkspaceMcp ? '受信工作区 MCP 已配置' : '受信工作区 MCP 未配置'} · ${effective?.ephemeralSensitiveModelAccess ? '本轮敏感值可发模型 Provider' : '敏感值不发模型'}`,
        '',
        '本机认证 Owner 默认直接工作；外部事件和后台任务仍按来源策略隔离。',
        '如需临时收紧，可使用 /security safe 或 /security workstation；恢复使用 /security full-owner。',
      ].join('\n'));
    }
    if (command === '/models') {
      if (rest.length) throw new Error('/models 不接受参数');
      return this.handled(taskValue(await this.agent.modelControl({ action: 'list' }), 12_000));
    }
    if (command === '/model') {
      const controlRequest = modelSlashRequest(rest);
      if (controlRequest) {
        return this.handled(taskValue(await this.agent.modelControl(controlRequest), 12_000));
      }
      const [info, listedModels, currentModel] = await Promise.all([
        this.agent.runtimeInfo(),
        this.agent.modelControl({ action: 'list' }),
        this.agent.modelControl({ action: 'current' }),
      ]);
      const choices = modelControlChoices(listedModels);
      const currentTarget = currentModelTarget(currentModel) ?? {
        providerId: info.provider,
        modelId: info.model,
      };
      const selected = argument
        ? resolveModelChoice(argument, choices, currentTarget.providerId)
        : await this.ui.selectModel?.(choices, {
            provider: currentTarget.providerId,
            model: currentTarget.modelId,
          });
      if (!selected) return this.ui.selectModel ? 'handled' : this.handled(`当前模型：${info.model}`);
      await this.agent.modelControl({
        action: 'use',
        target: { providerId: selected.provider, modelId: selected.model },
      });
      return this.handled(`已切换模型：${selected.model}（${selected.provider}）`);
    }
    if (command === '/mode') {
      const current = (await this.agent.runtimeInfo()).mode;
      const modes = await this.agent.availableModes();
      const selected = argument || await this.ui.selectMode?.(modes, current.id);
      if (!selected) return this.ui.selectMode ? 'handled' : this.handled(`当前模式：${current.label}`);
      await this.agent.switchMode(selected);
      const mode = modes.find((item) => item.id === selected);
      return this.handled(`已切换模式：${mode?.label ?? selected}`);
    }
    if (command === '/output') {
      const current = this.ui.getOutputLevel?.() ?? 'tools';
      const selected = argument || await this.ui.selectOutputLevel?.(current);
      if (!selected) return this.ui.selectOutputLevel ? 'handled' : this.handled(`当前输出等级：${current}`);
      const level = OUTPUT_LEVELS.find((item) => item.id === selected);
      if (!level) throw new Error(`未知输出等级：${selected}`);
      await this.ui.setOutputLevel?.(level.id);
      return this.handled(`已切换输出等级：${level.label}（${level.id}）`);
    }
    if (command === '/new') {
      if (this.agent.prepareNewSession) await this.agent.prepareNewSession(argument || undefined);
      else await this.agent.switchSession(argument || randomUUID().slice(0, 8));
      await this.ui.resetScreen?.();
      return this.handled('新对话已就绪。');
    }
    if (command === '/sessions' || command === '/session') {
      const sessions = await this.agent.listSessionSummaries();
      if (!sessions.length) return this.handled('暂无对话。');
      const selected = this.ui.selectSession
        ? await this.ui.selectSession(sessions)
        : undefined;
      if (selected) {
        await this.agent.switchSession(selected);
        await (this.ui.restoreSession?.() ?? this.ui.resetScreen?.());
        return 'handled';
      }
      if (this.ui.selectSession) return 'handled';
      return this.handled(sessions.map((item) => `${item.id === this.agent.currentSessionId ? '*' : ' '} ${item.title}  ${item.preview}`).join('\n'));
    }
    if (command === '/switch') {
      if (!argument) throw new Error('用法：/switch <session-id>');
      await this.agent.switchSession(argument);
      await (this.ui.restoreSession?.() ?? this.ui.resetScreen?.());
      return 'handled';
    }
    if (command === '/history') {
      const items = await this.agent.history();
      return this.handled(items.map((item, index) => `${index + 1}. ${JSON.stringify(item)}`).join('\n') || '当前对话为空');
    }
    if (command === '/clear') {
      await this.agent.clearSession();
      this.lastInputs.delete(this.agent.currentSessionId);
      await this.ui.resetScreen?.();
      return this.handled('当前对话、Goal、Plan 与 Team 状态已清空。');
    }
    if (command === '/undo') {
      if (!this.agent.listUndoableRuns || !this.agent.previewUndo || !this.agent.undoRun) {
        return this.handled('当前 Host 暂不支持运行级撤销。');
      }
      if (!argument) {
        const runs = await this.agent.listUndoableRuns(20);
        return this.handled(runs.map((run) =>
          `${run.runId} · ${run.operations} 次修改 · ${run.files.length} 个文件${run.safe ? '' : ' [不可安全撤销]'}`
        ).join('\n') || '没有可撤销的文件变更 Run');
      }
      const apply = argument.endsWith(' --apply');
      const runId = apply ? argument.slice(0, -' --apply'.length).trim() : argument.trim();
      if (!apply) {
        const preview = await this.agent.previewUndo(runId);
        return this.handled([
          `Run ${preview.runId}：${preview.operations} 次修改，${preview.files.length} 个文件`,
          ...preview.files.map((file) => `- ${file}`),
          preview.safe ? `确认后执行：/undo ${runId} --apply` : '该记录不完整，不能安全撤销。',
        ].join('\n'));
      }
      const result = await this.agent.undoRun(runId);
      return this.handled(`已撤销 Run ${runId}，恢复 ${result.restored.length} 个文件。`);
    }
    if (command === '/skills') {
      if (argument === 'reload') {
        const result = await this.agent.reloadSkills();
        return this.handled(`已重新加载 ${result.skills.length} 个 Skills${result.warnings.length ? `，${result.warnings.length} 个无效` : ''}`);
      }
      if (argument === 'active') {
        const active = this.agent.activeSkills
          ? await this.agent.activeSkills()
          : (await this.agent.listSkills()).filter((skill) => skill.active).map((skill) => ({
              name: skill.name,
              sourceId: skill.source.id,
              stale: skill.stale,
            }));
        return this.handled(active.map((skill) =>
          `- ${skill.name}: ${skill.sourceId}${skill.stale ? ' [stale]' : ' [active]'}`
        ).join('\n') || '当前 Session 没有已激活 Skill');
      }
      if (argument.startsWith('deactivate ')) {
        const name = argument.slice('deactivate '.length).trim();
        if (!this.agent.deactivateSkill) {
          return this.handled('当前远程 Host 暂不支持停用 Skill，请在本机 Session 中执行。');
        }
        const deactivated = await this.agent.deactivateSkill(name);
        return this.handled(deactivated ? `已停用 Skill：${name}` : `当前 Session 未激活 Skill：${name}`);
      }
      if (argument === 'deactivate') return this.handled('用法：/skills deactivate <name>');
      const persistent = argument.match(/^(enable|disable)\s+(project|user)\s+([a-z0-9]+(?:-[a-z0-9]+)*)$/);
      if (persistent) {
        if (!this.agent.setSkillEnabled) return this.handled('当前远程 Host 暂不支持持久 Skill 开关。');
        const [, action, scope, name] = persistent as [string, 'enable' | 'disable', 'project' | 'user', string];
        await this.agent.setSkillEnabled(name, scope, action === 'enable');
        return this.handled(`已在${scope === 'project' ? '项目' : '用户'}范围${action === 'enable' ? '启用' : '停用'} Skill：${name}`);
      }
      if (argument.startsWith('enable ') || argument.startsWith('disable ')) {
        return this.handled('用法：/skills <enable|disable> <project|user> <name>');
      }
      const skills = await this.agent.listSkills();
      return this.handled(skills.map((skill) => [
        `- ${skill.name}: ${skill.description}`,
        `  source: ${skill.source.id}${skill.active ? ' [active]' : skill.stale ? ' [stale]' : ''}${skill.enabled ? '' : ` [disabled:${skill.disabledScope}]`}${skill.available ? '' : ` [unavailable: ${skill.unavailableReasons.join(', ')}]`}`,
        `  location: ${skill.file}`,
      ].join('\n')).join('\n') || '暂无 Skills');
    }
    if (command === '/tools') {
      const tools = await this.agent.toolNames;
      return this.handled(tools.map((name) => `- ${name}`).join('\n') || '暂无工具');
    }
    if (command === '/mcp') {
      const statuses = argument === 'reload' ? await this.agent.reloadMcp() : await this.agent.mcpStatuses();
      if (!statuses.length) return this.handled('MCP 未配置');
      return this.handled(statuses.map((status) => status.state === 'connected'
        ? `● ${status.name} · ${status.transport} · ${status.tools} tools`
        : `○ ${status.name} · 连接失败 · ${status.error ?? '未知错误'}`).join('\n'));
    }
    if (command === '/context') {
      const info = await this.agent.contextInfo();
      const contextUsed = info.lastRequestInputTokens
        ?? info.requestEstimateTokens
        ?? info.modelViewTokens
        ?? info.effectiveTokens
        ?? info.estimatedTokens;
      const aggregatedSections = new Map<string, { tokens: number; truncated: boolean }>();
      for (const section of info.sections ?? []) {
        if (section.id === 'protocol-reserve' || section.estimatedTokens <= 0) continue;
        const current = aggregatedSections.get(section.id) ?? { tokens: 0, truncated: false };
        current.tokens += section.estimatedTokens;
        current.truncated ||= section.truncated;
        aggregatedSections.set(section.id, current);
      }
      const sectionTotal = [...aggregatedSections.values()]
        .reduce((total, section) => total + section.tokens, 0);
      const sections = [...aggregatedSections.entries()]
        .sort((left, right) => right[1].tokens - left[1].tokens)
        .map(([id, section]) =>
          `- ${CONTEXT_SECTION_LABELS[id] ?? id}：~${formatTokenCount(section.tokens)}（${formatPercentage(section.tokens, sectionTotal)}）${section.truncated ? '，已截断' : ''}`
        );
      return this.handled([
        `当前上下文 ${formatTokenCount(contextUsed)}/${formatTokenCount(info.contextWindow)}（${formatPercentage(contextUsed, info.contextWindow)}）`,
        ...(sections.length ? ['内容分布（估算）', ...sections] : ['内容分布：尚无模型请求']),
      ].join('\n'));
    }
    if (command === '/compact') {
      const result = await this.agent.compactContext();
      const archive = result.archive;
      return this.handled([
        result.message,
        archive ? `归档范围：${archive.coveredItems} 条 · ${archive.originalTokens} → ${archive.compactedTokens} tokens` : '',
      ].filter(Boolean).join('\n'));
    }
    if (command === '/instructions') {
      const guidance = await this.agent.guidanceInfo();
      if (!guidance.files.length) {
        return this.handled(
          '未找到 Soul、Preferences 或项目指令。'
          + 'Soul：~/.mimi-agent/MIMI.md · Preferences：~/.mimi-agent/PREFERENCES.md · 项目：AGENTS.md / CLAUDE.md',
        );
      }
      return this.handled(guidance.files.map((file) =>
        `${file.scope === 'project' ? '项目' : file.scope === 'preferences' ? 'Preferences' : 'Soul'}  `
        + `${file.path}${file.truncated ? '（已截断）' : ''}`,
      ).join('\n'));
    }
    if (command === '/memory') {
      const [operation = 'status', ...memoryArgs] = rest;
      const value = memoryArgs.join(' ').trim();
      const parseScope = (candidate?: string): MemoryScope | 'all' => (
        candidate === 'private' || candidate === 'workspace' ? candidate : 'all'
      );
      const parseRef = (candidate: string): MemoryRef => {
        const match = /^(private|workspace):(.+)$/.exec(candidate);
        if (!match) throw new Error('MemoryRef 格式必须是 private:<id> 或 workspace:<id>');
        return { scope: match[1] as MemoryScope, id: match[2]!, ...(match[1] === 'private' ? { profileId: 'owner' } : {}) };
      };
      if (operation === 'status') return this.handled(JSON.stringify(await this.agent.memoryStatus(), null, 2));
      if (operation === 'list') {
        const hits = await this.agent.memoryList(parseScope(value));
        return this.handled(hits.map((hit) => `- ${hit.ref.scope}:${hit.ref.id} [${hit.kind}/${hit.status}] ${hit.title} — ${hit.summary}`).join('\n') || '暂无 Memory');
      }
      if (operation === 'search') {
        if (!value) throw new Error('用法：/memory search <query>');
        const hits = await this.agent.memorySearch(value);
        return this.handled(hits.map((hit) => `- ${hit.ref.scope}:${hit.ref.id} [${hit.kind}/${hit.status}] ${hit.title} — ${hit.summary}`).join('\n') || '未找到相关 Memory');
      }
      if (operation === 'read') {
        if (!value) throw new Error('用法：/memory read <scope:id>');
        const document = await this.agent.memoryRead(parseRef(value));
        return this.handled(`${document.metadata.title}\n${document.body}`);
      }
      if (operation === 'forget') {
        if (!value) throw new Error('用法：/memory forget <scope:id>');
        const receipt = await this.agent.memoryForget(parseRef(value));
        return this.handled(receipt.forgotten ? `已遗忘 ${value}` : `Memory 不存在：${value}`);
      }
      if (operation === 'ingest') {
        if (!value) throw new Error('用法：/memory ingest <source-path>');
        const receipt = await this.agent.memoryIngest(value, signal);
        return this.handled(`Ingest ${receipt.status} · ${receipt.pageRefs.map((ref) => `${ref.scope}:${ref.id}`).join(', ')}`);
      }
      if (operation === 'capture') {
        const receipt = await this.agent.memoryCaptureRound(value || undefined);
        return this.handled(`Capture ${receipt.status} · receipt=${receipt.id} · ${receipt.pageRefs.map((ref) => `${ref.scope}:${ref.id}`).join(', ')}`);
      }
      if (operation === 'lint') {
        const report = await this.agent.memoryLint();
        return this.handled(report.issues.map((issue) => `- [${issue.severity}] ${issue.code}: ${issue.message}`).join('\n') || `检查 ${report.checked} 页，无问题`);
      }
      if (operation === 'refresh') {
        const limit = value ? Number(value) : 20;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
          throw new Error('用法：/memory refresh [1-50]');
        }
        const receipts = await this.agent.memoryRefresh(limit);
        return this.handled(receipts.length
          ? `已刷新 ${receipts.length} 个 stale 来源 · ${receipts.reduce((total, receipt) => total + receipt.pageRefs.length, 0)} 页`
          : '没有待刷新的 stale 来源');
      }
      if (operation === 'conflicts') {
        const limit = value ? Number(value) : 20;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('用法：/memory conflicts [1-200]');
        const conflicts = await this.agent.memoryConflicts(limit);
        return this.handled(conflicts.map((hit) => `- ${hit.ref.scope}:${hit.ref.id} ${hit.title}`).join('\n') || '暂无冲突');
      }
      if (operation === 'audit') {
        const limit = value ? Number(value) : 20;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('用法：/memory audit [1-200]');
        const decisions = await this.agent.memoryAudit(limit);
        return this.handled(decisions.map((decision) =>
          `- ${decision.createdAt} ${decision.operation}/${decision.reasonCode}${decision.refId ? ` · ${decision.refId}` : ''}`,
        ).join('\n') || '暂无 Memory 决策记录');
      }
      if (operation === 'maintain') {
        if (!this.agent.memoryMaintain) throw new Error('当前入口没有 Daemon maintenance 控制面');
        return this.handled(JSON.stringify(await this.agent.memoryMaintain(), null, 2));
      }
      if (operation === 'reindex') return this.handled(JSON.stringify(await this.agent.memoryReindex(), null, 2));
      throw new Error(`未知 /memory 操作：${operation}`);
    }
    if (command === '/plan') {
      const plan = await this.agent.currentPlan();
      return this.handled(plan.map((step) => `- [${step.status}] ${step.id}. ${step.description}`).join('\n') || '当前没有计划');
    }
    if (command === '/team') {
      const tasks = await this.agent.currentTeam();
      return this.handled(tasks.map((task) => [
        `- [${task.status}] ${task.id} · ${task.role} · ${task.description}`,
        task.dependencies.length ? `依赖 ${task.dependencies.join(', ')}` : '',
        task.owner ? `负责人 ${task.owner}` : '',
        task.result ? `结果 ${task.result.slice(0, 240)}` : '',
      ].filter(Boolean).join(' · ')).join('\n') || '当前没有 Ultra Team 任务');
    }
    if (command === '/tasks') {
      const limit = argument ? Number(argument) : 20;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
        throw new Error('用法：/tasks [1-50]');
      }
      if (!this.agent.listBackgroundTasks) {
        return this.handled('当前运行方式不支持后台任务管理，请通过统一 mimi CLI 连接后台。');
      }
      const tasks = await this.agent.listBackgroundTasks(limit);
      return this.handled(tasks.map(taskListLine).join('\n') || '暂无后台任务。');
    }
    if (command === '/task') {
      const [actionOrId, taskId, ...reasonParts] = rest;
      if (actionOrId === 'cancel') {
        if (!taskId) throw new Error('用法：/task cancel <task-id> [reason]');
        if (!this.agent.cancelBackgroundTask) {
          return this.handled('当前运行方式不支持后台任务管理，请通过统一 mimi CLI 连接后台。');
        }
        const result = await this.agent.cancelBackgroundTask(taskId, reasonParts.join(' ').trim() || undefined);
        if (result.state === 'cancelled') return this.handled(`已请求取消后台任务：${taskId}`);
        if (result.state === 'already_terminal') return this.handled(`后台任务已经结束，无需取消：${taskId}`);
        return this.handled(`未找到后台任务：${taskId}`);
      }
      if (actionOrId === 'pause') {
        if (!taskId) throw new Error('用法：/task pause <task-id>');
        if (!this.agent.pauseBackgroundTask) {
          return this.handled('当前运行方式不支持暂停后台任务，请通过统一 mimi CLI 连接后台。');
        }
        const result = await this.agent.pauseBackgroundTask(taskId, reasonParts.join(' ').trim() || undefined);
        if (result.state === 'paused') return this.handled(`已暂停后台任务：${taskId}`);
        if (result.state === 'pause_requested') {
          return this.handled(`已请求暂停后台任务，将在当前工具调用完成后的安全点暂停：${taskId}`);
        }
        if (result.state === 'already_paused') return this.handled(`后台任务已经暂停：${taskId}`);
        if (result.state === 'already_terminal') return this.handled(`后台任务已经结束，无法暂停：${taskId}`);
        if (result.state === 'not_pauseable') return this.handled(`后台任务当前无法暂停：${taskId}`);
        return this.handled(`未找到后台任务：${taskId}`);
      }
      if (actionOrId === 'resume') {
        if (!taskId) throw new Error('用法：/task resume <task-id> [context]');
        if (!this.agent.resumeBackgroundTask) {
          return this.handled('当前运行方式不支持继续后台任务，请通过统一 mimi CLI 连接后台。');
        }
        const result = await this.agent.resumeBackgroundTask(taskId, reasonParts.join(' ').trim() || undefined);
        if (result.state === 'resumed') return this.handled(`后台任务已重新排队继续：${taskId}`);
        if (result.state === 'not_resumable') return this.handled(`后台任务当前不是 paused/blocked 状态：${taskId}`);
        return this.handled(`未找到后台任务：${taskId}`);
      }
      if (!actionOrId) {
        throw new Error('用法：/task <task-id>、/task pause <task-id>、/task resume <task-id> [context] 或 /task cancel <task-id> [reason]');
      }
      if (!this.agent.inspectBackgroundTask) {
        return this.handled('当前运行方式不支持后台任务管理，请通过统一 mimi CLI 连接后台。');
      }
      return this.handled(taskDetails(await this.agent.inspectBackgroundTask(actionOrId)));
    }
    if (command === '/goal') {
      const goal = argument ? await this.agent.setGoal(argument) : await this.agent.currentGoal();
      if (!goal) return this.handled('当前没有长期 Goal。使用 /goal <目标> 设置。');
      return this.handled([
        `[${goal.status}] ${goal.objective}`,
        goal.checkpoint ? `检查点：${goal.checkpoint}` : '',
        goal.nextAction ? `下一步：${goal.nextAction}` : '',
      ].filter(Boolean).join('\n'));
    }
    if (command === '/confirm-send') {
      if (!argument) throw new Error('用法：/confirm-send <text>');
      this.print('正在按结构化确认发送个人消息...');
      await this.runTask('发送 owner 已通过结构化命令确认的个人消息。', signal, {
        approvedPersonalMessageText: argument,
      });
      return 'handled';
    }
    if (command === '/resume') {
      const prompt = await this.agent.resumePrompt();
      this.print('正在依据持久任务状态继续...');
      await this.runTask(prompt, signal, { resumeState: true });
      return 'handled';
    }
    if (command === '/retry') {
      const lastInput = this.lastInputs.get(this.agent.currentSessionId);
      if (!lastInput) return this.handled('当前对话没有可重试的用户输入。');
      this.print(`重新执行：${lastInput}`);
      await this.runTask(lastInput, signal);
      return 'handled';
    }

    return this.handled(`未知命令：${command}。输入 /help 查看可用命令。`);
  }

  private handled(text: string): CommandResult {
    this.print(text);
    return 'handled';
  }

  private print(text: string): void {
    if (this.ui.write) this.ui.write(text);
    else console.log(text);
  }
}

export function commandHelp(): string {
  return HELP;
}
