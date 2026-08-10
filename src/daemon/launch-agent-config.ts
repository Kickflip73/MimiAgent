import process from 'node:process';
import {
  preferredEnvironmentValue,
  resolveEnvironmentFile,
  securityProfileSummary,
  type AppConfig,
} from '../config.js';
import { escapeXmlAttribute as xml } from '../core/xml.js';
import { mimiPaths } from './client-runtime.js';

export const MIMI_LAUNCH_AGENT_LABEL = 'com.mimiagent.daemon';

export function daemonLaunchEnvironment(config: AppConfig): Record<string, string> {
  const paths = mimiPaths(config);
  const session = preferredEnvironmentValue('MIMI_SESSION', 'AGENT_SESSION') ?? 'mimi-system';
  const connectorConfigMode = preferredEnvironmentValue('MIMI_CONNECTORS_CONFIG_MODE');
  if (connectorConfigMode !== undefined && connectorConfigMode !== 'exact') {
    throw new Error('MIMI_CONNECTORS_CONFIG_MODE 只接受 exact；省略该变量时使用 managed 模式');
  }
  const environment: Record<string, string> = {
    MIMI_MODEL_PROVIDER: config.provider,
    MIMI_CONFIG_VERSION: '4',
    MIMI_WORKSPACE: config.workspaceRoot,
    AGENT_WORKSPACE: config.workspaceRoot,
    MIMI_DATA_DIR: config.dataRoot,
    MIMI_DAEMON_DATA_DIR: paths.root,
    MIMI_DAEMON_SOCKET: paths.socket,
    MIMI_SKILLS_DIR: config.skillsRoot,
    MIMI_MCP_CONFIG: config.mcpConfig,
    MIMI_HISTORY_LIMIT: String(config.historyLimit),
    MIMI_TEAM_MAX_CONCURRENCY: String(config.teamMaxConcurrency ?? 4),
    MIMI_PERMISSION_MODE: config.permissionMode ?? 'trusted',
    MIMI_SECURITY_PROFILE: securityProfileSummary(config).id,
    MIMI_SESSION: session,
    AGENT_SESSION: session,
    MIMI_CONNECTORS_CONFIG: paths.connectorsConfig,
    MIMI_ASSISTANT_CONFIG: paths.assistantConfig,
  };
  if (connectorConfigMode === 'exact') environment.MIMI_CONNECTORS_CONFIG_MODE = connectorConfigMode;
  if (config.maxTurns !== null) environment.MIMI_MAX_TURNS = String(config.maxTurns);
  if (config.contextWindow !== undefined) environment.MIMI_CONTEXT_WINDOW = String(config.contextWindow);
  if (config.outputReserve !== undefined) environment.MIMI_OUTPUT_TOKEN_RESERVE = String(config.outputReserve);
  if (config.provider === 'openai-compatible') {
    if (config.providerBaseUrl !== undefined) environment.MIMI_PROVIDER_BASE_URL = config.providerBaseUrl;
    if (config.defaultModel !== undefined) environment.MIMI_MODEL = config.defaultModel;
    if (config.availableModels?.length) environment.MIMI_MODELS = config.availableModels.join(',');
  } else if (config.provider === 'deepseek') {
    if (config.providerBaseUrl !== undefined) environment.DEEPSEEK_BASE_URL = config.providerBaseUrl;
    if (config.defaultModel !== undefined) environment.DEEPSEEK_MODEL = config.defaultModel;
    if (config.availableModels?.length) environment.DEEPSEEK_MODELS = config.availableModels.join(',');
  } else {
    if (config.defaultModel !== undefined) environment.OPENAI_MODEL = config.defaultModel;
    if (config.availableModels?.length) environment.OPENAI_MODELS = config.availableModels.join(',');
  }
  if (config.computer) {
    environment.MIMI_COMPUTER_BACKEND = config.computer.backend;
    environment.MIMI_CUA_DRIVER_COMMAND = config.computer.driverCommand;
    environment.MIMI_COMPUTER_ACTION_TIMEOUT_MS = String(config.computer.actionTimeoutMs);
    environment.MIMI_COMPUTER_MAX_ACTIONS_PER_RUN = String(config.computer.maxActionsPerRun);
    environment.MIMI_COMPUTER_MAX_SCREENSHOTS_PER_RUN = String(config.computer.maxScreenshotsPerRun);
    environment.MIMI_COMPUTER_PAUSE_WHEN_TARGET_FRONTMOST = String(config.computer.pauseWhenTargetFrontmost);
    environment.MIMI_COMPUTER_DEFAULT_ACCESS = config.computer.defaultAccess;
    environment.MIMI_COMPUTER_FOREGROUND_LEASE_SECONDS = String(config.computer.foregroundLeaseSeconds);
    environment.MIMI_COMPUTER_ARTIFACT_MAX_MIB = String(
      Math.floor(config.computer.artifactMaxBytes / 1024 / 1024),
    );
  }
  if (config.trustedWorkspaceMcp !== undefined) {
    environment.MIMI_TRUST_WORKSPACE_MCP = config.trustedWorkspaceMcp;
  }
  const environmentFile = resolveEnvironmentFile();
  environment.MIMI_ENV_FILE = environmentFile;
  environment.DOTENV_CONFIG_PATH = environmentFile;
  return environment;
}

export function launchAgentPlist(
  config: AppConfig,
  entry = process.argv[1],
  execArgs = process.execArgv,
): string {
  if (!entry) throw new Error('无法确定 MimiAgent 启动入口');
  const paths = mimiPaths(config);
  const argumentsXml = [process.execPath, ...execArgs, entry, 'daemon', 'run']
    .map((value) => `    <string>${xml(value)}</string>`).join('\n');
  const environment = { ...daemonLaunchEnvironment(config), MIMI_DAEMON_SUPERVISOR: 'launchd' };
  const environmentXml = Object.entries(environment)
    .map(([key, value]) => `      <key>${xml(key)}</key>\n      <string>${xml(value)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${MIMI_LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argumentsXml}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(config.workspaceRoot)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${environmentXml}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(paths.stdoutLog)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(paths.stderrLog)}</string>
</dict>
</plist>
`;
}
