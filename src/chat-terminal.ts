import process from 'node:process';
import { loadConfig, preferredEnvironmentValue, type AppConfig } from './config.js';
import {
  COMMANDS,
  CommandHandler,
  commandHelp,
  type CommandRunOptions,
} from './commands.js';
import {
  MimiChatClient,
  RemoteCommandTarget,
  eventAnswer,
  eventEffects,
  synchronizeRemoteRuntimeEffects,
  type DaemonReconciler,
} from './daemon/chat-client.js';
import type { MimiChatSnapshot } from './daemon/types.js';
import {
  configuredProviderRequest,
  persistProviderConfiguration,
} from './provider-config.js';
import {
  InteractiveTerminal,
  type CompletionItem,
  type QueuedInput,
} from './interactive.js';
import {
  normalizeOutputLevel,
  OUTPUT_LEVELS,
  renderRecoveryCheckpoint,
  renderSessionTranscript,
  TerminalRenderer,
} from './terminal.js';

const CHAT_COMMANDS: CompletionItem[] = [...COMMANDS];

interface PendingChatInput extends QueuedInput {
  acceptedEventId?: string;
}

class SteeringInputAcceptedError extends Error {}

export const CHAT_HELP = `${commandHelp()}

这些命令作用于后台唯一 MimiAgent。/exit 只关闭当前终端。`;

function runLabel(_input: string): string {
  return '模型思考中';
}

export function renderChatHistory(snapshot: MimiChatSnapshot, tty: boolean): string {
  return [
    renderSessionTranscript(snapshot.items, tty),
    renderRecoveryCheckpoint(snapshot.recovery, tty),
  ].filter(Boolean).join('\n\n');
}

function renderBanner(version: string, snapshot: MimiChatSnapshot): string {
  return [
    `MimiAgent v${version}`,
    '全天候个人 Agent · CLI 已连接统一后台',
    `模型    ${snapshot.provider} · ${snapshot.model}`,
    `对话    ${snapshot.draft ? '新对话（发送消息后创建）' : snapshot.sessionId}`,
    `工作区  ${snapshot.workspaceRoot}`,
    `权限    ${snapshot.securityProfile.label} · /security 上下选择`,
  ].join('\n');
}

