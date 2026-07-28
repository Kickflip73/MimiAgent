import { captureSensitiveText } from '../core/data-sanitizer.js';

const DEFAULT_TTL_MS = 15 * 60_000;
const MAX_ACTIVE_INPUTS = 32;
const MAX_SECRETS_PER_INPUT = 8;
const MAX_SECRET_BYTES = 16_384;

export interface EphemeralSecretReference {
  fingerprint: string;
  environmentVariable: string;
}

interface EphemeralSecretRecord {
  expiresAt: number;
  references: EphemeralSecretReference[];
  environment: Record<string, string>;
}

function validReference(value: unknown): value is EphemeralSecretReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.fingerprint === 'string'
    && /^(?:credential|authorization|private-key):sha256:[a-f0-9]{16}$/u.test(candidate.fingerprint)
    && typeof candidate.environmentVariable === 'string'
    && /^MIMI_EPHEMERAL_SECRET_[1-8]$/u.test(candidate.environmentVariable);
}

export function ephemeralSecretReferences(value: unknown): EphemeralSecretReference[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const references = (value as Record<string, unknown>).transientInputRefs;
  if (!Array.isArray(references) || !references.every(validReference)) return [];
  return references.map((reference) => ({ ...reference }));
}

export function ephemeralSecretInstructions(references: readonly EphemeralSecretReference[]): string {
  if (references.length === 0) return '';
  return [
    'owner 在当前命令中提供了临时敏感值。原值不会进入 user input、Session、Event、Task、Trace、Memory 或执行账本；仅在本轮 Shell 子进程环境中可用。',
    `变量映射：${references.map((reference) => (
      `${reference.fingerprint} → ${reference.environmentVariable}`
    )).join('；')}。`,
    '需要调用 CLI、脚本或 HTTP 客户端时直接引用相应环境变量；不要输出、回显、写文件、写配置、写日志或要求 owner 再次粘贴原值。若工具不可用或变量过期，明确说明需要重新提交。',
  ].join('\n');
}

export class EphemeralSecretsExpiredError extends Error {
  constructor() {
    super('当前命令引用的临时敏感值已过期或 Daemon 已重启；为避免保存或重放凭证，请 owner 重新提交该命令');
    this.name = 'EphemeralSecretsExpiredError';
  }
}

export class EphemeralSecretBroker {
  private readonly records = new Map<string, EphemeralSecretRecord>();

  constructor(
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  capture(eventId: string, input: string): {
    sanitized: string;
    references: EphemeralSecretReference[];
  } {
    this.prune();
    const captured = captureSensitiveText(input, { preserveContacts: true });
    if (captured.values.length === 0) return { sanitized: captured.sanitized, references: [] };
    if (captured.values.length > MAX_SECRETS_PER_INPUT) {
      throw new Error(`单次命令最多可包含 ${MAX_SECRETS_PER_INPUT} 个临时敏感值`);
    }
    const totalBytes = captured.values.reduce((sum, item) => sum + Buffer.byteLength(item.value), 0);
    if (totalBytes > MAX_SECRET_BYTES) throw new Error(`单次命令的临时敏感值不能超过 ${MAX_SECRET_BYTES} 字节`);
    if (this.records.size >= MAX_ACTIVE_INPUTS) throw new Error('当前等待执行的临时敏感命令过多，请稍后重试');

    const references = captured.values.map((item, index) => ({
      fingerprint: item.fingerprint,
      environmentVariable: `MIMI_EPHEMERAL_SECRET_${index + 1}`,
    }));
    const environment = Object.fromEntries(references.map((reference, index) => [
      reference.environmentVariable,
      captured.values[index]!.value,
    ]));
    this.records.set(eventId, {
      expiresAt: this.now() + this.ttlMs,
      references,
      environment,
    });
    return { sanitized: captured.sanitized, references: references.map((reference) => ({ ...reference })) };
  }

  take(
    eventId: string,
    expectedReferences: readonly EphemeralSecretReference[],
  ): Record<string, string> | undefined {
    this.prune();
    const record = this.records.get(eventId);
    if (!record) return undefined;
    this.records.delete(eventId);
    if (JSON.stringify(record.references) !== JSON.stringify(expectedReferences)) return undefined;
    return { ...record.environment };
  }

  discard(eventId: string): void {
    this.records.delete(eventId);
  }

  private prune(): void {
    const now = this.now();
    for (const [eventId, record] of this.records) {
      if (record.expiresAt <= now) this.records.delete(eventId);
    }
  }
}
