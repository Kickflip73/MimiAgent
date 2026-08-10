import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from '../config.js';
import { AttentionEngine } from './attention.js';
import {
  BACKGROUND_DEFAULTS_VERSION,
  defaultConnectorEnabled,
  LEGACY_VISIBLE_MACOS_CONNECTORS,
  legacyVisibleConnectorsToDisable,
  personalMessageConnectorsToAdd,
} from './background-defaults.js';
import { mimiPaths } from './client-runtime.js';
import {
  parseConnectorConfig,
  type ConnectorFileConfig,
} from './connectors.js';
import { ensureControlToken } from './ipc.js';
import { pathExists, writeAtomicJson, writeExclusiveJson } from './json-file.js';
import { MimiStore } from './store.js';

const CONNECTOR_TEMPLATE_ROOT = '/absolute/path/to/MimiAgent';
const RETIRED_CONNECTORS = new Set([
  'daxiang',
  'daxiang-applescript',
  'http-action',
  'macos-browser',
  'openclaw-weixin',
  'personal-wechat',
  'qq',
  'qq-applescript',
  'wechat-applescript',
  'daxiang-applescript-connector.mjs',
  'daxiang-connector.mjs',
  'http-action-connector.mjs',
  'macos-browser-connector.mjs',
  'qq-applescript-connector.mjs',
  'qq-napcat-connector.mjs',
  'wechat-applescript-connector.mjs',
]);
const REQUIRED_CONNECTOR_ENV: Readonly<Record<string, readonly string[]>> = {};

interface InitializeOptions {
  platform?: NodeJS.Platform;
  runtimeRoot?: string;
}

type ConnectorConfigMode = 'managed' | 'exact';

interface ConnectorScriptIdentity {
  canonicalPath: string;
  device?: bigint;
  inode?: bigint;
  sha256?: string;
}

export function runtimeRoot(): string {
  return path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
}

function connectorConfigMode(): ConnectorConfigMode {
  const value = process.env.MIMI_CONNECTORS_CONFIG_MODE;
  if (value === undefined) return 'managed';
  if (value === 'exact') return value;
  throw new Error('MIMI_CONNECTORS_CONFIG_MODE 只接受 exact；省略该变量时使用 managed 模式');
}

function localConnectorConfig(
  template: ConnectorFileConfig,
  root: string,
  platform: NodeJS.Platform,
) {
  return {
    backgroundDefaultsVersion: BACKGROUND_DEFAULTS_VERSION,
    connectors: Object.fromEntries(Object.entries(template.connectors).map(([id, connector]) => [id, {
      ...connector,
      enabled: defaultConnectorEnabled(id, platform),
      command: connector.command === 'node' ? process.execPath : connector.command,
      args: connector.args.map((argument) => argument.replaceAll(CONNECTOR_TEMPLATE_ROOT, root)),
    }])),
  };
}

export function connectorScriptPath(
  connector: ConnectorFileConfig['connectors'][string],
): string | undefined {
  for (let index = connector.args.length - 1; index >= 0; index -= 1) {
    const argument = connector.args[index];
    if (argument && path.isAbsolute(argument) && /\.(?:mjs|cjs|js)$/.test(argument)) return argument;
  }
  return undefined;
}

