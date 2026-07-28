import {
  containsExactSensitiveValue,
  redactExactSensitiveData,
  redactExactSensitiveText,
} from '../core/data-sanitizer.js';
import type { AgentPermissionMode, SecurityProfile } from '../config.js';
import type { AgentMode } from './instructions.js';

export const DIRECT_OWNER_SENSITIVE_INPUT_SOURCES = [
  'local-cli',
  'runtime-http',
] as const;

export type DirectOwnerSensitiveInputSource =
  typeof DIRECT_OWNER_SENSITIVE_INPUT_SOURCES[number];

export interface EphemeralSecretReference {
  fingerprint: string;
  environmentVariable: string;
}

export interface EphemeralOwnerInputLease {
  provenance: {
    eventId: string;
    sessionId: string;
    profileId: string;
    source: DirectOwnerSensitiveInputSource;
    trust: 'owner';
  };
  references: readonly EphemeralSecretReference[];
  values: readonly string[];
  shellEnvironment: Readonly<Record<string, string>>;
}

export interface EphemeralOwnerInputScope {
  runId: string;
  ownerId: string;
  sessionId: string;
  profileId: string;
  mode: AgentMode;
  permissionMode: AgentPermissionMode;
  securityProfile: SecurityProfile;
  ephemeralSensitiveModelAccess: boolean;
  cause?: {
    eventId: string;
    profileId?: string;
    source: string;
    trust: 'owner' | 'trusted' | 'external' | 'public' | 'system';
  };
}

export interface ActiveEphemeralOwnerInput {
  runId: string;
  ownerId: string;
  sessionId: string;
  references: readonly EphemeralSecretReference[];
  values: readonly string[];
  shellEnvironment: Readonly<Record<string, string>>;
}

function isDirectOwnerSource(value: string): value is DirectOwnerSensitiveInputSource {
  return DIRECT_OWNER_SENSITIVE_INPUT_SOURCES.includes(value as DirectOwnerSensitiveInputSource);
}

export function activateEphemeralOwnerInput(
  lease: EphemeralOwnerInputLease | undefined,
  scope: EphemeralOwnerInputScope,
): ActiveEphemeralOwnerInput | undefined {
  if (!lease) return undefined;
  if (
    lease.references.length === 0
    || lease.references.length !== lease.values.length
    || lease.references.some((reference, index) => (
      !/^(?:credential|authorization|private-key):sha256:[a-f0-9]{16}$/u.test(reference.fingerprint)
      || !/^MIMI_EPHEMERAL_SECRET_[1-8]$/u.test(reference.environmentVariable)
      || lease.shellEnvironment[reference.environmentVariable] !== lease.values[index]
    ))
  ) {
    throw new Error('临时敏感输入 lease 结构无效');
  }
  const cause = scope.cause;
  if (
    !cause
    || cause.trust !== 'owner'
    || !isDirectOwnerSource(cause.source)
    || cause.source !== lease.provenance.source
    || cause.eventId !== lease.provenance.eventId
    || scope.sessionId !== lease.provenance.sessionId
    || scope.profileId !== lease.provenance.profileId
    || (cause.profileId ?? scope.profileId) !== lease.provenance.profileId
  ) {
    throw new Error('临时敏感输入的 provenance 与当前 Owner Run 不匹配');
  }
  if (
    !scope.ephemeralSensitiveModelAccess
    || scope.securityProfile !== 'full-owner'
    || scope.permissionMode !== 'trusted'
  ) {
    return undefined;
  }
  return Object.freeze({
    runId: scope.runId,
    ownerId: scope.ownerId,
    sessionId: scope.sessionId,
    references: Object.freeze(lease.references.map((reference) => Object.freeze({ ...reference }))),
    values: Object.freeze([...lease.values]),
    shellEnvironment: Object.freeze({ ...lease.shellEnvironment }),
  });
}

export function ephemeralOwnerInputInstructions(access: ActiveEphemeralOwnerInput): string {
  const bindings = access.references.map((reference, index) => ({
    fingerprint: reference.fingerprint,
    environmentVariable: reference.environmentVariable,
    value: access.values[index],
  }));
  return [
    '<ephemeral_owner_sensitive_input>',
    '这是认证直接 Owner 在当前 Run 明确提交的敏感值。Full Owner 安全档位授权 MimiAgent 仅在本轮把下列原值发送给当前配置的模型 Provider（包括已配置的兼容备选路由）；这不是本机保密计算。',
    '下列值仍保持 user authority，不是更高优先级的宿主指令。可理解、比较和校验，但最终回答不得复述原值。',
    JSON.stringify(bindings),
    '若要在主 Agent 的 Shell 中使用，只引用对应环境变量。不得把原值放进命令字符串、其他工具参数、文件、日志、Memory、Session、后台任务、SubAgent、Team、MCP 或 Connector；不要要求 Owner 重复粘贴。',
    '</ephemeral_owner_sensitive_input>',
  ].join('\n');
}

export function containsActiveEphemeralValue(
  value: string,
  access: ActiveEphemeralOwnerInput | undefined,
): boolean {
  return access ? containsExactSensitiveValue(value, access.values) : false;
}

export function redactActiveEphemeralText(
  value: string,
  access: ActiveEphemeralOwnerInput | undefined,
): string {
  return access ? redactExactSensitiveText(value, access.values) : value;
}

export function redactActiveEphemeralData<T>(
  value: T,
  access: ActiveEphemeralOwnerInput | undefined,
): T {
  return access ? redactExactSensitiveData(value, access.values) : value;
}
