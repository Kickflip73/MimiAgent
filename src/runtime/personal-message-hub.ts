import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { tool, type Tool } from '@openai/agents';
import { z } from 'zod';
import {
  personalMessageContextSchema,
  personalMessageResultSchema,
  type PersonalMessageChannel,
  type PersonalMessageContext,
  type PersonalMessageMode,
  type PersonalMessageResult,
} from '../core/personal-message.js';
import { TOOL_ACTION_INTENT } from '../core/tool-metadata.js';

const TOKEN_TTL_MS = 5 * 60_000;
const sendInputSchema = z.object({
  contextToken: z.string().min(1).max(4_000),
  text: z.string().trim().min(1).max(4_000),
}).strict();

export interface PersonalMessageCapabilitySnapshot {
  accountVerified: boolean;
  inboundCoverage: 'complete' | 'bounded' | 'notification_only' | 'metadata_only' | 'unavailable';
  contextRead: 'stable' | 'bounded' | 'unavailable';
  sendRoute: 'connector' | 'computer' | 'none';
  deliveryConfirmed: boolean;
  backgroundSafe: boolean;
  changesReadState: boolean | 'unknown';
  stableConversationId: boolean;
  stableMessageId: boolean;
  probedAt: string;
}

export interface PersonalMessageScope {
  eventId: string;
  channel: PersonalMessageChannel;
  accountFingerprint: string;
  conversationId: string;
  actorId?: string;
  messageMode: PersonalMessageMode;
  approvedText?: string;
  capability: PersonalMessageCapabilitySnapshot;
  getContext(limit: number, signal?: AbortSignal): Promise<PersonalMessageContext>;
  send(
    input: { text: string; latestFingerprint: string },
    signal?: AbortSignal,
  ): Promise<PersonalMessageResult>;
}

interface TokenPayload {
  version: 1;
  runId: string;
  eventId: string;
  channel: PersonalMessageChannel;
  accountFingerprint: string;
  conversationId: string;
  latestFingerprint: string;
  expiresAt: number;
  nonce: string;
}

