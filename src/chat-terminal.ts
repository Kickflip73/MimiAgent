import process from 'node:process';
import {
  loadConfig,
  preferredEnvironmentValue,
  restrictSecurityProfile,
  SECURITY_PROFILES,
  type AppConfig,
  type SecurityProfile,
} from './config.js';
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
import { parseRequestedLocalRunPolicy } from './daemon/local-run-policy.js';
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
  securityProfile: SecurityProfile;
}

class SteeringInputAcceptedError extends Error {}

export const CHAT_HELP = `${commandHelp()}

这些命令作用于后台唯一 MimiAgent。/exit 只关闭当前终端。`;

function runLabel(_input: string): string {
  return '模型思考中';
}

const SECURITY_PROFILE_ORDER = ['safe', 'workstation', 'full-owner'] as const;

function securityProfileForPermission(permissionMode: string | undefined): SecurityProfile {
  if (permissionMode === 'read-only') return 'safe';
  if (permissionMode === 'workspace') return 'workstation';
  return 'full-owner';
}

export function renderChatHistory(snapshot: MimiChatSnapshot, tty: boolean): string {
  return [
    renderSessionTranscript(snapshot.items, tty),
    renderRecoveryCheckpoint(snapshot.recovery, tty),
  ].filter(Boolean).join('\n\n');
}