export async function runMimiCli(
  config: AppConfig,
  args: string[],
  version: string,
  reconcileDaemon?: DaemonReconciler,
): Promise<void> {
  const client = reconcileDaemon
    ? new MimiChatClient(config, reconcileDaemon)
    : new MimiChatClient(config);
  await client.connect();
  const switchProvider = async (
    provider: 'openai' | 'deepseek' | 'openai-compatible',
    model?: string,
  ) => {
    const current = await client.status();
    if (current.providerHealth?.provider === provider && !model) return;
    const configured = configuredProviderRequest(provider);
    const request = model
      ? {
          ...configured,
          model,
          models: [...new Set([model, ...(configured.models ?? [])])],
        }
      : configured;
    await persistProviderConfiguration(request);
    const { restartMimiDaemon } = await import('./daemon/service.js');
    await restartMimiDaemon(loadConfig());
  };
  const configuredSession = preferredEnvironmentValue('MIMI_SESSION', 'AGENT_SESSION');
  const oneShotInput = args.join(' ').trim();
  if (oneShotInput) {
    const current = configuredSession
      ? await client.snapshot(30, configuredSession)
      : await client.bootstrap();
    const renderer = new TerminalRenderer(process.stderr, process.stdout, normalizeOutputLevel(current.outputLevel));
    renderer.start(runLabel(oneShotInput), oneShotInput);
    let streamedAnswer = '';
    try {
      const accepted = await client.submit(oneShotInput, current.sessionId);
      const event = await client.wait(accepted.eventId, undefined, (streamed) => {
        if (streamed.kind === 'plan') return;
        if (streamed.kind === 'answer') streamedAnswer += streamed.text;
        renderer.handleDisplay(streamed);
      });
      const providerEffect = [...eventEffects(event)].reverse().find((effect) => (
        effect.type === 'provider_change_requested'
      ));
      const answer = eventAnswer(event);
      if (!streamedAnswer) renderer.handleDisplay({ kind: 'answer', text: answer });
      else if (answer.startsWith(streamedAnswer)) {
        const tail = answer.slice(streamedAnswer.length);
        if (tail) renderer.handleDisplay({ kind: 'answer', text: tail });
      }
      renderer.finish();
      if (providerEffect?.type === 'provider_change_requested') {
        await switchProvider(providerEffect.provider);
      }
    } catch (error) {
      renderer.stop();
      throw error;
    }
    return;
  }

  let snapshot = configuredSession
    ? await client.snapshot(30, configuredSession)
    : await client.bootstrap();
  const target = new RemoteCommandTarget(client, snapshot.sessionId, !snapshot.draft);
  const terminal = new InteractiveTerminal(CHAT_COMMANDS);
  const queue: PendingChatInput[] = [];
  const steeringQueue: PendingChatInput[] = [];
  let activeAbort: AbortController | undefined;
  let activeSubmission: Promise<void> | undefined;
  let activeEventId: string | undefined;
  let activeCancelRequested = false;
  let activeCancelSent = false;
  let cyclingMode = false;
  let draining = false;
  let steeringSubmissions = Promise.resolve();
  let closed = false;
  let resolveClosed!: () => void;
  const closedPromise = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const tty = Boolean(process.stdout.isTTY);

  const refresh = async () => {
    snapshot = target.sessionReady
      ? await client.snapshot(30, target.currentSessionId)
      : await client.bootstrap(target.currentSessionId);
    terminal.useSession(snapshot.sessionId);
    terminal.setRuntimeStatus({
      mode: snapshot.mode,
      model: snapshot.model,
      contextUsed: snapshot.contextUsed,
      contextWindow: snapshot.contextWindow,
    });
    terminal.setTasks(snapshot.plan);
  };
  const close = () => {
    if (closed) return;
    closed = true;
    queue.length = 0;
    steeringQueue.length = 0;
    activeAbort?.abort(new Error('终端已退出；MimiAgent 任务继续在后台执行'));
    terminal.setQueue([]);
    terminal.close();
    resolveClosed();
  };
  const cancelActiveEvent = () => {
    const eventId = activeEventId;
    if (!eventId || activeCancelSent) return;
    activeCancelSent = true;
    void client.cancel(eventId, '用户按下 Esc 取消任务').then((result) => {
      if (result.state === 'not_found') terminal.notify(`未找到可取消的任务：${eventId}`);
    }).catch((error) => {
      terminal.notify(`取消任务失败：${error instanceof Error ? error.message : String(error)}`);
    });
  };
  const submitAndDisplay = async (
    input: string,
    signal = activeAbort?.signal,
    acceptedEventId?: string,
    submitOptions?: CommandRunOptions,
  ) => {
    const renderer = new TerminalRenderer(
      terminal.createWriter(process.stderr),
      terminal.createWriter(process.stdout),
      normalizeOutputLevel(snapshot.outputLevel),
    );
    renderer.start(runLabel(input), input);
    let streamedAnswer = '';
    try {
      let accepted = acceptedEventId
        ? { eventId: acceptedEventId, inserted: true }
        : undefined;
      if (!accepted) {
        const submission = client.submit(input, target.currentSessionId, submitOptions);
        const settled = submission.then(() => undefined, () => undefined);
        activeSubmission = settled;
        try {
          accepted = await submission;
        } finally {
          if (activeSubmission === settled) activeSubmission = undefined;
        }
      }
      target.markSessionReady();
      snapshot.draft = false;
      activeEventId = accepted.eventId;
      if (activeCancelRequested) cancelActiveEvent();
      const event = await client.wait(accepted.eventId, signal, (streamed) => {
        if (streamed.kind === 'plan') {
          terminal.setTasks(streamed.steps);
          return;
        }
        if (streamed.kind === 'answer') streamedAnswer += streamed.text;
        renderer.handleDisplay(streamed);
      });
      const effects = eventEffects(event);
      const answer = eventAnswer(event);
      if (!streamedAnswer) renderer.handleDisplay({ kind: 'answer', text: answer });
      else if (answer.startsWith(streamedAnswer)) {
        const tail = answer.slice(streamedAnswer.length);
        if (tail) renderer.handleDisplay({ kind: 'answer', text: tail });
      }
      renderer.finish();
      await synchronizeRemoteRuntimeEffects(target, effects, {
        restoreSession,
        resetSession,
        switchProvider,
        close,
      });
    } catch (error) {
      renderer.stop();
      throw error;
    }
  };
  const restoreSession = async () => {
    await refresh();
    terminal.clearScreen([renderBanner(version, snapshot), renderChatHistory(snapshot, tty)]
      .filter(Boolean).join('\n\n'));
  };
  const resetSession = async () => {
    await refresh();
    terminal.clearScreen(renderBanner(version, snapshot));
  };
  const commands = new CommandHandler(target, (input, signal, options) =>
    submitAndDisplay(input, signal, undefined, options), {
    write: (text) => terminal.notify(text),
    resetScreen: async () => {
      await resetSession();
    },
    restoreSession,
    selectSession: async (sessions) => terminal.select(sessions.map((session) => ({
      value: session.id,
      label: `${session.id === target.currentSessionId ? '● ' : ''}${session.title}`,
      detail: `${session.recoverable ? '↻ 可恢复 · ' : ''}${session.turns} 轮 · ${session.preview}`,
    })), '选择 MimiAgent 对话', target.currentSessionId),
    selectModel: async (models, current) => {
      const currentIndex = models.findIndex((choice) => (
        choice.provider === current.provider && choice.model === current.model
      ));
      const selected = await terminal.select(models.map((choice, index) => ({
        value: String(index),
        label: `${index === currentIndex ? '● ' : ''}${choice.model}`,
        detail: choice.providerLabel,
      })), '选择模型', currentIndex >= 0 ? String(currentIndex) : undefined);
      return selected === undefined ? undefined : models[Number(selected)];
    },
    switchProvider,
    selectMode: async (modes, current) => terminal.select(modes.map((mode) => ({
      value: mode.id,
      label: `${mode.id === current ? '● ' : ''}${mode.label}`,
      detail: mode.description,
    })), '选择模式', current),
    selectSecurityProfile: async (profiles, current) => terminal.select(profiles.map((profile) => {
      const workspaceAccess = profile.id === 'safe'
        ? '只读工作区'
        : profile.id === 'workstation' ? '工作区可写' : '当前 OS 用户权限';
      const capabilities = [
        profile.shell ? 'Shell' : '无 Shell',
        profile.externalTransactions ? '外部写事务' : '无外部写事务',
        profile.computerUse ? '可配置 Computer Use' : '无 Computer Use',
        profile.trustedWorkspaceMcp ? '受信工作区 MCP' : '无受信工作区 MCP',
        profile.ephemeralSensitiveModelAccess ? '敏感值可发模型' : '敏感值不发模型',
      ].join(' · ');
      return {
        value: profile.id,
        label: `${profile.id === current ? '● ' : ''}${profile.label}`,
        detail: `${workspaceAccess} · ${capabilities}`,
      };
    }), '选择当前对话安全档位', current),
    getOutputLevel: () => normalizeOutputLevel(snapshot.outputLevel),
    setOutputLevel: async (level) => {
      await target.setOutputLevel(level);
      snapshot.outputLevel = level;
    },
    selectOutputLevel: async (current) => terminal.select(OUTPUT_LEVELS.map((level) => ({
      value: level.id,
      label: `${level.id === current ? '● ' : ''}${level.label}`,
      detail: level.description,
    })), '选择输出等级', current),
  });
  const visibleQueue = (): QueuedInput[] => [
    ...steeringQueue.map(({ text, intent }) => ({ text, intent })),
    ...queue.map(({ text, intent }) => ({ text, intent })),
  ];
  const refreshQueue = () => terminal.setQueue(visibleQueue());
  const drain = async () => {
    if (draining) return;
    draining = true;
    try {
      while ((steeringQueue.length || queue.length) && !closed) {
        const pending = steeringQueue.shift() ?? queue.shift()!;
        refreshQueue();
        terminal.recordInput(pending.text);
        activeAbort = new AbortController();
        activeEventId = undefined;
        activeCancelRequested = false;
        activeCancelSent = false;
        try {
          terminal.setBusy(true);
          const result = await commands.execute(pending.text, activeAbort.signal);
          if (result === 'exit') {
            close();
            break;
          }
          if (result === 'handled') continue;
          commands.remember(pending.text);
          await submitAndDisplay(pending.text, activeAbort.signal, pending.acceptedEventId);
        } catch (error) {
          const message = activeCancelRequested
            ? '已请求取消当前任务。'
            : error instanceof SteeringInputAcceptedError
              ? '已接收新指引，正在切换方向。'
            : activeAbort.signal.aborted
              ? '已停止等待；任务仍由 MimiAgent 在后台可靠执行，可稍后用 /history 查看结果。'
              : `运行失败：${error instanceof Error ? error.message : String(error)}`;
          terminal.notify(message);
        } finally {
          activeAbort = undefined;
          activeEventId = undefined;
          activeCancelRequested = false;
          activeCancelSent = false;
          terminal.setBusy(false);
          if (!closed) await refresh().catch(() => undefined);
        }
      }
    } finally {
      draining = false;
      if ((steeringQueue.length || queue.length) && !closed) void drain();
    }
  };
  const submitSteeringInput = async (input: string) => {
    try {
      // Preserve event order if Command+Enter arrives while the active input is
      // still crossing the durable submit boundary.
      await activeSubmission;
      const accepted = await client.submit(input, target.currentSessionId);
      target.markSessionReady();
      snapshot.draft = false;
      if (closed) return;
      steeringQueue.push({ text: input, intent: 'steer', acceptedEventId: accepted.eventId });
      refreshQueue();
      activeAbort?.abort(new SteeringInputAcceptedError('新指引已由 MimiAgent 接收'));
      void drain();
    } catch (error) {
      if (!closed) {
        terminal.notify(`立即引导发送失败，当前任务继续执行：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };

  await refresh();
  process.stdout.write(`${renderBanner(version, snapshot)}\n`);
  const history = renderChatHistory(snapshot, tty);
  if (history) process.stdout.write(`\n${history}\n`);
  terminal.start({
    onLine: (input, intent) => {
      if (input.trim() === '/exit') {
        close();
        return;
      }
      if (intent === 'steer' && !input.trim().startsWith('/')) {
        steeringSubmissions = steeringSubmissions.then(() => submitSteeringInput(input));
        return;
      }
      queue.push({ text: input, intent: 'enqueue' });
      refreshQueue();
      void drain();
    },
    onEscape: () => {
      if (!activeAbort || activeAbort.signal.aborted) return;
      activeCancelRequested = true;
      cancelActiveEvent();
      activeAbort.abort(new Error('用户按下 Esc 取消任务'));
    },
    onModeCycle: () => {
      if (cyclingMode) return;
      cyclingMode = true;
      void (async () => {
        try {
          const modes = await target.availableModes();
          const current = modes.findIndex((mode) => mode.label === snapshot.mode);
          const next = modes[(current + 1) % modes.length];
          if (!next) return;
          await target.switchMode(next.id);
          await refresh();
          terminal.notify(`已切换到 ${next.label} 模式。`);
        } catch (error) {
          terminal.notify(`切换模式失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
          cyclingMode = false;
        }
      })();
    },
    onExit: close,
  });
  await closedPromise;
}