function encoded(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

function decoded(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

function highRiskText(text: string): boolean {
  return /(?:转账|付款|收款|金额|合同|报价|承诺|排期|上线|发布|生产|权限|授权|密码|令牌|token|删除|人事|薪资|隐私)/iu.test(text);
}

export class PersonalMessageHub {
  private readonly key = randomBytes(32);
  private readonly consumed = new Map<string, number>();

  createTools(scope: PersonalMessageScope, runId: string): Tool[] {
    this.pruneConsumed();
    const tools: Tool[] = [];
    if (['draft', 'confirm', 'auto'].includes(scope.messageMode)
      && scope.capability.accountVerified
      && scope.capability.stableConversationId
      && scope.capability.contextRead !== 'unavailable') {
      tools.push(this.contextTool(scope, runId));
    }
    const sendAuthorized = scope.messageMode === 'auto'
      || (scope.messageMode === 'confirm' && scope.approvedText !== undefined);
    if (sendAuthorized
      && scope.capability.accountVerified
      && scope.capability.backgroundSafe
      && scope.capability.stableConversationId
      && scope.capability.stableMessageId
      && scope.capability.sendRoute !== 'none'
      && ['complete', 'bounded'].includes(scope.capability.inboundCoverage)) {
      tools.push(this.sendTool(scope, runId));
    }
    return tools;
  }

  private contextTool(scope: PersonalMessageScope, runId: string): Tool {
    return tool({
      name: 'get_personal_message_context',
      description: '读取当前事件已经绑定的个人消息会话的有界上下文，并返回仅在本次 Run 有效的一次性 contextToken。不能通过参数切换渠道、账号、联系人或会话。',
      parameters: z.object({
        limit: z.number().int().min(1).max(100).default(30),
      }).strict(),
      execute: async ({ limit }, _context, details) => {
        const context = personalMessageContextSchema.parse(await scope.getContext(limit, details?.signal));
        this.assertBoundContext(scope, context);
        const token = this.sign({
          version: 1,
          runId,
          eventId: scope.eventId,
          channel: scope.channel,
          accountFingerprint: scope.accountFingerprint,
          conversationId: scope.conversationId,
          latestFingerprint: context.latestFingerprint,
          expiresAt: Date.now() + TOKEN_TTL_MS,
          nonce: encoded(randomBytes(18)),
        });
        return { ...context, contextToken: token };
      },
    });
  }

  private sendTool(scope: PersonalMessageScope, runId: string): Tool {
    const send = tool({
      name: 'send_personal_message',
      description: '向 contextToken 已锁定的个人消息会话发送一次低风险文本。工具不接受渠道、账号、联系人或会话参数；结果 uncertain 时禁止重试或切换路线。',
      parameters: sendInputSchema,
      execute: async ({ contextToken, text }, _context, details) => {
        if (scope.approvedText !== undefined && text !== scope.approvedText) {
          throw new Error('发送正文与 owner 明确确认的最终文本不一致');
        }
        if (scope.messageMode === 'auto' && highRiskText(text)) {
          return personalMessageResultSchema.parse({
            status: 'not_executed',
            route: 'none',
            deliveryConfirmed: false,
            accountVerified: true,
            targetVerified: true,
            error: '消息涉及承诺、资金、生产、权限、隐私或不可逆动作，不能自动发送',
          });
        }
        const digest = this.tokenDigest(contextToken);
        if (this.consumed.has(digest)) throw new Error('contextToken 已消费或已进入不确定状态');
        const token = this.verify(contextToken);
        this.assertBoundToken(scope, runId, token);
        const latest = personalMessageContextSchema.parse(await scope.getContext(1, details?.signal));
        this.assertBoundContext(scope, latest);
        if (latest.latestFingerprint !== token.latestFingerprint) {
          throw new Error('会话最新消息已经变化，草稿必须重新生成');
        }
        // Fence before the external write. Any thrown error after this point is
        // intentionally not replayable with the same token.
        this.consumed.set(digest, token.expiresAt);
        return personalMessageResultSchema.parse(await scope.send({
          text,
          latestFingerprint: token.latestFingerprint,
        }, details?.signal));
      },
    }) as Tool & {
      [TOOL_ACTION_INTENT]?: (rawInput: string) => {
        actionFamily: string;
        targetRef: string;
        payload: unknown;
        selectedRoute: string;
        authorizationId: string;
        authorizationExpiresAt: string;
        outcome: (result: unknown) => 'confirmed' | 'failed_safe' | 'uncertain';
      };
    };
    send[TOOL_ACTION_INTENT] = (rawInput) => {
      const input = sendInputSchema.parse(JSON.parse(rawInput) as unknown);
      const token = this.verify(input.contextToken);
      this.assertBoundToken(scope, runId, token);
      return {
        actionFamily: 'personal-message.send',
        targetRef: `${scope.channel}:${scope.accountFingerprint}:${scope.conversationId}`,
        payload: { text: input.text },
        selectedRoute: scope.capability.sendRoute,
        authorizationId: this.tokenDigest(input.contextToken),
        authorizationExpiresAt: new Date(token.expiresAt).toISOString(),
        outcome: (result) => {
          const status = personalMessageResultSchema.parse(result).status;
          if (status === 'uncertain' || status === 'accepted' || status === 'observed') return 'uncertain';
          if (status === 'not_executed' || status === 'failed') return 'failed_safe';
          return 'confirmed';
        },
      };
    };
    return send;
  }

  private sign(payload: TokenPayload): string {
    const body = encoded(JSON.stringify(payload));
    const signature = createHmac('sha256', this.key).update(body).digest('base64url');
    return `${body}.${signature}`;
  }

  private verify(token: string): TokenPayload {
    const [body, signature, extra] = token.split('.');
    if (!body || !signature || extra !== undefined) throw new Error('contextToken 格式无效');
    const expected = createHmac('sha256', this.key).update(body).digest();
    const actual = decoded(signature);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new Error('contextToken 签名无效');
    }
    let value: unknown;
    try {
      value = JSON.parse(decoded(body).toString('utf8')) as unknown;
    } catch {
      throw new Error('contextToken 载荷无效');
    }
    const parsed = z.object({
      version: z.literal(1),
      runId: z.string().min(1),
      eventId: z.string().min(1),
      channel: z.enum(['daxiang', 'qq', 'wechat']),
      accountFingerprint: z.string(),
      conversationId: z.string(),
      latestFingerprint: z.string(),
      expiresAt: z.number().int(),
      nonce: z.string().min(1),
    }).strict().parse(value);
    if (parsed.expiresAt < Date.now()) throw new Error('contextToken 已过期');
    return parsed;
  }

  private assertBoundContext(scope: PersonalMessageScope, context: PersonalMessageContext): void {
    if (
      context.channel !== scope.channel
      || context.accountFingerprint !== scope.accountFingerprint
      || context.conversationId !== scope.conversationId
    ) throw new Error('Connector 返回了超出当前个人消息 scope 的上下文');
  }

  private assertBoundToken(scope: PersonalMessageScope, runId: string, token: TokenPayload): void {
    if (
      token.runId !== runId
      || token.eventId !== scope.eventId
      || token.channel !== scope.channel
      || token.accountFingerprint !== scope.accountFingerprint
      || token.conversationId !== scope.conversationId
    ) throw new Error('contextToken 不属于当前 Run 或当前个人消息目标');
  }

  private tokenDigest(token: string): string {
    return createHmac('sha256', this.key).update(`consume:${token}`).digest('hex');
  }

  private pruneConsumed(now = Date.now()): void {
    for (const [digest, expiresAt] of this.consumed) {
      if (expiresAt < now) this.consumed.delete(digest);
    }
  }
}
