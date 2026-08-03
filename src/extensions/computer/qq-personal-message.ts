import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  personalMessageContextSchema,
  personalMessageResultSchema,
  type PersonalMessageAuthorization,
  type PersonalMessageContext,
  type PersonalMessageResult,
} from '../../core/personal-message.js';
import { withExclusiveFileLock } from '../../core/state-file.js';
import {
  ComputerManager,
  type ComputerHostObservation,
  type ComputerRunAuthority,
} from './manager.js';
import type { ComputerAccess, ComputerElement, ComputerTargetSummary } from './types.js';

const QQ_BUNDLE_ID = 'com.tencent.qq';
const MAX_QQ_SEND_CHARS = 500;
const MAX_CONTEXT_TEXT_CHARS = 20_000;
const QQ_CONVERSATION_PREFIX = 'qq:visible_ax:sha256:';

export interface QqPersonalMessageCapability {
  accountVerified: true;
  inboundCoverage: 'bounded';
  contextRead: 'bounded';
  sendRoute: 'computer';
  deliveryConfirmed: true;
  backgroundSafe: true;
  changesReadState: false;
  stableConversationId: true;
  stableMessageId: true;
  probedAt: string;
}

export interface QqPersonalMessageProbe {
  ready: true;
  capability: QqPersonalMessageCapability;
}

interface ParsedQqObservation {
  observation: ComputerHostObservation;
  input: ComputerElement;
  messages: PersonalMessageContext['messages'];
  latestFingerprint: string;
}

