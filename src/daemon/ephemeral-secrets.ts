import {
  captureSensitiveText,
  redactExactSensitiveText,
} from '../core/data-sanitizer.js';
import {
  DIRECT_OWNER_SENSITIVE_INPUT_SOURCES,
  type DirectOwnerSensitiveInputSource,
  type EphemeralOwnerInputLease,
  type EphemeralSecretReference,
} from '../runtime/ephemeral-owner-input.js';

export type { EphemeralSecretReference } from '../runtime/ephemeral-owner-input.js';

const DEFAULT_TTL_MS = 15 * 60_000;
const MAX_ACTIVE_INPUTS = 32;
const MAX_SECRETS_PER_INPUT = 8;
const MAX_SECRET_BYTES = 16_384;

interface EphemeralSecretRecord {
  expiresAt: number;
  provenance: EphemeralOwnerInputLease['provenance'];
  references: EphemeralSecretReference[];
  values: string[];
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

export class EphemeralSecretsExpiredError extends Error {
  constructor() {
    super('当前命令引用的临时敏感值已过期或 Daemon 已重启；为避免保存或重放凭证，请 owner 重新提交该命令');
    this.name = 'EphemeralSecretsExpiredError';
  }
}

export class EphemeralSensitiveRunFailedError extends Error {
  constructor(error: unknown, sensitiveValues: readonly string[] = []) {
    const reason = error instanceof Error ? error.message : String(error);
    super(`${redactExactSensitiveText(reason, sensitiveValues)}；本轮临时敏感值已销毁，任务不会自动重放，请由认证 Owner 重新提交`);
    this.name = 'EphemeralSensitiveRunFailedError';
  }
}

export class EphemeralSecretBroker {
  private readonly records = new Map<string, EphemeralSecretRecord>();

  constructor(
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  capture(
    provenance: {
      eventId: string;
      sessionId: string;
      profileId: string;
      source: string;
      trust: string;
    },
    input: string,
  ): {
    sanitized: string;
    references: EphemeralSecretReference[];
  } {
    this.prune();
    if (
      provenance.trust !== 'owner'
      || !DIRECT_OWNER_SENSITIVE_INPUT_SOURCES.includes(
        provenance.source as DirectOwnerSensitiveInputSource,
      )
    ) {
      throw new Error('只有认证直接 Owner 输入可以创建临时敏感值租约');
    }
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
    const leaseProvenance: EphemeralOwnerInputLease['provenance'] = {
      eventId: provenance.eventId,
      sessionId: provenance.sessionId,
      profileId: provenance.profileId,
      source: provenance.source as DirectOwnerSensitiveInputSource,
      trust: 'owner',
    };
    this.records.set(provenance.eventId, {
      expiresAt: this.now() + this.ttlMs,
      provenance: leaseProvenance,
      references,
      values: captured.values.map((item) => item.value),
      environment,
    });
    return { sanitized: captured.sanitized, references: references.map((reference) => ({ ...reference })) };
  }

  take(
    eventId: string,
    sessionId: string,
    expectedReferences: readonly EphemeralSecretReference[],
  ): EphemeralOwnerInputLease | undefined {
    this.prune();
    const record = this.records.get(eventId);
    if (!record) return undefined;
    this.records.delete(eventId);
    if (
      record.provenance.sessionId !== sessionId
      || JSON.stringify(record.references) !== JSON.stringify(expectedReferences)
    ) return undefined;
    return {
      provenance: { ...record.provenance },
      references: record.references.map((reference) => ({ ...reference })),
      values: [...record.values],
      shellEnvironment: { ...record.environment },
    };
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