function renderBanner(version: string, snapshot: MimiChatSnapshot): string {
  const tty = process.stdout.isTTY;
  const termCols = process.stdout.columns ?? 80;
  const boxWidth = Math.max(20, termCols);
  const inner = boxWidth - 2;

  // CJK-aware width
  const ansiRe = /\x1b\[[0-9;]*m/g;
  const cjkRe = /[\u2e80-\u2eff\u2f00-\u2fdf\u3000-\u303f\u31c0-\u31ef\u3200-\u32ff\u3300-\u33ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/;
  function cw(s: string): number {
    let w = 0;
    for (const c of Array.from(s.replace(ansiRe, ''))) {
      w += cjkRe.test(c) ? 2 : 1;
    }
    return w;
  }

  function padOrTruncate(s: string, w: number): string {
    const raw = s.replace(ansiRe, '');
    if (cw(raw) <= w) return s + ' '.repeat(w - cw(raw));
    let out = '', used = 0;
    for (const c of Array.from(raw)) {
      const cw1 = cjkRe.test(c) ? 2 : 1;
      if (used + cw1 > w - 1) break;
      out += c; used += cw1;
    }
    return out + '…' + ' '.repeat(Math.max(0, w - used - 1));
  }

  const dim = tty ? '\x1b[2m' : '';
  const rst = tty ? '\x1b[0m' : '';
  const bar = '─'.repeat(inner);

  const top = `^._.^  MimiAgent v${version}  全天候个人 Agent`;

  const modelLabel = snapshot.provider && !snapshot.model.startsWith(snapshot.provider)
    ? `${snapshot.provider} · ${snapshot.model}`
    : snapshot.model;

  const modeLabel = snapshot.mode ?? '通用';
  const sessionLabel = snapshot.draft ? '新会话' : snapshot.sessionId;

  const rows = [
    `${dim}┌${bar}┐${rst}`,
    `${dim}│${rst}${padOrTruncate(top, inner)}${dim}│${rst}`,
    `${dim}│${rst}${padOrTruncate(`模型     ${modelLabel}`, inner)}${dim}│${rst}`,
    `${dim}│${rst}${padOrTruncate(`模式     ${modeLabel}`, inner)}${dim}│${rst}`,
    `${dim}│${rst}${padOrTruncate(`工作区   ${snapshot.workspaceRoot}`, inner)}${dim}│${rst}`,
    `${dim}│${rst}${padOrTruncate(`会话     ${sessionLabel}`, inner)}${dim}│${rst}`,
    `${dim}└${bar}┘${rst}`,
  ];

  return rows.join('\n');
}

export async function runMimiCli(
  config: AppConfig,
  args: string[],
  version: string,
  reconcileDaemon?: DaemonReconciler,
): Promise<void> {
  const requestedRunPolicy = parseRequestedLocalRunPolicy(
    process.env.MIMI_CONVERSATION_RUN_POLICY,
  );
  const client = new MimiChatClient(config, reconcileDaemon, {
    ...(requestedRunPolicy ? { requestedRunPolicy } : {}),
  });
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
  let selectedSecurityProfile = securityProfileForPermission(snapshot.permissionMode);
  let activeSecurityProfile: SecurityProfile | undefined;
  let cyclingMode = false;
  let draining = false;
  let steeringSubmissions = Promise.resolve();
  let closed = false;
  let resolveClosed!: () => void;
  const closedPromise = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const tty = Boolean(process.stdout.isTTY);

  const updateTerminalRuntimeStatus = () => {
    const displayedSecurityProfile = activeSecurityProfile ?? selectedSecurityProfile;
    terminal.setRuntimeStatus({
      mode: snapshot.mode,
      model: snapshot.model,
      permissionMode: SECURITY_PROFILES[displayedSecurityProfile].permissionMode,
      contextUsed: snapshot.contextUsed,
      contextWindow: snapshot.contextWindow,
    });
  };
  const refresh = async () => {
    snapshot = target.sessionReady
      ? await client.snapshot(30, target.currentSessionId)
      : await client.bootstrap(target.currentSessionId);
    terminal.useSession(snapshot.sessionId);
    const configuredSecurityProfile = securityProfileForPermission(snapshot.permissionMode);
    selectedSecurityProfile = restrictSecurityProfile(
      configuredSecurityProfile,
      selectedSecurityProfile,
    );
    updateTerminalRuntimeStatus();
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
    securityProfile = activeSecurityProfile ?? selectedSecurityProfile,
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
        const submission = client.submit(input, target.currentSessionId, {
          ...submitOptions,
          requestedSecurityProfile: securityProfile,
        });
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
        activeSecurityProfile = pending.securityProfile;
        updateTerminalRuntimeStatus();
        try {
          terminal.setBusy(true);
          const result = await commands.execute(pending.text, activeAbort.signal);
          if (result === 'exit') {
            close();
            break;
          }
          if (result === 'handled') continue;
          commands.remember(pending.text);
          await submitAndDisplay(
            pending.text,
            activeAbort.signal,
            pending.acceptedEventId,
            undefined,
            pending.securityProfile,
          );
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
          activeSecurityProfile = undefined;
          terminal.setBusy(false);
          if (!closed) await refresh().catch(() => undefined);
        }
      }
    } finally {
      draining = false;
      if ((steeringQueue.length || queue.length) && !closed) void drain();
    }
  };
  const submitSteeringInput = async (input: string, securityProfile: SecurityProfile) => {
    try {
      // Preserve event order if Command+Enter arrives while the active input is
      // still crossing the durable submit boundary.
      await activeSubmission;
      const accepted = await client.submit(input, target.currentSessionId, {
        requestedSecurityProfile: securityProfile,
      });
      target.markSessionReady();
      snapshot.draft = false;
      if (closed) return;
      steeringQueue.push({
        text: input,
        intent: 'steer',
        acceptedEventId: accepted.eventId,
        securityProfile,
      });
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
  const header = [renderBanner(version, snapshot), renderChatHistory(snapshot, tty)]
    .filter(Boolean).join('\n\n');
  terminal.clearScreen(header);
  terminal.start({
    onLine: (input, intent) => {
      if (input.trim() === '/exit') {
        close();
        return;
      }
      if (intent === 'steer' && !input.trim().startsWith('/')) {
        const securityProfile = selectedSecurityProfile;
        steeringSubmissions = steeringSubmissions.then(() => (
          submitSteeringInput(input, securityProfile)
        ));
        return;
      }
      queue.push({ text: input, intent: 'enqueue', securityProfile: selectedSecurityProfile });
      refreshQueue();
      void drain();
    },
    onEscape: () => {
      if (!activeAbort || activeAbort.signal.aborted) return;
      activeCancelRequested = true;
      cancelActiveEvent();
      activeAbort.abort(new Error('用户按下 Esc 取消任务'));
    },
    onCancelQueue: () => {
      if (queue.length === 0) return;
      const removed = queue.pop();
      refreshQueue();
      terminal.notify(`已取消排队："${(removed?.text ?? '').slice(0, 40)}"`);
    },
    onSecurityCycle: () => {
      const configured = securityProfileForPermission(snapshot.permissionMode);
      const available = SECURITY_PROFILE_ORDER.filter((profile) => (
        restrictSecurityProfile(configured, profile) === profile
      ));
      const current = available.indexOf(selectedSecurityProfile);
      selectedSecurityProfile = available[(current + 1) % available.length] ?? configured;
      if (!activeSecurityProfile) updateTerminalRuntimeStatus();
      terminal.notify(`后续输入使用 ${SECURITY_PROFILES[selectedSecurityProfile].label}。`);
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
