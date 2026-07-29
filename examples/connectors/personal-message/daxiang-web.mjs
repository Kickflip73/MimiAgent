import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ORIGIN = 'https://x.sankuai.com';
const SOURCE = 'personal-message:daxiang';
const DEFAULT_TIMEOUT_MS = 20_000;
const CONVERSATION_SETTLE_MS = 750;
const MAX_CONTEXT_RESULT_BYTES = 28_000;
const BRIDGE_FILE = fileURLToPath(new URL('./daxiang-web-page-bridge.js', import.meta.url));
const ALLOWED_CONFIG_KEYS = new Set([
  'schemaVersion', 'tabMarker', 'expectedAccountFingerprint', 'allowedPageFingerprints',
  'selfConversation', 'watch', 'limits',
]);

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function pageFingerprintFor(shape) {
  return sha256(JSON.stringify({
    bridgeMajor: shape?.bridgeMajor,
    origin: shape?.origin,
    sessionTag: shape?.sessionTag,
    messageTag: shape?.messageTag,
    inputCount: shape?.inputCount,
    inputTag: shape?.inputTag,
    sendButtonCount: shape?.sendButtonCount,
    sendButtonTag: shape?.sendButtonTag,
  }));
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function exactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label}.${key} is not supported`);
}

function boundedString(value, label, maximum, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length > maximum) {
    throw new Error(`${label} must be ${allowEmpty ? 'a' : 'a non-empty'} string up to ${maximum} characters`);
  }
  return value;
}

function sid(value, label = 'sid') {
  const normalized = boundedString(value, label, 40);
  if (!/^\d+$/.test(normalized)) throw new Error(`${label} must contain digits only`);
  return normalized;
}

function conversation(value, label) {
  const item = object(value, label);
  exactKeys(item, new Set(['sid', 'type', 'label', 'binding']), label);
  const type = item.type;
  if (type !== 'chat' && type !== 'groupchat') throw new Error(`${label}.type must be chat or groupchat`);
  let binding;
  if (item.binding !== undefined) {
    const rawBinding = object(item.binding, `${label}.binding`);
    exactKeys(
      rawBinding,
      new Set(['selectedBy', 'accountFingerprint', 'authorizationRevision']),
      `${label}.binding`,
    );
    if (rawBinding.selectedBy !== 'owner') {
      throw new Error(`${label}.binding.selectedBy must be owner`);
    }
    const authorizationRevision = boundedString(
      rawBinding.authorizationRevision,
      `${label}.binding.authorizationRevision`,
      120,
    );
    if (!/^[A-Za-z0-9._:-]+$/.test(authorizationRevision)) {
      throw new Error(`${label}.binding.authorizationRevision is invalid`);
    }
    binding = {
      selectedBy: 'owner',
      accountFingerprint: fingerprint(
        rawBinding.accountFingerprint,
        `${label}.binding.accountFingerprint`,
      ),
      authorizationRevision,
    };
  }
  return {
    sid: sid(item.sid, `${label}.sid`),
    type,
    ...(item.label === undefined ? {} : { label: boundedString(item.label, `${label}.label`, 200) }),
    ...(binding ? { binding } : {}),
  };
}

function integer(value, label, minimum, maximum, fallback) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function fingerprint(value, label, allowEmpty = false) {
  const normalized = boundedString(value, label, 80, allowEmpty);
  if (allowEmpty && normalized === '') return normalized;
  if (!/^sha256:[a-f0-9]{64}$/.test(normalized)) throw new Error(`${label} must be a sha256 fingerprint`);
  return normalized;
}

export function parseDaxiangConfig(raw) {
  const value = object(raw, 'config');
  exactKeys(value, ALLOWED_CONFIG_KEYS, 'config');
  if (value.schemaVersion !== 1) throw new Error('config.schemaVersion must be 1');
  const selfConversation = conversation(value.selfConversation, 'config.selfConversation');
  const watch = object(value.watch, 'config.watch');
  exactKeys(watch, new Set(['enabled', 'pollIntervalMs', 'conversations']), 'config.watch');
  if (typeof watch.enabled !== 'boolean') throw new Error('config.watch.enabled must be boolean');
  if (!Array.isArray(watch.conversations) || watch.conversations.length > 100) {
    throw new Error('config.watch.conversations must be an array with at most 100 items');
  }
  const conversations = watch.conversations.map((item, index) => conversation(item, `config.watch.conversations[${index}]`));
  const seen = new Set();
  for (const item of conversations) {
    const key = `${item.type}:${item.sid}`;
    if (seen.has(key)) throw new Error(`duplicate watched conversation ${key}`);
    seen.add(key);
  }
  const limits = object(value.limits, 'config.limits');
  exactKeys(limits, new Set(['contextMessages', 'eventPreviewChars']), 'config.limits');
  if (!Array.isArray(value.allowedPageFingerprints) || value.allowedPageFingerprints.length > 20) {
    throw new Error('config.allowedPageFingerprints must be an array with at most 20 items');
  }
  return {
    schemaVersion: 1,
    tabMarker: boundedString(value.tabMarker, 'config.tabMarker', 200),
    expectedAccountFingerprint: fingerprint(
      value.expectedAccountFingerprint,
      'config.expectedAccountFingerprint',
      true,
    ),
    allowedPageFingerprints: value.allowedPageFingerprints.map((item, index) => (
      fingerprint(item, `config.allowedPageFingerprints[${index}]`)
    )),
    selfConversation,
    watch: {
      enabled: watch.enabled,
      pollIntervalMs: integer(watch.pollIntervalMs, 'config.watch.pollIntervalMs', 2_000, 24 * 60 * 60_000, 30_000),
      conversations,
    },
    limits: {
      contextMessages: integer(limits.contextMessages, 'config.limits.contextMessages', 1, 100, 50),
      eventPreviewChars: integer(limits.eventPreviewChars, 'config.limits.eventPreviewChars', 1, 4_000, 4_000),
    },
  };
}

export async function loadDaxiangConfig(file) {
  const resolved = path.resolve(file);
  const config = parseDaxiangConfig(JSON.parse(await readFile(resolved, 'utf8')));
  await chmod(resolved, 0o600);
  return { file: resolved, config };
}

const CHROME_SCRIPT = String.raw`
function safe(getter, fallback) {
  try {
    var value = getter();
    return value === undefined || value === null ? fallback : value;
  } catch (_) { return fallback; }
}
function execute(tab, script) {
  return tab.execute({ javascript: script });
}
function run(argv) {
  var input = JSON.parse(argv[0]);
  var app = Application('Google Chrome');
  if (!app.running()) throw new Error('Google Chrome is not running');
  var chromeFrontmost = true;
  try {
    chromeFrontmost = Boolean(
      Application('System Events').applicationProcesses.byName('Google Chrome').frontmost()
    );
  } catch (_) {}
  var windows = app.windows();
  var originCandidates = [];
  var markerCandidates = [];
  for (var wi = 0; wi < windows.length; wi += 1) {
    var window = windows[wi];
    var tabs = window.tabs();
    var activeIndex = Number(safe(function() { return window.activeTabIndex(); }, 1));
    for (var ti = 0; ti < tabs.length; ti += 1) {
      var tab = tabs[ti];
      var url = String(safe(function() { return tab.url(); }, ''));
      if (url !== input.origin && url.indexOf(input.origin + '/') !== 0) continue;
      var active = ti + 1 === activeIndex;
      var marker = String(execute(tab, 'window.name') || '');
      var item = {
        window: wi + 1,
        tab: ti + 1,
        active: active,
        chromeFrontmost: chromeFrontmost,
        marker: marker,
        url: url
      };
      originCandidates.push({ item: item, tab: tab });
      if (marker === input.marker) markerCandidates.push({ item: item, tab: tab });
    }
  }
  if (!markerCandidates.length && input.allowBind) {
    if (originCandidates.length !== 1) throw new Error('expected exactly one Daxiang origin tab for initial binding');
    if (originCandidates[0].item.active && originCandidates[0].item.chromeFrontmost) {
      throw new Error('Daxiang dedicated tab is active while Chrome is frontmost');
    }
    if (originCandidates[0].item.marker && originCandidates[0].item.marker !== input.marker) {
      throw new Error('Daxiang tab already has another marker');
    }
    execute(originCandidates[0].tab, 'window.name = ' + JSON.stringify(input.marker) + '; window.name');
    markerCandidates = originCandidates;
  }
  if (markerCandidates.length !== 1) throw new Error('Daxiang bound tab is missing or ambiguous');
  var target = markerCandidates[0];
  if (target.item.active && target.item.chromeFrontmost) {
    throw new Error('Daxiang dedicated tab is active while Chrome is frontmost');
  }
  if (input.script) {
    var value = execute(target.tab, input.script);
    return JSON.stringify({ tab: target.item, value: value === undefined ? null : value });
  }
  return JSON.stringify({ tab: target.item });
}`;

function runCommand(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error('Chrome Browser Driver timed out'));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > 1024 * 1024) child.kill('SIGTERM');
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) reject(new Error(stderr.trim().slice(0, 2_000) || `Browser Driver exited ${code}`));
      else {
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error('Chrome Browser Driver returned invalid JSON'));
        }
      }
    });
  });
}

export class ChromeJxaDriver {
  constructor(options = {}) {
    this.command = options.command || process.env.MACOS_OSASCRIPT || '/usr/bin/osascript';
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  }

  async locate(marker, allowBind = false) {
    return this.#call({ origin: ORIGIN, marker, allowBind });
  }

  async execute(marker, script, allowBind = false) {
    return this.#call({ origin: ORIGIN, marker, allowBind, script });
  }

  async #call(input) {
    return runCommand(
      this.command,
      ['-l', 'JavaScript', '-e', CHROME_SCRIPT, JSON.stringify(input)],
      this.timeoutMs,
    );
  }
}

function errorCategory(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/not running/i.test(message)) return 'chrome_not_running';
  if (/active/i.test(message)) return 'dedicated_tab_active';
  if (/missing|ambiguous|exactly one/i.test(message)) return 'dedicated_tab_unavailable';
  if (/timed out/i.test(message)) return 'browser_driver_timeout';
  if (/fingerprint/i.test(message)) return 'fingerprint_mismatch';
  return 'adapter_error';
}

function defaultState(configDigest) {
  return { version: 1, configDigest, conversations: {} };
}

export class DaxiangWebAdapter {
  constructor({
    config,
    driver,
    bridgeSource,
    stateFile,
    diagnosticsFile,
    sendObservationTimeoutMs = 15_000,
  }) {
    this.config = config;
    this.driver = driver;
    this.bridgeSource = bridgeSource;
    this.stateFile = stateFile;
    this.diagnosticsFile = diagnosticsFile || path.join(path.dirname(stateFile), 'diagnostics.json');
    this.sendObservationTimeoutMs = integer(
      sendObservationTimeoutMs,
      'sendObservationTimeoutMs',
      1,
      120_000,
      15_000,
    );
    this.configDigest = sha256(JSON.stringify({
      tabMarker: config.tabMarker,
      expectedAccountFingerprint: config.expectedAccountFingerprint,
      selfConversation: config.selfConversation,
    }));
    this.state = defaultState(this.configDigest);
    this.pending = new Map();
    this.lastHealth = undefined;
    this.verifiedAccountFingerprint = undefined;
    this.bridgeReady = false;
  }

  static async create(options = {}) {
    const configFile = options.configFile
      || process.env.DAXIANG_WEB_CONFIG
      || path.join(os.homedir(), '.mimi-agent', 'daemon', 'personal-daxiang.json');
    const { config } = await loadDaxiangConfig(configFile);
    const dataRoot = process.env.MIMI_DAEMON_DATA_DIR
      || path.join(os.homedir(), '.mimi-agent', 'daemon');
    const stateFile = options.stateFile || path.join(
      dataRoot,
      'connector-state',
      'personal-message-daxiang',
      'cursor.json',
    );
    const adapter = new DaxiangWebAdapter({
      config,
      driver: options.driver || new ChromeJxaDriver({
        timeoutMs: integer(
          process.env.DAXIANG_WEB_COMMAND_TIMEOUT_MS,
          'DAXIANG_WEB_COMMAND_TIMEOUT_MS',
          1_000,
          120_000,
          DEFAULT_TIMEOUT_MS,
        ),
      }),
      bridgeSource: options.bridgeSource || await readFile(BRIDGE_FILE, 'utf8'),
      stateFile,
      diagnosticsFile: options.diagnosticsFile,
    });
    await adapter.loadState();
    return adapter;
  }

  get pollIntervalMs() {
    return this.config.watch.pollIntervalMs;
  }

  async loadState() {
    try {
      const raw = object(JSON.parse(await readFile(this.stateFile, 'utf8')), 'state');
      this.state = raw.configDigest === this.configDigest
        ? {
            version: 1,
            configDigest: this.configDigest,
            conversations: object(raw.conversations || {}, 'state.conversations'),
          }
        : defaultState(this.configDigest);
      await chmod(this.stateFile, 0o600);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      this.state = defaultState(this.configDigest);
    }
  }

  async health({ probe = false } = {}) {
    try {
      await this.driver.locate(this.config.tabMarker, probe);
      const inspect = await this.#bridgeCall('inspect', { selfSid: this.config.selfConversation.sid }, probe);
      const observedAccountFingerprint = inspect.selfIdentityUnique === true && inspect.selfIdentityLabel
        ? sha256(`daxiang-web-v1\0${ORIGIN}\0${this.config.selfConversation.sid}\0${sha256(inspect.selfIdentityLabel)}`)
        : undefined;
      const pageFingerprint = pageFingerprintFor(inspect.pageShape);
      const readable = Boolean(inspect.readable && inspect.pageShape?.bridgeMajor === 1);
      if (inspect.selfIdentityAmbiguous === true
        || (observedAccountFingerprint
          && observedAccountFingerprint !== this.config.expectedAccountFingerprint)) {
        this.verifiedAccountFingerprint = undefined;
      } else if (observedAccountFingerprint === this.config.expectedAccountFingerprint) {
        this.verifiedAccountFingerprint = observedAccountFingerprint;
      }
      const accountFingerprint = observedAccountFingerprint
        || (readable && inspect.selfIdentityAmbiguous !== true
          ? this.verifiedAccountFingerprint
          : undefined);
      const accountVerified = Boolean(
        accountFingerprint
        && this.config.expectedAccountFingerprint
        && accountFingerprint === this.config.expectedAccountFingerprint
      );
      const accountEvidence = observedAccountFingerprint
        ? 'observed'
        : accountVerified
          ? 'dedicated_tab_session'
          : inspect.selfIdentityAmbiguous === true
            ? 'ambiguous'
            : 'unavailable';
      const pageAllowed = this.config.allowedPageFingerprints.includes(pageFingerprint);
      const configuredBindings = [
        this.config.selfConversation,
        ...this.config.watch.conversations,
      ].filter((target) => target.binding?.selectedBy === 'owner'
        && target.binding.accountFingerprint === accountFingerprint);
      let targetBound = false;
      if (accountVerified) {
        for (const target of configuredBindings) {
          const candidate = await this.#bridgeCall('targetCandidate', {
            sid: target.sid,
            type: target.type,
          });
          if (candidate.matched === true
            && candidate.sid === target.sid
            && candidate.type === target.type) {
            targetBound = true;
            break;
          }
        }
      }
      const now = new Date().toISOString();
      const errorCategory = !readable
        ? 'page_unreadable'
        : !accountVerified
          ? 'account_fingerprint_mismatch'
          : !targetBound
            ? configuredBindings.length === 0 ? 'owner_binding_missing' : 'target_candidate_missing'
            : !pageAllowed ? 'page_fingerprint_mismatch' : undefined;
      this.lastHealth = {
        available: readable,
        accountVerified,
        accountFingerprint,
        accountEvidence,
        pageFingerprint,
        pageAllowed,
        backgroundSafe: true,
        targetBound,
        ...(targetBound ? { targetBindingStatus: 'bound' } : { targetBindingStatus: 'target_not_bound' }),
        coverage: readable && accountVerified && targetBound ? 'bounded' : 'unavailable',
        contextRead: readable && accountVerified && targetBound ? 'bounded' : 'unavailable',
        inbound: readable && accountVerified && targetBound ? 'ready' : 'unavailable',
        outbound: readable && accountVerified && targetBound && pageAllowed && inspect.sendStructureReady
          ? 'ready'
          : 'unavailable',
        deliveryConfirmed: false,
        changesReadState: 'unknown',
        stableConversationId: inspect.pageShape?.stableSessionCount > 0,
        stableMessageId: inspect.pageShape?.stableMessageCount > 0,
        probedAt: now,
        ...(errorCategory ? { errorCategory } : {}),
      };
      if (readable) await this.#bridgeCall('installObserver', {});
      await this.#recordDiagnostics({
        checkedAt: now,
        coverage: this.lastHealth.coverage,
        accountVerified,
        backgroundSafe: true,
        pageFingerprint,
        accountFingerprintDigest: accountFingerprint ? sha256(accountFingerprint) : undefined,
      });
      return {
        ...this.lastHealth,
        currentAccountFingerprint: accountFingerprint,
        currentPageFingerprint: pageFingerprint,
      };
    } catch (error) {
      const now = new Date().toISOString();
      const category = errorCategory(error);
      if (category === 'chrome_not_running' || category === 'dedicated_tab_unavailable') {
        this.verifiedAccountFingerprint = undefined;
      }
      if (!probe && category === 'dedicated_tab_unavailable') {
        await this.#recordDiagnostics({
          checkedAt: now,
          coverage: 'unavailable',
          accountVerified: false,
          backgroundSafe: false,
          errorCategory: category,
          recoveryAttempted: true,
          recovered: false,
        });
        const recovered = await this.health({ probe: true });
        const recoverySucceeded = recovered.accountVerified === true
          && recovered.inbound === 'ready';
        this.lastHealth = {
          ...recovered,
          recoveryAttempted: true,
          recovered: recoverySucceeded,
        };
        await this.#recordDiagnostics({
          checkedAt: new Date().toISOString(),
          coverage: this.lastHealth.coverage,
          accountVerified: this.lastHealth.accountVerified,
          backgroundSafe: this.lastHealth.backgroundSafe,
          ...(this.lastHealth.errorCategory ? { errorCategory: this.lastHealth.errorCategory } : {}),
          recoveryAttempted: true,
          recovered: recoverySucceeded,
        });
        return this.lastHealth;
      }
      this.lastHealth = {
        available: false,
        accountVerified: false,
        backgroundSafe: false,
        coverage: 'unavailable',
        contextRead: 'unavailable',
        inbound: 'unavailable',
        outbound: 'unavailable',
        deliveryConfirmed: false,
        changesReadState: 'unknown',
        stableConversationId: false,
        stableMessageId: false,
        targetBound: false,
        targetBindingStatus: 'target_not_bound',
        probedAt: now,
        errorCategory: category,
      };
      await this.#recordDiagnostics({
        checkedAt: now,
        coverage: 'unavailable',
        accountVerified: false,
        backgroundSafe: false,
        errorCategory: this.lastHealth.errorCategory,
      });
      return this.lastHealth;
    }
  }

  async getContext(input) {
    this.#assertAccount(input.accountFingerprint);
    const target = this.#allowedConversation(input.sid, input.type);
    if (!await this.#targetAvailable(target)) {
      throw new Error('target_not_bound: Daxiang conversation is not uniquely available on the current page');
    }
    const limit = integer(input.limit, 'limit', 1, 100, this.config.limits.contextMessages);
    const snapshot = await this.#readConversation(target, limit);
    const messages = snapshot.messages
      .filter((message) => message.mid && (
        message.direction === 'incoming' || message.direction === 'outgoing'
      ))
      .map((message) => ({
        id: message.mid,
        direction: message.direction,
        ...(this.#actorId(target, message) ? { actorId: this.#actorId(target, message) } : {}),
        ...(message.text ? { text: message.text.slice(0, this.config.limits.eventPreviewChars) } : {}),
        ...(Number.isFinite(Date.parse(message.occurredAt)) ? {
          occurredAt: new Date(message.occurredAt).toISOString(),
        } : {}),
      }));
    const result = {
      channel: 'daxiang',
      accountFingerprint: this.lastHealth.accountFingerprint,
      conversationId: this.#conversationId(target.sid),
      coverage: 'bounded',
      observedAt: snapshot.capturedAt,
      latestFingerprint: this.#latestFingerprint(target.sid, snapshot.messages),
      messages,
      truncated: snapshot.messages.length >= limit,
    };
    let omittedMessageCount = 0;
    while (result.messages.length > 1
      && Buffer.byteLength(JSON.stringify(result)) > MAX_CONTEXT_RESULT_BYTES) {
      result.messages.shift();
      omittedMessageCount += 1;
    }
    if (omittedMessageCount > 0) {
      result.truncated = true;
      result.omittedMessageCount = omittedMessageCount;
      result.truncationReason = 'response_budget';
    }
    return result;
  }

  async listTargets() {
    const health = await this.health();
    if (!health.accountVerified) {
      return {
        channel: 'daxiang',
        accountVerified: false,
        coverage: 'unavailable',
        configuredTargetCount: 0,
        unavailableTargetCount: 0,
        targets: [],
        targetBindingStatus: 'target_not_bound',
        contextReadUsage: 'get_context 必须逐个使用 targets[].sid；* 和 all 无效',
      };
    }
    const configured = [
      { ...this.config.selfConversation, role: 'self' },
      ...this.config.watch.conversations.map((target) => ({ ...target, role: 'watch' })),
    ];
    const targets = [];
    for (const target of configured) {
      if (!this.#bindingMatches(target) || !await this.#targetAvailable(target)) continue;
      const { binding, ...visible } = target;
      targets.push({
        ...visible,
        bound: true,
        authorizationRevision: binding.authorizationRevision,
      });
    }
    return {
      channel: 'daxiang',
      accountVerified: true,
      coverage: health.coverage,
      configuredTargetCount: configured.length,
      unavailableTargetCount: configured.length - targets.length,
      targets,
      targetBindingStatus: targets.length === configured.length ? 'bound' : 'target_not_bound',
      contextReadUsage: 'get_context 必须逐个使用 targets[].sid；* 和 all 无效',
    };
  }

  async poll() {
    const health = await this.health();
    if (!this.config.watch.enabled || !health.accountVerified || health.inbound !== 'ready') {
      return { events: [], health };
    }
    await this.#bridgeCall('drain', {});
    const events = [];
    let stateChanged = false;
    for (const target of this.config.watch.conversations) {
      if (!this.#bindingMatches(target) || !await this.#targetAvailable(target)) continue;
      const snapshot = await this.#readConversation(target, this.config.limits.contextMessages);
      const current = this.state.conversations[target.sid];
      if (!current?.initialized) {
        this.state.conversations[target.sid] = {
          initialized: true,
          ackedMids: [...new Set(snapshot.messages.map((message) => message.mid).filter(Boolean))].slice(-256),
          initializedAt: new Date().toISOString(),
        };
        stateChanged = true;
        continue;
      }
      const acknowledged = new Set(current.ackedMids || []);
      for (const message of snapshot.messages) {
        if (!message.mid || acknowledged.has(message.mid) || message.direction !== 'incoming') continue;
        const externalId = `daxiang:${this.#accountDigest()}:${target.sid}:${message.mid}`;
        const payload = {
          version: 1,
          channel: 'daxiang',
          accountFingerprint: this.lastHealth.accountFingerprint,
          messageId: message.mid,
          direction: 'incoming',
          messageType: 'text',
          coverage: 'bounded',
          ...(message.text ? { preview: message.text.slice(0, this.config.limits.eventPreviewChars) } : {}),
        };
        const event = {
          type: 'event',
          externalId,
          kind: 'command',
          payload,
          occurredAt: Number.isFinite(Date.parse(message.occurredAt))
            ? new Date(message.occurredAt).toISOString()
            : snapshot.capturedAt,
          priority: 60,
          ...(this.#actorId(target, message) ? { actor: { id: this.#actorId(target, message) } } : {}),
          conversation: { id: this.#conversationId(target.sid) },
        };
        this.pending.set(externalId, { sid: target.sid, mid: message.mid });
        events.push(event);
      }
    }
    if (stateChanged) await this.#saveState();
    return { events, health: { ...health, lastObservedAt: new Date().toISOString() } };
  }

  async acknowledge(externalIds) {
    const acknowledged = [];
    for (const externalId of externalIds) {
      const item = this.pending.get(externalId);
      if (!item) continue;
      const current = this.state.conversations[item.sid] || { ackedMids: [] };
      const mids = [...new Set([...current.ackedMids, item.mid])].slice(-256);
      this.state.conversations[item.sid] = {
        ...current,
        initialized: true,
        ackedMids: mids,
        acknowledgedAt: new Date().toISOString(),
      };
      this.pending.delete(externalId);
      acknowledged.push(externalId);
    }
    if (acknowledged.length) await this.#saveState();
    return { acknowledged };
  }

  async send(input) {
    this.#assertAccount(input.accountFingerprint);
    if (!this.lastHealth.pageAllowed || this.lastHealth.outbound !== 'ready') {
      return this.#failure('页面指纹未获准或写能力不可用');
    }
    const target = this.#allowedConversation(input.sid, input.type);
    const text = boundedString(input.text, 'text', 4_000);
    const original = await this.#selectedConversation();
    const restore = original
      && (original.sid !== target.sid || original.type !== target.type);
    try {
      const context = await this.getContext({
        accountFingerprint: input.accountFingerprint,
        sid: target.sid,
        type: target.type,
        limit: 1,
      });
      if (context.latestFingerprint !== input.latestFingerprint) {
        return this.#failure('会话最新消息已经变化');
      }
      const attemptId = randomUUID();
      const selected = await this.#select(target);
      if (!selected) return this.#failure('目标会话无法稳定选中');
      const prepared = await this.#bridgeCall('prepareSend', {
        attemptId,
        sid: target.sid,
        type: target.type,
        text,
      });
      if (!prepared.prepared) return this.#failure(`发送准备失败：${prepared.reason || 'unknown'}`);
      const committed = await this.#bridgeCall('commitSend', { attemptId });
      if (!committed.dispatched) return this.#failure(`发送前校验失败：${committed.reason || 'unknown'}`);
      const deadline = Date.now() + this.sendObservationTimeoutMs;
      while (Date.now() < deadline) {
        try {
          const observed = await this.#bridgeCall('observeSend', { attemptId });
          if (observed.status === 'observed') {
            return {
              status: 'observed',
              route: 'browser',
              deliveryConfirmed: false,
              accountVerified: true,
              targetVerified: true,
              evidence: `new stable message id ${observed.message.mid} observed once`,
            };
          }
          if (observed.status === 'failed') return this.#failure(observed.reason);
          if (observed.status === 'uncertain') return this.#uncertain(observed.reason);
        } catch (error) {
          return this.#uncertain(errorCategory(error));
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return this.#uncertain('post-click observation timed out');
    } finally {
      if (restore && !await this.#select(original)) {
        throw new Error('uncertain: Daxiang original conversation could not be restored');
      }
    }
  }

  #failure(error) {
    return {
      status: 'failed',
      route: 'browser',
      deliveryConfirmed: false,
      accountVerified: this.lastHealth?.accountVerified === true,
      targetVerified: false,
      error,
    };
  }

  #uncertain(error) {
    return {
      status: 'uncertain',
      route: 'browser',
      deliveryConfirmed: false,
      accountVerified: this.lastHealth?.accountVerified === true,
      targetVerified: true,
      error,
    };
  }

  #assertAccount(expected) {
    if (!this.lastHealth?.accountVerified || expected !== this.lastHealth.accountFingerprint) {
      throw new Error('Daxiang account fingerprint is not verified');
    }
  }

  #allowedConversation(targetSid, targetType) {
    const normalizedSid = sid(targetSid);
    const available = [
      this.config.selfConversation,
      ...this.config.watch.conversations,
    ].find((item) => item.sid === normalizedSid && (!targetType || item.type === targetType));
    if (!available) throw new Error('conversation is not in the configured allowlist');
    if (available.binding?.selectedBy !== 'owner'
      || available.binding.accountFingerprint !== this.lastHealth?.accountFingerprint) {
      throw new Error('target_not_bound: owner stable sid binding is missing or stale');
    }
    return available;
  }

  async #readConversation(target, limit) {
    const original = await this.#selectedConversation();
    const restore = original
      && (original.sid !== target.sid || original.type !== target.type);
    try {
      const selection = await this.#select(target);
      if (!selection) throw new Error('Daxiang conversation route did not stabilize');
      const deadline = Date.now() + 10_000;
      const settleAfter = selection.changed === true
        ? Date.now() + CONVERSATION_SETTLE_MS
        : 0;
      let previousSignature;
      while (Date.now() < deadline) {
        const snapshot = await this.#bridgeCall('readCurrentConversation', {
          sid: target.sid,
          type: target.type,
          limit,
        });
        if (snapshot.matched) {
          const signature = JSON.stringify(snapshot.messages.map((message) => [
            message.mid,
            message.direction,
            message.receipt,
          ]));
          if (Date.now() >= settleAfter && signature === previousSignature) return snapshot;
          previousSignature = signature;
        } else {
          previousSignature = undefined;
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      throw new Error('Daxiang conversation read timed out');
    } finally {
      if (restore && !await this.#select(original)) {
        throw new Error('Daxiang original conversation could not be restored');
      }
    }
  }

  async #selectedConversation() {
    const inspected = await this.#bridgeCall('inspect', {
      selfSid: this.config.selfConversation.sid,
    });
    return inspected.selected
      && /^\d+$/.test(String(inspected.selected.sid))
      && (inspected.selected.type === 'chat' || inspected.selected.type === 'groupchat')
      ? { sid: String(inspected.selected.sid), type: inspected.selected.type }
      : undefined;
  }

  #bindingMatches(target) {
    return target.binding?.selectedBy === 'owner'
      && target.binding.accountFingerprint === this.lastHealth?.accountFingerprint;
  }

  async #targetAvailable(target) {
    const candidate = await this.#bridgeCall('targetCandidate', {
      sid: target.sid,
      type: target.type,
    });
    return candidate.matched === true
      && candidate.sid === target.sid
      && candidate.type === target.type;
  }

  async #select(target) {
    const selected = await this.#bridgeCall('selectConversation', target);
    if (!selected.selected) return false;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const snapshot = await this.#bridgeCall('readCurrentConversation', {
        sid: target.sid,
        type: target.type,
        limit: 1,
      });
      if (snapshot.matched) return selected;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return false;
  }

  async #bridgeCall(method, input, allowBind = false) {
    const invocation = `JSON.stringify(window.__mimiDaxiangBridge.${method}(${JSON.stringify(input)}))`;
    const guardedInvocation = `typeof window.__mimiDaxiangBridge === 'object' ? ${invocation} : '__MIMI_DAXIANG_BRIDGE_MISSING__'`;
    if (!this.bridgeReady) {
      await this.driver.execute(this.config.tabMarker, this.bridgeSource, allowBind);
      this.bridgeReady = true;
    }
    let result = await this.driver.execute(
      this.config.tabMarker,
      guardedInvocation,
      allowBind,
    );
    if (result?.value === '__MIMI_DAXIANG_BRIDGE_MISSING__') {
      await this.driver.execute(this.config.tabMarker, this.bridgeSource, allowBind);
      this.bridgeReady = true;
      result = await this.driver.execute(
        this.config.tabMarker,
        invocation,
        false,
      );
    }
    const value = result?.value;
    if (typeof value !== 'string') throw new Error(`Daxiang bridge ${method} returned invalid output`);
    return JSON.parse(value);
  }

  #conversationId(targetSid) {
    return `daxiang:${this.#accountDigest()}:${targetSid}`;
  }

  #accountDigest() {
    return this.lastHealth.accountFingerprint.slice('sha256:'.length, 'sha256:'.length + 16);
  }

  #actorId(target, message) {
    if (target.type === 'chat' && message.direction === 'incoming') {
      return sha256(`daxiang-chat-actor-v1\0${this.lastHealth.accountFingerprint}\0${target.sid}`);
    }
    return message.actorId
      ? sha256(`daxiang-actor-v1\0${message.actorId}`)
      : undefined;
  }

  #latestFingerprint(targetSid, messages) {
    const latest = messages.at(-1);
    return sha256(JSON.stringify({
      sid: targetSid,
      mid: latest?.mid || '',
      direction: latest?.direction || 'unknown',
      text: latest?.text || '',
    }));
  }

  async #saveState() {
    await this.#writePrivateJson(this.stateFile, this.state);
  }

  async #saveDiagnostics(value) {
    await this.#writePrivateJson(this.diagnosticsFile, { version: 1, ...value });
  }

  async #recordDiagnostics(value) {
    try {
      await this.#saveDiagnostics(value);
    } catch {
      // Diagnostics are best-effort and must never expose page data through an
      // error path. Cursor persistence remains strict in acknowledge().
    }
  }

  async #writePrivateJson(file, value) {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await chmod(path.dirname(file), 0o700);
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    try {
      await chmod(temporary, 0o600);
      await rename(temporary, file);
      await chmod(file, 0o600);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

export { BRIDGE_FILE, ORIGIN, SOURCE };
