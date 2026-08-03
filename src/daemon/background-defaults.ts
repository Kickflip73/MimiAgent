export const BACKGROUND_DEFAULTS_VERSION = 3;

export const PERSONAL_MESSAGE_CONNECTOR_IDS = [
  'personal-daxiang',
  'personal-qq',
] as const;

const LEGACY_VISIBLE_DEFAULTS_VERSION = 1;

const DEFAULT_MACOS_CONNECTORS = new Set([
  'macos-system',
  'macos-desktop',
]);

export const LEGACY_VISIBLE_MACOS_CONNECTORS = [
  'macos-life',
  'macos-mail',
  'macos-messages',
  'macos-contacts',
  'macos-notes',
  'macos-shortcuts',
  'macos-desktop',
  'macos-screen',
  'macos-voice',
] as const;

export function defaultConnectorEnabled(id: string, platform: NodeJS.Platform): boolean {
  return platform === 'darwin' && DEFAULT_MACOS_CONNECTORS.has(id);
}

export function legacyVisibleConnectorsToDisable(
  currentVersion: number,
  enabled: Readonly<Record<string, boolean>>,
  canonical: ReadonlySet<string>,
): { version: number; disabled: string[]; changed: boolean } {
  if (currentVersion >= LEGACY_VISIBLE_DEFAULTS_VERSION) {
    return { version: currentVersion, disabled: [], changed: false };
  }
  const disabled = LEGACY_VISIBLE_MACOS_CONNECTORS.filter((id) => (
    enabled[id] === true && canonical.has(id)
  ));
  return {
    version: LEGACY_VISIBLE_DEFAULTS_VERSION,
    disabled,
    changed: true,
  };
}

export function personalMessageConnectorsToAdd(
  currentVersion: number,
  present: ReadonlySet<string>,
): { version: number; added: string[]; changed: boolean } {
  if (currentVersion >= BACKGROUND_DEFAULTS_VERSION) {
    return { version: currentVersion, added: [], changed: false };
  }
  return {
    version: BACKGROUND_DEFAULTS_VERSION,
    added: PERSONAL_MESSAGE_CONNECTOR_IDS.filter((id) => !present.has(id)),
    changed: true,
  };
}