async function connectorScriptIdentity(
  connector: ConnectorFileConfig['connectors'][string],
): Promise<ConnectorScriptIdentity | undefined> {
  const script = connectorScriptPath(connector);
  if (!script) return undefined;
  try {
    const canonicalPath = await realpath(script);
    const metadata = await stat(canonicalPath, { bigint: true });
    const sha256 = metadata.isFile() && metadata.size <= 2_000_000n
      ? createHash('sha256').update(await readFile(canonicalPath)).digest('hex')
      : undefined;
    return { canonicalPath, device: metadata.dev, inode: metadata.ino, sha256 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { canonicalPath: path.resolve(script) };
  }
}

async function sameConnectorScript(
  current: ConnectorFileConfig['connectors'][string],
  packaged: ConnectorFileConfig['connectors'][string],
): Promise<boolean> {
  const [currentIdentity, packagedIdentity] = await Promise.all([
    connectorScriptIdentity(current),
    connectorScriptIdentity(packaged),
  ]);
  if (!currentIdentity || !packagedIdentity) return false;
  if (currentIdentity.canonicalPath === packagedIdentity.canonicalPath) return true;
  if (currentIdentity.device !== undefined
    && packagedIdentity.device !== undefined
    && currentIdentity.device === packagedIdentity.device
    && currentIdentity.inode === packagedIdentity.inode) return true;
  return path.basename(currentIdentity.canonicalPath) === path.basename(packagedIdentity.canonicalPath)
    && currentIdentity.sha256 !== undefined
    && currentIdentity.sha256 === packagedIdentity.sha256;
}

function retiredConnector(
  id: string,
  connector: ConnectorFileConfig['connectors'][string],
): boolean {
  const script = connectorScriptPath(connector);
  return RETIRED_CONNECTORS.has(id)
    || Boolean(script && RETIRED_CONNECTORS.has(path.basename(script)));
}

function synchronizedAction(
  current: ConnectorFileConfig['connectors'][string]['actions'][string],
  packaged: ConnectorFileConfig['connectors'][string]['actions'][string],
) {
  return {
    ...current,
    description: packaged.description,
    ...(current.capability === undefined && packaged.capability !== undefined
      ? { capability: packaged.capability }
      : {}),
    ...(current.effect === 'unknown' && packaged.effect !== 'unknown'
      ? { effect: packaged.effect }
      : {}),
    modelVisible: packaged.modelVisible,
    targetExample: packaged.targetExample,
    payloadExampleJson: packaged.payloadExampleJson,
  };
}

async function mergeTemplateActions(
  current: ConnectorFileConfig,
  template: ConnectorFileConfig,
) {
  let updatedActions = 0;
  let removedRetired = 0;
  let changed = false;
  const connectors = { ...current.connectors };
  const legacyBrowser = connectors['macos-browser'];
  const browserTemplate = template.connectors.browser;
  if (legacyBrowser && browserTemplate && !connectors.browser) {
    connectors.browser = { ...browserTemplate, enabled: legacyBrowser.enabled };
    changed = true;
  }
  let backgroundDefaultsVersion = current.backgroundDefaultsVersion;
  if (backgroundDefaultsVersion < BACKGROUND_DEFAULTS_VERSION) {
    const canonical = new Set<string>();
    for (const id of LEGACY_VISIBLE_MACOS_CONNECTORS) {
      const connector = connectors[id];
      const packaged = template.connectors[id];
      if (connector?.enabled && packaged && await sameConnectorScript(connector, packaged)) canonical.add(id);
    }
    const defaults = legacyVisibleConnectorsToDisable(
      backgroundDefaultsVersion,
      Object.fromEntries(Object.entries(connectors).map(([id, connector]) => [id, connector.enabled])),
      canonical,
    );
    for (const id of defaults.disabled) connectors[id] = { ...connectors[id]!, enabled: false };
    backgroundDefaultsVersion = defaults.version;
    changed ||= defaults.changed;
  }
  if (backgroundDefaultsVersion < BACKGROUND_DEFAULTS_VERSION) {
    const personal = personalMessageConnectorsToAdd(
      backgroundDefaultsVersion,
      new Set(Object.keys(connectors)),
    );
    for (const id of personal.added) {
      const packaged = template.connectors[id];
      if (packaged) connectors[id] = { ...packaged, enabled: false };
    }
    backgroundDefaultsVersion = personal.version;
    changed ||= personal.changed;
  }
  for (const [id, connector] of Object.entries(connectors)) {
    if (!retiredConnector(id, connector)) continue;
    delete connectors[id];
    removedRetired += 1;
    changed = true;
  }
  for (const [id, connector] of Object.entries(template.connectors)) {
    if (!connectors[id] && connector.enabled) {
      connectors[id] = connector;
      changed = true;
    }
  }
  for (const [id, connector] of Object.entries(current.connectors)) {
    const packaged = template.connectors[id];
    if (!packaged || !await sameConnectorScript(connector, packaged)) continue;
    const migrateSystemProvenance = id === 'macos-system'
      && connector.source === 'system'
      && connector.trust === 'trusted'
      && packaged.source === 'macos-system'
      && packaged.trust === 'system';
    const migrateNodeCommand = connector.command === 'node' && path.isAbsolute(packaged.command);
    const missing = connector.syncTemplateActions
      ? Object.entries(packaged.actions).filter(([name]) => !Object.hasOwn(connector.actions, name))
      : [];
    const metadataUpdates = connector.syncTemplateActions
      ? Object.entries(packaged.actions).filter(([name, packagedAction]) => {
        const currentAction = connector.actions[name];
        return currentAction !== undefined
          && JSON.stringify(currentAction) !== JSON.stringify(
            synchronizedAction(currentAction, packagedAction),
          );
      })
      : [];
    const missingEnv = (REQUIRED_CONNECTOR_ENV[id] ?? []).filter((name) => (
      packaged.envAllowlist.includes(name) && !connector.envAllowlist.includes(name)
    ));
    const missingClaimedComputerApps = packaged.claimedComputerApps.filter(
      (bundleId) => !connector.claimedComputerApps.includes(bundleId),
    );
    if (!migrateSystemProvenance && !migrateNodeCommand && !missing.length
      && !metadataUpdates.length && !missingEnv.length && !missingClaimedComputerApps.length) continue;
    updatedActions += missing.length + metadataUpdates.length;
    changed = true;
    const updatedMetadata = Object.fromEntries(metadataUpdates.map(([name, packagedAction]) => [
      name,
      synchronizedAction(connector.actions[name]!, packagedAction),
    ]));
    connectors[id] = {
      ...connector,
      ...(migrateNodeCommand ? { command: packaged.command } : {}),
      ...(migrateSystemProvenance ? { source: packaged.source, trust: packaged.trust } : {}),
      envAllowlist: [...connector.envAllowlist, ...missingEnv],
      claimedComputerApps: [...connector.claimedComputerApps, ...missingClaimedComputerApps],
      actions: { ...Object.fromEntries(missing), ...connector.actions, ...updatedMetadata },
    };
  }
  return {
    config: { backgroundDefaultsVersion, connectors },
    updatedActions,
    removedRetired,
    changed,
  };
}

export async function initializeMimi(
  config: AppConfig,
  options: InitializeOptions = {},
) {
  const configMode = connectorConfigMode();
  const paths = mimiPaths(config);
  const root = path.resolve(options.runtimeRoot ?? runtimeRoot());
  const platform = options.platform ?? process.platform;
  if (configMode === 'exact' && !await pathExists(paths.connectorsConfig)) {
    throw new Error(`MIMI_CONNECTORS_CONFIG exact 配置不存在：${paths.connectorsConfig}`);
  }
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  await chmod(paths.root, 0o700);
  await ensureControlToken(paths.socket);

  let connectorCreated = false;
  let updatedActions = 0;
  let removedRetired = 0;
  let connectorConfig: ConnectorFileConfig;
  if (configMode === 'exact') {
    connectorConfig = parseConnectorConfig(
      JSON.parse(await readFile(paths.connectorsConfig, 'utf8')) as unknown,
    );
  } else {
    const templateFile = path.join(root, 'mimi.connectors.example.json');
    const template = parseConnectorConfig(JSON.parse(await readFile(templateFile, 'utf8')) as unknown);
    const localTemplate = localConnectorConfig(template, root, platform);
    connectorCreated = !await pathExists(paths.connectorsConfig)
      && await writeExclusiveJson(paths.connectorsConfig, localTemplate);
    connectorConfig = parseConnectorConfig(
      JSON.parse(await readFile(paths.connectorsConfig, 'utf8')) as unknown,
    );
    if (!connectorCreated) {
      const merged = await mergeTemplateActions(connectorConfig, localTemplate);
      connectorConfig = merged.config;
      ({ updatedActions, removedRetired } = merged);
      if (merged.changed) await writeAtomicJson(paths.connectorsConfig, connectorConfig);
    }
  }
  await chmod(paths.connectorsConfig, 0o600);

  const assistantExisted = await pathExists(paths.assistantConfig);
  const store = new MimiStore(paths.database);
  try {
    await AttentionEngine.load(paths.assistantConfig, store);
  } finally {
    store.close();
  }
  return {
    root: paths.root,
    connectors: {
      file: paths.connectorsConfig,
      created: connectorCreated,
      updatedActions,
      removedRetired,
      total: Object.keys(connectorConfig.connectors).length,
      enabled: Object.entries(connectorConfig.connectors)
        .filter(([, connector]) => connector.enabled)
        .map(([id]) => id),
    },
    assistant: { file: paths.assistantConfig, created: !assistantExisted },
  };
}

export type MimiInitialization = Awaited<ReturnType<typeof initializeMimi>>;