function normalized(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

function fingerprint(namespace: string, value: string): string {
  return `sha256:${createHash('sha256').update(`${namespace}\0${normalized(value)}`).digest('hex')}`;
}

function contentFingerprint(namespace: string, value: string): string {
  return `sha256:${createHash('sha256').update(`${namespace}\0${value}`).digest('hex')}`;
}

export function qqVisibleAccountFingerprint(accountLabel: string): string {
  return fingerprint('qq-account-visible-ax-v1', accountLabel);
}

export function qqVisibleConversationId(title: string): string {
  return `${QQ_CONVERSATION_PREFIX}${createHash('sha256')
    .update(`qq-conversation-visible-ax-v1\0${normalized(title)}`)
    .digest('hex')}`;
}

function label(element: ComputerElement): string {
  return normalized(rawText(element));
}

function rawText(element: ComputerElement): string {
  const value = typeof element.value === 'string' ? element.value : element.label;
  return typeof value === 'string' ? value : '';
}

function frame(element: ComputerElement) {
  return element.frame ?? { x: 0, y: 0, width: 0, height: 0 };
}

function inputElement(elements: readonly ComputerElement[]): ComputerElement {
  const candidates = elements.filter((element) => (
    element.role === 'AXTextArea'
    && element.writable === true
    && frame(element).width >= 300
  ));
  const input = [...candidates].sort((left, right) => (
    frame(right).y - frame(left).y || frame(right).width - frame(left).width
  ))[0];
  if (!input) throw new Error('qq_input_unavailable：未找到可验证的 QQ 消息输入框');
  return input;
}

function activeConversationTitle(
  observation: ComputerHostObservation,
  input: ComputerElement,
): string {
  const inputFrame = frame(input);
  const top = observation.target.bounds.y;
  const candidates = observation.elements.filter((element) => {
    const item = frame(element);
    const value = label(element);
    return element.role === 'AXButton'
      && value.length > 0
      && item.x >= inputFrame.x
      && item.y > top
      && item.y < Math.min(inputFrame.y, top + 240)
      && item.width >= 40
      && !['聊天记录', '更多', '最小化', '最大化', '关闭'].includes(value);
  });
  const selected = [...candidates].sort((left, right) => (
    Math.abs(frame(left).x - inputFrame.x) - Math.abs(frame(right).x - inputFrame.x)
      || frame(left).y - frame(right).y
  ))[0];
  const title = selected ? label(selected) : '';
  if (!title) throw new Error('qq_conversation_unavailable：无法识别当前 QQ 会话');
  return title;
}

function assertAccount(
  observation: ComputerHostObservation,
  input: ComputerElement,
  expectedFingerprint: string,
): void {
  const inputFrame = frame(input);
  const top = observation.target.bounds.y;
  const matches = observation.elements.filter((element) => {
    const value = label(element);
    const item = frame(element);
    return value.length > 0
      && item.x < inputFrame.x
      && item.y >= top
      && item.y < top + Math.min(220, observation.target.bounds.height * 0.3)
      && qqVisibleAccountFingerprint(value) === expectedFingerprint;
  });
  if (matches.length === 0) {
    throw new Error('qq_account_mismatch：当前 QQ 账号指纹无法唯一验证');
  }
}

function contextMessages(
  observation: ComputerHostObservation,
  input: ComputerElement,
  limit: number,
): PersonalMessageContext['messages'] {
  const inputFrame = frame(input);
  const top = observation.target.bounds.y;
  const rows = observation.elements.flatMap((element) => {
    if (element.role !== 'AXStaticText') return [];
    const text = rawText(element).slice(0, 2_000);
    const item = frame(element);
    if (!text.trim() || item.x < inputFrame.x || item.y <= top + 120 || item.y >= inputFrame.y) return [];
    if (/^(?:[01]?\d|2[0-3]):[0-5]\d$/u.test(text.trim())) return [];
    const center = item.x + item.width / 2;
    const relativeCenter = inputFrame.width > 0
      ? (center - inputFrame.x) / inputFrame.width
      : 0.5;
    const direction = relativeCenter <= 0.48
      ? 'incoming' as const
      : relativeCenter >= 0.60 ? 'outgoing' as const : undefined;
    if (!direction) return [];
    return [{
      id: contentFingerprint('qq-visible-message-v1', `${direction}\0${text}\0${item.y}`),
      direction,
      text,
      x: item.x,
      y: item.y,
    }];
  }).sort((left, right) => left.y - right.y || left.x - right.x);
  const deduplicated = rows.filter((row, index) => (
    index === 0 || row.id !== rows[index - 1]?.id
  ));
  const bounded = deduplicated.slice(-limit);
  while (bounded.length > 0
    && bounded.reduce((total, message) => total + message.text.length, 0) > MAX_CONTEXT_TEXT_CHARS) {
    bounded.shift();
  }
  return bounded.map(({ id, direction, text }) => ({ id, direction, text }));
}

function latestFingerprint(messages: PersonalMessageContext['messages']): string {
  const latest = messages.at(-1);
  return contentFingerprint('qq-visible-context-v1', JSON.stringify(latest ? {
    id: latest.id,
    direction: latest.direction,
    text: latest.text,
  } : { empty: true }));
}

function messageCount(messages: PersonalMessageContext['messages'], text: string): number {
  return messages.filter((message) => message.direction === 'outgoing' && message.text === text).length;
}

function inputText(input: ComputerElement): string {
  return rawText(input);
}

function compositorSurfaceOf(candidate: ComputerTargetSummary, selected: ComputerTargetSummary): boolean {
  if (candidate.pid !== selected.pid || normalized(candidate.title) !== normalized(selected.title)) return false;
  const left = Math.max(candidate.bounds.x, selected.bounds.x);
  const top = Math.max(candidate.bounds.y, selected.bounds.y);
  const right = Math.min(candidate.bounds.x + candidate.bounds.width, selected.bounds.x + selected.bounds.width);
  const bottom = Math.min(candidate.bounds.y + candidate.bounds.height, selected.bounds.y + selected.bounds.height);
  return Math.max(0, right - left) * Math.max(0, bottom - top)
    >= candidate.bounds.width * candidate.bounds.height * 0.9;
}

export class QqPersonalMessageComputerAdapter {
  constructor(
    private readonly manager: ComputerManager,
    private readonly dataRoot: string,
  ) {}

  async prepareScope(
    authorization: PersonalMessageAuthorization,
    access: ComputerAccess | undefined,
    apps: readonly string[] | undefined,
    signal?: AbortSignal,
  ) {
    if (authorization.channel !== 'qq'
      || !access || !['background', 'foreground', 'admin'].includes(access)
      || !apps?.includes(QQ_BUNDLE_ID)) return undefined;
    const probe = await this.probe(authorization, signal).catch(() => undefined);
    if (!probe) return undefined;
    return {
      eventId: authorization.eventId,
      channel: authorization.channel,
      accountFingerprint: authorization.accountFingerprint,
      conversationId: authorization.conversationId,
      actorId: authorization.actorId,
      messageMode: authorization.mode,
      approvedText: authorization.approvedText,
      capability: probe.capability,
      getContext: (limit: number, requestSignal?: AbortSignal) =>
        this.getContext(authorization, limit, requestSignal),
      send: (input: { text: string; latestFingerprint: string }, requestSignal?: AbortSignal) =>
        this.send(authorization, input.text, input.latestFingerprint, requestSignal),
    };
  }

  async probe(
    authorization: PersonalMessageAuthorization,
    signal?: AbortSignal,
  ): Promise<QqPersonalMessageProbe> {
    this.assertAuthorization(authorization);
    return this.exclusive(async () => {
      const authority = this.authority('probe');
      try {
        await this.observeBound(authority, authorization, 1, signal);
        return {
          ready: true,
          capability: {
            accountVerified: true,
            inboundCoverage: 'bounded',
            contextRead: 'bounded',
            sendRoute: 'computer',
            deliveryConfirmed: true,
            backgroundSafe: true,
            changesReadState: false,
            stableConversationId: true,
            stableMessageId: true,
            probedAt: new Date().toISOString(),
          },
        };
      } finally {
        await this.manager.endRun(authority.runId).catch(() => undefined);
      }
    }, signal);
  }

  async getContext(
    authorization: PersonalMessageAuthorization,
    limit: number,
    signal?: AbortSignal,
  ): Promise<PersonalMessageContext> {
    this.assertAuthorization(authorization);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('QQ context limit 必须为 1 到 100');
    }
    return this.exclusive(async () => {
      const authority = this.authority('context');
      try {
        const parsed = await this.observeBound(authority, authorization, limit, signal);
        return personalMessageContextSchema.parse({
          channel: 'qq',
          accountFingerprint: authorization.accountFingerprint,
          conversationId: authorization.conversationId,
          coverage: 'bounded',
          observedAt: new Date().toISOString(),
          latestFingerprint: parsed.latestFingerprint,
          messages: parsed.messages,
          // AX only covers the current visible viewport and never proves full history.
          truncated: true,
        });
      } finally {
        await this.manager.endRun(authority.runId).catch(() => undefined);
      }
    }, signal);
  }

  async send(
    authorization: PersonalMessageAuthorization,
    text: string,
    expectedLatestFingerprint: string,
    signal?: AbortSignal,
  ): Promise<PersonalMessageResult> {
    this.assertAuthorization(authorization);
    if (!text.trim() || text.length > MAX_QQ_SEND_CHARS) {
      return this.failed('QQ CUA route only accepts 1 to 500 characters');
    }
    return this.exclusive(async () => {
      const authority = this.authority('send');
      try {
        const before = await this.observeBound(authority, authorization, 100, signal);
        if (before.latestFingerprint !== expectedLatestFingerprint) {
          return this.failed('qq_context_changed：会话在发送前已经变化');
        }
        if (inputText(before.input)) {
          return this.failed('qq_draft_present：QQ 输入框已有草稿，未执行写入');
        }
        const baseline = messageCount(before.messages, text);
        try {
          await this.manager.act(authority, {
            observationId: before.observation.observationId,
            action: {
              type: 'type_text',
              elementIndex: before.input.index,
              text,
              dispatch: 'background',
            },
          }, signal);
        } catch (error) {
          return this.failed(`qq_draft_write_failed：${error instanceof Error ? error.message : String(error)}`);
        }
        let prepared: ParsedQqObservation;
        try {
          prepared = await this.observeBound(authority, authorization, 100, signal);
        } catch (error) {
          return this.failed(`qq_draft_readback_failed：${error instanceof Error ? error.message : String(error)}`);
        }
        if (inputText(prepared.input) !== text) {
          return this.failed('qq_draft_mismatch：写入后草稿与最终文本不一致，未执行发送');
        }
        try {
          await this.manager.act(authority, {
            observationId: prepared.observation.observationId,
            action: { type: 'keypress', keys: ['return'], dispatch: 'background' },
          }, signal);
        } catch (error) {
          return this.uncertain(`qq_send_uncertain：发送按键结果不确定：${error instanceof Error ? error.message : String(error)}`);
        }
        let after: ParsedQqObservation;
        try {
          after = await this.observeBound(authority, authorization, 100, signal);
        } catch (error) {
          return this.uncertain(`qq_post_read_failed：发送后无法回读：${error instanceof Error ? error.message : String(error)}`);
        }
        if (!inputText(after.input) && messageCount(after.messages, text) > baseline) {
          return personalMessageResultSchema.parse({
            status: 'confirmed',
            route: 'computer',
            deliveryConfirmed: true,
            accountVerified: true,
            targetVerified: true,
            evidence: 'same_account_conversation_post_read',
          });
        }
        return this.uncertain('qq_post_read_unconfirmed：发送动作已执行，但新气泡或空输入框未同时确认');
      } finally {
        await this.manager.endRun(authority.runId).catch(() => undefined);
      }
    }, signal);
  }

  private async observeBound(
    authority: ComputerRunAuthority,
    authorization: PersonalMessageAuthorization,
    limit: number,
    signal?: AbortSignal,
  ): Promise<ParsedQqObservation> {
    const targets = (await this.manager.listHostTargets(authority, QQ_BUNDLE_ID, signal))
      .filter((candidate) => candidate.bounds.width >= 600 && candidate.bounds.height >= 450);
    const matches: Array<{ target: ComputerTargetSummary; parsed: ParsedQqObservation }> = [];
    let failure: unknown;
    for (const target of targets) {
      if (target.frontmost !== false) throw new Error('target_in_use：QQ 位于前台或焦点状态未知');
      try {
        const observation = await this.manager.observeHostTarget(authority, target, signal);
        if (observation.frontmost !== false) throw new Error('target_in_use：观察期间 QQ 位于前台或焦点状态未知');
        const input = inputElement(observation.elements);
        assertAccount(observation, input, authorization.accountFingerprint);
        const title = activeConversationTitle(observation, input);
        if (qqVisibleConversationId(title) !== authorization.conversationId) {
          throw new Error('qq_conversation_mismatch：当前 QQ 会话与事件绑定不一致');
        }
        const messages = contextMessages(observation, input, limit);
        matches.push({ target, parsed: { observation, input, messages, latestFingerprint: latestFingerprint(messages) } });
      } catch (error) {
        failure ??= error;
      }
    }
    if (matches.length !== 1) throw matches.length
      ? new Error(`qq_target_ambiguous：匹配到 ${matches.length} 个 QQ 会话窗口`)
      : failure ?? new Error('qq_target_unavailable：没有可验证的 QQ 会话窗口');
    const selected = matches[0]!;
    if (targets.some((target) => target.windowId !== selected.target.windowId
      && !compositorSurfaceOf(target, selected.target))) {
      throw new Error('qq_target_ambiguous：存在独立 QQ 窗口，拒绝猜测目标');
    }
    return selected.parsed;
  }

  private authority(operation: string): ComputerRunAuthority {
    return {
      runId: `personal-qq:${operation}:${randomUUID()}`,
      access: 'background',
      allowedApps: [QQ_BUNDLE_ID],
      supportsImageInput: false,
    };
  }

  private assertAuthorization(authorization: PersonalMessageAuthorization): void {
    if (authorization.channel !== 'qq') throw new Error('QQ Computer Adapter 只接受 qq channel');
    if (!authorization.conversationId.startsWith(QQ_CONVERSATION_PREFIX)
      || authorization.conversationId.length !== QQ_CONVERSATION_PREFIX.length + 64) {
      throw new Error('qq_conversation_invalid：QQ 会话必须使用 stable visible_ax ID');
    }
  }

  private failed(error: string): PersonalMessageResult {
    return personalMessageResultSchema.parse({
      status: 'failed',
      route: 'computer',
      deliveryConfirmed: false,
      accountVerified: true,
      targetVerified: true,
      error: error.slice(0, 2_000),
    });
  }

  private uncertain(error: string): PersonalMessageResult {
    return personalMessageResultSchema.parse({
      status: 'uncertain',
      route: 'computer',
      deliveryConfirmed: false,
      accountVerified: true,
      targetVerified: true,
      error: error.slice(0, 2_000),
    });
  }

  private exclusive<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return withExclusiveFileLock(
      path.join(this.dataRoot, 'personal-qq-operation'),
      operation,
      signal,
    );
  }
}
