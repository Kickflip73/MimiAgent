export interface DaxiangConversationConfig {
  sid: string;
  type: 'chat' | 'groupchat';
  label?: string;
  binding?: {
    selectedBy: 'owner';
    accountFingerprint: string;
    authorizationRevision: string;
  };
}

export interface DaxiangWebConfig {
  schemaVersion: 1;
  tabMarker: string;
  expectedAccountFingerprint: string;
  allowedPageFingerprints: string[];
  selfConversation: DaxiangConversationConfig;
  watch: {
    enabled: boolean;
    pollIntervalMs: number;
    conversations: DaxiangConversationConfig[];
  };
  limits: {
    contextMessages: number;
    eventPreviewChars: number;
  };
}

export function parseDaxiangConfig(raw: unknown): DaxiangWebConfig;
export function loadDaxiangConfig(file: string): Promise<{ file: string; config: DaxiangWebConfig }>;

export class ChromeJxaDriver {
  constructor(options?: { command?: string; timeoutMs?: number });
  locate(marker: string, allowBind?: boolean): Promise<Record<string, unknown>>;
  execute(marker: string, script: string, allowBind?: boolean): Promise<{ value?: unknown }>;
}

export class DaxiangWebAdapter {
  constructor(options: {
    config: DaxiangWebConfig;
    driver: {
      locate(marker: string, allowBind?: boolean): Promise<unknown>;
      execute(marker: string, script: string, allowBind?: boolean): Promise<{ value?: unknown }>;
    };
    bridgeSource: string;
    stateFile: string;
    configFile?: string;
    diagnosticsFile?: string;
    sendObservationTimeoutMs?: number;
    conversationReadTimeoutMs?: number;
    sessionRefreshIntervalMs?: number;
    sessionRefreshSettleMs?: number;
  });
  static create(options?: Record<string, unknown>): Promise<DaxiangWebAdapter>;
  readonly config: DaxiangWebConfig;
  readonly pollIntervalMs: number;
  loadState(): Promise<void>;
  health(input?: { probe?: boolean }): Promise<Record<string, unknown>>;
  getContext(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  listTargets(input?: Record<string, unknown>): Promise<Record<string, unknown>>;
  searchTargets(input?: Record<string, unknown>): Promise<Record<string, unknown>>;
  bindTarget(input?: Record<string, unknown>): Promise<Record<string, unknown>>;
  poll(): Promise<{ events: Array<Record<string, any>>; health: Record<string, unknown> }>;
  acknowledge(externalIds: string[]): Promise<{ acknowledged: string[] }>;
  send(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  sendToOwner(text: string): Promise<Record<string, unknown>>;
}

export const BRIDGE_FILE: string;
export const ORIGIN: string;
export const SOURCE: string;
