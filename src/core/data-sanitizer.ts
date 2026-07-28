import { createHash } from 'node:crypto';

export const DATA_SANITIZATION_VERSION = 1;
export const REDACTED_VALUE = '[REDACTED]';

export type SensitiveDataCategory =
  | 'credential'
  | 'authorization'
  | 'private-key'
  | 'contact';

export interface SensitiveDataFinding {
  category: SensitiveDataCategory;
  fingerprint: string;
  path: string;
  disposition: 'detected' | 'sanitized';
}

export interface SensitiveDataSanitizationOptions {
  preserveContacts?: boolean;
}

export interface CapturedSensitiveValue {
  category: Exclude<SensitiveDataCategory, 'contact'>;
  fingerprint: string;
  value: string;
}

export interface DataLifecyclePolicy {
  surface: 'task' | 'work-unit' | 'trace' | 'memory' | 'management';
  retentionDays: number;
  export: 'redacted-only';
  delete: 'owner-explicit';
  recovery: 'verified-backup';
}

export const DATA_LIFECYCLE_POLICIES: readonly DataLifecyclePolicy[] = Object.freeze([
  { surface: 'task', retentionDays: 90, export: 'redacted-only', delete: 'owner-explicit', recovery: 'verified-backup' },
  { surface: 'work-unit', retentionDays: 90, export: 'redacted-only', delete: 'owner-explicit', recovery: 'verified-backup' },
  { surface: 'trace', retentionDays: 30, export: 'redacted-only', delete: 'owner-explicit', recovery: 'verified-backup' },
  { surface: 'memory', retentionDays: 365, export: 'redacted-only', delete: 'owner-explicit', recovery: 'verified-backup' },
  { surface: 'management', retentionDays: 30, export: 'redacted-only', delete: 'owner-explicit', recovery: 'verified-backup' },
]);

const SENSITIVE_KEY = /(?:api[-_]?key|access[-_]?token|refresh[-_]?token|password|passwd|secret|credential|authorization|cookie|session[-_]?token|private[-_]?key)/iu;

const VALUE_PATTERNS: readonly {
  category: SensitiveDataCategory;
  expression: RegExp;
  capturedValue?: (match: string) => string;
}[] = [
  {
    category: 'private-key',
    expression: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
  },
  {
    category: 'authorization',
    expression: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/giu,
    capturedValue: (match) => match.replace(/^Bearer\s+/iu, ''),
  },
  {
    category: 'credential',
    expression: /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|mul_[A-Fa-f0-9]{32,}|AKIA[A-Z0-9]{16})\b/gu,
  },
  {
    category: 'credential',
    expression: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
  },
  {
    category: 'credential',
    expression: /\b(?:api[-_]?key|access[-_]?token|refresh[-_]?token|password|passwd|secret|cookie)\s*[:=]\s*["']?[^"'\s,;]{8,}["']?/giu,
    capturedValue: (match) => match.replace(
      /^[^:=]+[:=]\s*["']?/u,
      '',
    ).replace(/["']$/u, ''),
  },
  {
    category: 'contact',
    expression: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
  },
  {
    category: 'contact',
    expression: /(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/gu,
  },
];

function fingerprint(category: SensitiveDataCategory, value: string): string {
  return `${category}:sha256:${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}

function placeholder(category: SensitiveDataCategory, value: string): string {
  return `[REDACTED:${fingerprint(category, value)}]`;
}

function sanitizeString(
  value: string,
  path: string,
  findings?: SensitiveDataFinding[],
  options: SensitiveDataSanitizationOptions = {},
  capturedValues?: CapturedSensitiveValue[],
): string {
  let sanitized = value;
  for (const pattern of VALUE_PATTERNS) {
    if (pattern.category === 'contact' && options.preserveContacts) continue;
    sanitized = sanitized.replace(pattern.expression, (match) => {
      if (match.includes('[REDACTED:')) return match;
      if (capturedValues && pattern.category !== 'contact') {
        capturedValues.push({
          category: pattern.category,
          fingerprint: fingerprint(pattern.category, match),
          value: pattern.capturedValue?.(match) ?? match,
        });
      }
      findings?.push({
        category: pattern.category,
        fingerprint: fingerprint(pattern.category, match),
        path,
        disposition: 'sanitized',
      });
      return placeholder(pattern.category, match);
    });
  }
  return sanitized;
}

function sanitizeValue(
  value: unknown,
  path: string,
  findings?: SensitiveDataFinding[],
  seen = new WeakSet<object>(),
  options: SensitiveDataSanitizationOptions = {},
): unknown {
  if (typeof value === 'string') return sanitizeString(value, path, findings, options);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[REDACTED:circular]';
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item, index) => sanitizeValue(item, `${path}[${index}]`, findings, seen, options));
  }
  const sanitized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const itemPath = path ? `${path}.${key}` : key;
    if (SENSITIVE_KEY.test(key) && item !== undefined && item !== null && item !== '') {
      if (typeof item === 'string' && item.startsWith('[REDACTED:')) {
        sanitized[key] = item;
        continue;
      }
      const raw = typeof item === 'string' ? item : JSON.stringify(item);
      findings?.push({
        category: 'credential',
        fingerprint: fingerprint('credential', raw),
        path: itemPath,
        disposition: 'sanitized',
      });
      sanitized[key] = placeholder('credential', raw);
      continue;
    }
    sanitized[key] = sanitizeValue(item, itemPath, findings, seen, options);
  }
  return sanitized;
}

export function sanitizeSensitiveData<T>(
  value: T,
  options: SensitiveDataSanitizationOptions = {},
): T {
  return sanitizeValue(value, '$', undefined, new WeakSet<object>(), options) as T;
}

export function sanitizeSensitiveText(
  value: string | undefined,
  options: SensitiveDataSanitizationOptions = {},
): string | undefined {
  return value === undefined ? undefined : sanitizeString(value, '$', undefined, options);
}

export function captureSensitiveText(
  value: string,
  options: SensitiveDataSanitizationOptions = {},
): { sanitized: string; values: CapturedSensitiveValue[] } {
  const captured: CapturedSensitiveValue[] = [];
  const sanitized = sanitizeString(value, '$', undefined, options, captured);
  const unique = new Map<string, CapturedSensitiveValue>();
  for (const item of captured) unique.set(item.fingerprint, item);
  return { sanitized, values: [...unique.values()] };
}

export function scanSensitiveData(
  value: unknown,
  options: SensitiveDataSanitizationOptions = {},
): SensitiveDataFinding[] {
  const findings: SensitiveDataFinding[] = [];
  sanitizeValue(value, '$', findings, new WeakSet<object>(), options);
  const unique = new Map<string, SensitiveDataFinding>();
  for (const finding of findings) {
    unique.set(`${finding.category}\0${finding.fingerprint}\0${finding.path}`, {
      ...finding,
      disposition: 'detected',
    });
  }
  return [...unique.values()].sort((left, right) =>
    left.path.localeCompare(right.path) || left.fingerprint.localeCompare(right.fingerprint));
}
