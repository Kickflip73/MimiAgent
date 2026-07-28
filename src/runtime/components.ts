import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';
import { preferredEnvironmentValue, type AppConfig } from '../config.js';
import { ContextManager } from '../core/context.js';
import { ProjectGuidanceLoader, SoulLoader } from '../core/guidance.js';
import type { MemoryHub } from '../core/memory.js';
import { isMcpConfigurationTrusted, MCPManager } from '../extensions/mcp.js';
import { createRoutedMemoryHub } from '../extensions/memory/hub.js';
import { SkillLoader, type SkillSource } from '../extensions/skills.js';
import { SkillPreferenceStore } from '../extensions/skill-preferences.js';
import { ComputerManager } from '../extensions/computer/manager.js';
import { CuaDriverClient } from '../extensions/computer/cua-driver-client.js';
import { sharedCuaDriverLifecycle } from '../extensions/computer/cua-driver-lifecycle.js';
import { createModel, type ModelRuntime } from './model.js';
import { createFileRuntimeStatePorts, type RuntimeStatePorts } from './state-ports.js';

export interface RuntimeComponents {
  modelRuntime: ModelRuntime;
  context: ContextManager;
  soul: SoulLoader;
  projectGuidance: ProjectGuidanceLoader;
  memory: MemoryHub;
  skills: SkillLoader;
  state: RuntimeStatePorts;
  mcp: MCPManager;
  sessionId: string;
  computer?: ComputerManager;
}

export function resolveUserSoulFile(homeDirectory = os.homedir()): string {
  return path.join(homeDirectory, '.mimi-agent', 'MIMI.md');
}

export function skillSources(config: AppConfig, homeDirectory = os.homedir()): SkillSource[] {
  const projectNative = path.join(config.workspaceRoot, 'skills');
  const configured = config.skillsRootConfigured === true
    || path.resolve(config.skillsRoot) !== path.resolve(projectNative);
  const builtinRoot = path.resolve(fileURLToPath(new URL('../../skills/', import.meta.url)));
  return [
    ...(configured ? [{
      id: 'configured' as const,
      scope: 'configured' as const,
      root: config.skillsRoot,
      precedence: 0,
    }] : []),
    {
      id: 'project-native',
      scope: 'project',
      root: projectNative,
      precedence: 1,
    },
    {
      id: 'project-shared',
      scope: 'project',
      root: path.join(config.workspaceRoot, '.agents', 'skills'),
      precedence: 2,
    },
    {
      id: 'user-native',
      scope: 'user',
      root: path.join(homeDirectory, '.mimi-agent', 'skills'),
      precedence: 3,
    },
    {
      id: 'user-shared',
      scope: 'user',
      root: path.join(homeDirectory, '.agents', 'skills'),
      precedence: 4,
    },
    {
      id: 'builtin',
      scope: 'builtin',
      root: builtinRoot,
      precedence: 5,
      manifest: path.join(builtinRoot, 'manifest.json'),
    },
  ];
}

export async function createRuntimeComponents(
  config: AppConfig,
  requestedSessionId?: string,
  options: {
    mcpEnvironment?: Readonly<Record<string, string>>;
    enableMcp?: boolean;
    releaseMcpEnvironmentAfterConnect?: boolean;
  } = {},
): Promise<RuntimeComponents> {
  const modelRuntime = createModel(config);
  const embeddingClient = process.env.OPENAI_API_KEY
    ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY, fetch: globalThis.fetch })
    : undefined;
  const sessionId = requestedSessionId
    ?? preferredEnvironmentValue('MIMI_SESSION', 'AGENT_SESSION')
    ?? 'default';
  const skills = new SkillLoader(
    skillSources(config),
    new SkillPreferenceStore(
      path.join(config.dataRoot, 'skill-preferences.json'),
      path.join(os.homedir(), '.mimi-agent', 'skill-preferences.json'),
    ),
  );
  const mcpTrusted = await isMcpConfigurationTrusted(
    config.mcpConfig,
    config.workspaceRoot,
    config.trustedWorkspaceMcp,
  );
  const mcpEnabled = options.enableMcp !== false && mcpTrusted;
  const mcpSecrets = Object.values(options.mcpEnvironment ?? {}).filter(Boolean);
  const mcp = new MCPManager(config.mcpConfig, config.workspaceRoot, {
    enabled: mcpEnabled,
    disabledReason: options.enableMcp === false
      ? '当前 Task 不允许 MCP'
      : '项目 MCP 默认不执行；确认仓库可信后把 MIMI_TRUST_WORKSPACE_MCP 设为该工作区绝对路径',
    // Trusting a workspace MCP configuration authorizes its declared transports.
    // Local file/Shell permission modes remain a separate boundary for built-in tools.
    allowStdio: mcpEnabled,
    resolveEnvironment: options.mcpEnvironment
      ? (name) => options.mcpEnvironment?.[name]
      : undefined,
    redactError: mcpSecrets.length > 0
      ? (message) => mcpSecrets.reduce(
          (redacted, secret) => redacted.split(secret).join('[REDACTED]'),
          message,
        )
      : undefined,
  });
  const packagedSoulFile = fileURLToPath(new URL('../../MIMI.md', import.meta.url));
  const soul = new SoulLoader(resolveUserSoulFile(), packagedSoulFile);
  const state = createFileRuntimeStatePorts(config, sessionId);
  // Migrate side-effect state before MCP or any runtime executor can start.
  await state.executionLedger.store.initialize();
  const memory = createRoutedMemoryHub({
    workspaceRoot: config.workspaceRoot,
    dataRoot: config.dataRoot,
    userSoulFile: soul.userFile,
    packagedSoulFile,
    embeddingClient,
    retrievalMode: process.env.MIMI_MEMORY_RETRIEVAL_MODE === 'lexical' ? 'lexical' : 'auto',
  });
  await Promise.all([skills.load(), mcp.connect()]);
  if (options.releaseMcpEnvironmentAfterConnect) mcpSecrets.length = 0;
  return {
    modelRuntime,
    context: new ContextManager(
      config.historyLimit,
      modelRuntime.profile.contextWindow,
      0.55,
      modelRuntime.profile.outputReserve,
    ),
    soul,
    projectGuidance: new ProjectGuidanceLoader(config.workspaceRoot),
    memory,
    skills,
    state,
    mcp,
    sessionId,
    ...(config.computer ? {
      computer: new ComputerManager(
        config.computer,
        new CuaDriverClient(
          config.computer.driverCommand,
          config.computer.actionTimeoutMs,
          sharedCuaDriverLifecycle(
            config.computer.driverCommand,
            config.computer.actionTimeoutMs,
          ),
        ),
        config.dataRoot,
      ),
    } : {}),
  };
}
