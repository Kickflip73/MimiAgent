#!/usr/bin/env node

/**
 * MimiAgent ↔ Chrome Browser Connector.
 *
 * OpenCLI owns Chrome/CDP/extension details. This process exposes a bounded,
 * structured NDJSON action surface and keeps Mimi-owned browser sessions
 * separate from sessions created directly by the owner.
 */

import { randomUUID } from 'node:crypto';
import { accessSync, constants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const opencli = resolveOpenCli();
const commandTimeoutMs = numberEnv(
  'OPENCLI_BROWSER_COMMAND_TIMEOUT_MS',
  30_000,
  1_000,
  300_000,
);
const maxOutputBytes = numberEnv(
  'OPENCLI_BROWSER_MAX_OUTPUT_BYTES',
  1_000_000,
  32_000,
  8_000_000,
);
const navigationSettleMs = numberEnv(
  'OPENCLI_BROWSER_NAVIGATION_SETTLE_MS',
  4_000,
  100,
  10_000,
);
const ACTIONS = new Set([
  'doctor',
  'read_url',
  'open_session',
  'bind_session',
  'close_session',
  'probe_tabs',
  'list_tabs',
  'new_tab',
  'select_tab',
  'close_tab',
  'snapshot',
  'find',
  'read_page',
  'read_element',
  'extract',
  'frames',
  'network',
  'wait',
  'navigate',
  'back',
  'click',
  'type',
  'fill',
  'select',
  'check',
  'uncheck',
  'hover',
  'focus',
  'double_click',
  'keys',
  'scroll',
  'upload',
  'drag',
  'dialog',
  'execute_javascript',
]);
const WRITE_ACTIONS = new Set([
  'open_session',
  'bind_session',
  'close_session',
  'new_tab',
  'select_tab',
  'close_tab',
  'navigate',
  'back',
  'click',
  'type',
  'fill',
  'select',
  'check',
  'uncheck',
  'hover',
  'focus',
  'double_click',
  'keys',
  'scroll',
  'upload',
  'drag',
  'dialog',
  'execute_javascript',
]);
const OBSERVATION_ACTIONS = new Set(['list_tabs', 'snapshot', 'find']);
const MAX_LOGICAL_TABS = 20;
const sessions = new Map();

class OpenCliError extends Error {
  constructor(message, uncertain = false) {
    super(message);
    this.name = 'OpenCliError';
    this.uncertain = uncertain;
  }
}

function resolveOpenCli() {
  if (process.env.OPENCLI_BIN) return process.env.OPENCLI_BIN;
  const sibling = path.join(path.dirname(process.execPath), 'opencli');
  try {
    accessSync(sibling, constants.X_OK);
    return sibling;
  } catch {
    return 'opencli';
  }
}

function numberEnv(name, fallback, minimum, maximum) {
  if (process.env[name] === undefined || process.env[name] === '') return fallback;
  const value = Number(process.env[name]);
  if (Number.isInteger(value) && value >= minimum && value <= maximum) return value;
  process.stderr.write(`[browser] invalid ${name}; using ${fallback}\n`);
  return fallback;
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function payloadObject(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('payload must be an object');
  }
  return value;
}

function boundedString(value, label, maximum, required = false) {
  if (typeof value !== 'string'
    || (required && !value.trim())
    || value.length > maximum) {
    throw new Error(
      `${label} must be ${required ? 'a non-empty ' : 'a '}string with at most ${maximum} characters`,
    );
  }
  return value;
}

function optionalString(value, label, maximum) {
  if (value === undefined) return undefined;
  return boundedString(value, label, maximum);
}

function optionalElementRef(value, label) {
  if (value === undefined) return undefined;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return String(value);
  return boundedString(value, label, 2_000, true);
}

function integer(value, label, minimum, maximum, fallback) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function boolean(value, label, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`);
  return value;
}

function url(value, label = 'payload.url') {
  const raw = boundedString(value, label, 8_000, true);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${label} must be an absolute http or https URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${label} must be an absolute http or https URL`);
  }
  return parsed.toString();
}

function label(value) {
  const raw = boundedString(value, 'target', 64, true);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(raw)) {
    throw new Error('target label must use letters, numbers, dot, underscore, or hyphen');
  }
  return raw;
}

function sessionRef(value) {
  const raw = boundedString(value, 'target', 100, true);
  const session = sessions.get(raw);
  if (!session) throw new Error('browser session is missing or expired; open or bind a new session');
  return session;
}

function pageOption(payload) {
  optionalString(payload.page, 'payload.page', 500);
  return [];
}

function locatorOptions(payload, prefix = '') {
  const options = [];
  const flagPrefix = prefix ? `${prefix}-` : '';
  for (const [key, flag] of [
    ['role', 'role'],
    ['name', 'name'],
    ['label', 'label'],
    ['text', 'text'],
    ['testid', 'testid'],
  ]) {
    const payloadKey = prefix
      ? `${prefix}${key[0].toUpperCase()}${key.slice(1)}`
      : key;
    const value = optionalString(payload[payloadKey], `payload.${payloadKey}`, 1_000);
    if (value !== undefined) options.push(`--${flagPrefix}${flag}`, value);
  }
  return options;
}

function targetAndLocator(payload, targetKey = 'element', prefix = '') {
  const explicitTarget = optionalElementRef(payload[targetKey], `payload.${targetKey}`);
  const ref = prefix || targetKey !== 'element'
    ? undefined
    : optionalElementRef(payload.ref, 'payload.ref');
  const locatorTarget = prefix || targetKey !== 'element'
    ? undefined
    : optionalElementRef(payload.locator, 'payload.locator');
  const selectorTarget = prefix || targetKey !== 'element'
    ? undefined
    : optionalElementRef(payload.selector, 'payload.selector');
  const targetCandidates = [explicitTarget, ref, locatorTarget, selectorTarget].filter(
    (candidate) => candidate !== undefined,
  );
  if (targetCandidates.length > 1) {
    throw new Error(
      'use only one of payload.ref, payload.locator, payload.selector, or payload.element',
    );
  }
  const target = targetCandidates[0];
  const locator = locatorOptions(payload, prefix);
  if (!target && locator.length === 0) {
    throw new Error(
      targetKey === 'element'
        ? 'payload.ref, payload.locator, payload.selector, payload.element, or a semantic locator is required'
        : `payload.${targetKey} or a semantic locator is required`,
    );
  }
  if (target && locator.length > 0) {
    throw new Error(`use payload.${targetKey} or a semantic locator, not both`);
  }
  const nthKey = prefix ? `${prefix}Nth` : 'nth';
  const nth = payload[nthKey] === undefined
    ? undefined
    : integer(payload[nthKey], `payload.${nthKey}`, 0, 10_000);
  return {
    target,
    options: [
      ...locator,
      ...(nth === undefined ? [] : [`--${prefix ? `${prefix}-` : ''}nth`, String(nth)]),
    ],
  };
}

function parseOutput(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return { text: trimmed };
  }
}

function structuredError(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const error = value.error;
  if (!error || typeof error !== 'object' || Array.isArray(error)) return undefined;
  const code = typeof error.code === 'string' ? error.code : 'opencli_error';
  const message = typeof error.message === 'string' ? error.message : JSON.stringify(error);
  return `${code}: ${message}`;
}

function runOpenCli(args, options = {}) {
  const timeoutMs = options.timeoutMs ?? commandTimeoutMs;
  const uncertainOnFailure = options.uncertainOnFailure === true;
  return new Promise((resolve, reject) => {
    const child = spawn(opencli, args, {
      env: {
        PATH: [
          path.dirname(process.execPath),
          process.env.PATH,
        ].filter(Boolean).join(path.delimiter),
        HOME: process.env.HOME,
        LANG: process.env.LANG,
        LC_ALL: process.env.LC_ALL,
        TMPDIR: process.env.TMPDIR,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let overflow = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1_000).unref();
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > maxOutputBytes) {
        overflow = true;
        child.kill('SIGTERM');
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr) > 64_000) stderr = stderr.slice(-64_000);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(new OpenCliError(`cannot start OpenCLI: ${error.message}`, false));
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new OpenCliError(
          `OpenCLI command timed out after ${timeoutMs}ms`,
          uncertainOnFailure,
        ));
        return;
      }
      if (overflow) {
        reject(new OpenCliError(
          `OpenCLI output exceeds ${maxOutputBytes} bytes`,
          uncertainOnFailure,
        ));
        return;
      }
      const result = parseOutput(stdout);
      const envelopeError = structuredError(result);
      if (code !== 0) {
        reject(new OpenCliError(
          envelopeError
            || stderr.trim()
            || `OpenCLI exited code=${code} signal=${signal || 'none'}`,
          uncertainOnFailure && envelopeError === undefined,
        ));
        return;
      }
      if (envelopeError) {
        reject(new OpenCliError(envelopeError, false));
        return;
      }
      resolve(result);
    });
  });
}

async function inspectOpenCliStatus() {
  const result = await runOpenCli(
    ['daemon', 'status'],
    { timeoutMs: Math.min(commandTimeoutMs, 15_000) },
  );
  const text = typeof result?.text === 'string' ? result.text : '';
  const daemonRunning = /^Daemon:\s+running\b/im.test(text);
  const extensionConnected = /^Extension:\s+connected\b/im.test(text);
  if (!daemonRunning || !extensionConnected) {
    throw new OpenCliError(
      `OpenCLI is unavailable: daemon=${daemonRunning ? 'running' : 'not_running'}, `
        + `extension=${extensionConnected ? 'connected' : 'disconnected'}`,
      false,
    );
  }
  return {
    daemon: 'running',
    extension: 'connected',
  };
}

function logicalTab(session, payload = {}) {
  if (!(session.tabs instanceof Map)) return session;
  const requestedPage = optionalString(payload.page, 'payload.page', 500);
  const page = requestedPage ?? session.activePage;
  const tab = page ? session.tabs.get(page) : undefined;
  if (!tab) {
    throw new Error(requestedPage
      ? 'browser page is missing or expired; call list_tabs and use a current page ID'
      : 'browser session has no active page; open a new tab or close the session');
  }
  return tab;
}

function browserArgs(session, command, payload = {}) {
  return ['browser', logicalTab(session, payload).opencliSession, ...command];
}

function pageUrlFromResult(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  for (const key of ['url', 'value', 'text']) {
    if (typeof value[key] === 'string') return value[key].trim();
  }
  return undefined;
}

function registerLogicalTab(session, opencliSession, kind, result) {
  const page = `page:${randomUUID()}`;
  const tab = {
    page,
    opencliSession,
    kind,
    url: pageUrlFromResult(result),
  };
  session.tabs.set(page, tab);
  session.activePage = page;
  return tab;
}

function publicTabResult(result, tab, extra = {}) {
  const safe = result && typeof result === 'object' && !Array.isArray(result)
    ? { ...result }
    : { result };
  delete safe.page;
  return {
    ...safe,
    page: tab.page,
    ...(tab.url ? { url: tab.url } : {}),
    active: true,
    ...extra,
  };
}

async function listLogicalTabs(session) {
  const tabs = await Promise.all([...session.tabs.values()].map(async (tab) => {
    const result = await runOpenCli(['browser', tab.opencliSession, 'tab', 'list']);
    const native = Array.isArray(result)
      ? result.find((entry) => entry?.active === true) ?? result[0]
      : undefined;
    const currentUrl = pageUrlFromResult(native);
    if (currentUrl) tab.url = currentUrl;
    return {
      page: tab.page,
      ...(tab.url ? { url: tab.url } : {}),
      ...(typeof native?.title === 'string' ? { title: native.title } : {}),
      active: tab.page === session.activePage,
    };
  }));
  return {
    tabs,
    activePage: session.activePage,
    observationId: randomUUID(),
    untrusted: true,
  };
}

async function settleNavigation(session, payload, beforeUrl, expectedUrl) {
  const deadline = Date.now() + navigationSettleMs;
  while (Date.now() < deadline) {
    try {
      const result = await runOpenCli(
        browserArgs(session, ['get', 'url', ...pageOption(payload)], payload),
        { timeoutMs: Math.min(commandTimeoutMs, 1_000) },
      );
      const currentUrl = pageUrlFromResult(result);
      if (currentUrl && (currentUrl === expectedUrl || currentUrl !== beforeUrl)) {
        return { navigationSettled: true, url: currentUrl };
      }
    } catch {
      // Navigation can briefly invalidate the page context; retry within the fixed deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { navigationSettled: false };
}

function sanitizeWriteResult(action, result, payload) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { result };
  }
  const safe = { ...result };
  if (action === 'type' || action === 'fill') {
    delete safe.text;
    delete safe.actual;
    safe.textLength = typeof payload.value === 'string' ? payload.value.length : 0;
  }
  if (action === 'dialog') {
    delete safe.text;
    if (typeof payload.value === 'string') safe.textLength = payload.value.length;
  }
  if (action === 'upload') {
    delete safe.files;
    safe.fileNames = Array.isArray(payload.files)
      ? payload.files.map((file) => path.basename(String(file)))
      : [];
  }
  return safe;
}

function redactNetworkValue(value) {
  if (Array.isArray(value)) return value.map(redactNetworkValue);
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (/authorization|cookie|token|secret|password|body/i.test(key)) {
      output[key] = '[REDACTED]';
    } else if (key === 'url' && typeof item === 'string') {
      try {
        const parsed = new URL(item);
        parsed.search = '';
        parsed.hash = '';
        output[key] = parsed.toString();
      } catch {
        output[key] = item;
      }
    } else output[key] = redactNetworkValue(item);
  }
  return output;
}

function normalizeSnapshotResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.text !== 'string') {
    return value;
  }
  return {
    ...value,
    text: value.text
      .split('\n')
      .filter((line) => !/^\s*\[\d+\]<option\b/i.test(line))
      .join('\n'),
  };
}

async function createSession(kind, target, payload) {
  const logicalLabel = label(target);
  if (sessions.has(logicalLabel)) {
    throw new Error('browser session label already exists; close the current session before reopening it');
  }
  const ref = `browser:${randomUUID()}`;
  const opencliSession = `mimi-${logicalLabel}-${randomUUID().slice(0, 8)}`;
  const session = {
    ref,
    kind,
    logicalLabel,
    tabs: new Map(),
    activePage: undefined,
  };
  sessions.set(ref, session);
  sessions.set(logicalLabel, session);
  if (kind === 'owned') {
    if (payload.window !== undefined && payload.window !== 'background') {
      sessions.delete(logicalLabel);
      sessions.delete(ref);
      throw new Error('payload.window must be background; foreground browser sessions are disabled');
    }
    try {
      const result = await runOpenCli([
        'browser',
        opencliSession,
        'open',
        url(payload.url),
        '--window',
        'background',
      ], { uncertainOnFailure: true });
      const tab = registerLogicalTab(session, opencliSession, 'owned', result);
      return {
        sessionRef: ref,
        kind,
        ...publicTabResult(result, tab),
        outcome: 'confirmed',
        untrusted: true,
      };
    } catch (error) {
      if (error?.uncertain === true) {
        const tab = registerLogicalTab(session, opencliSession, 'owned', undefined);
        return {
          sessionRef: ref,
          kind,
          page: tab.page,
          outcome: 'accepted',
          reason: errorText(error),
          untrusted: true,
        };
      }
      sessions.delete(logicalLabel);
      sessions.delete(ref);
      throw error;
    }
  }
  try {
    const result = await runOpenCli([
      'browser',
      opencliSession,
      'bind',
    ], { uncertainOnFailure: true });
    const tab = registerLogicalTab(session, opencliSession, 'bound', result);
    return {
      sessionRef: ref,
      kind,
      ...publicTabResult(result, tab),
      outcome: 'confirmed',
      untrusted: true,
    };
  } catch (error) {
    if (error?.uncertain === true) {
      const tab = registerLogicalTab(session, opencliSession, 'bound', undefined);
      return {
        sessionRef: ref,
        kind,
        page: tab.page,
        outcome: 'accepted',
        reason: errorText(error),
        untrusted: true,
      };
    }
    sessions.delete(logicalLabel);
    sessions.delete(ref);
    throw error;
  }
}

async function closeSession(target) {
  const session = sessionRef(target);
  const tabs = [...session.tabs.values()];
  const results = await Promise.allSettled(tabs.map((tab) => runOpenCli(
    ['browser', tab.opencliSession, tab.kind === 'bound' ? 'unbind' : 'close'],
    { uncertainOnFailure: true },
  )));
  for (const [index, result] of results.entries()) {
    if (result.status === 'fulfilled') session.tabs.delete(tabs[index].page);
  }
  const failure = results.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') {
    const error = failure.reason;
    throw new OpenCliError(
      `failed to release all logical browser tabs: ${errorText(error)}`,
      error?.uncertain === true,
    );
  }
  if (session.logicalLabel) sessions.delete(session.logicalLabel);
  sessions.delete(session.ref);
  return { closed: true, releasedTabs: tabs.length, outcome: 'confirmed' };
}

async function readUrl(target, payload) {
  const requestedUrl = url(target, 'target');
  const temporarySession = {
    ref: `browser:${randomUUID()}`,
    opencliSession: `mimi-read-${randomUUID().slice(0, 8)}`,
    kind: 'owned',
  };
  await runOpenCli([
    'browser',
    temporarySession.opencliSession,
    'open',
    requestedUrl,
    '--window',
    'background',
  ], { uncertainOnFailure: true });
  try {
    const result = await executeReadAction('extract', temporarySession, payload);
    return {
      requestedUrl,
      ...result,
      sessionReleased: true,
    };
  } finally {
    await runOpenCli(
      browserArgs(temporarySession, ['close']),
      { uncertainOnFailure: true },
    );
  }
}

async function executeReadAction(action, session, payload) {
  if (action === 'list_tabs' && session.tabs instanceof Map) {
    return listLogicalTabs(session);
  }
  let command;
  if (action === 'list_tabs') command = ['tab', 'list'];
  else if (action === 'snapshot') {
    if (payload.source !== undefined && payload.source !== 'dom' && payload.source !== 'ax') {
      throw new Error('payload.source must be dom or ax');
    }
    const source = payload.source === 'ax' ? 'ax' : 'dom';
    command = ['state', '--source', source, ...pageOption(payload)];
  } else if (action === 'find') {
    const css = optionalString(payload.css, 'payload.css', 2_000);
    const locator = locatorOptions(payload);
    if (!css && locator.length === 0) throw new Error('payload.css or a semantic locator is required');
    if (css && locator.length > 0) throw new Error('use payload.css or a semantic locator, not both');
    command = [
      'find',
      ...(css ? ['--css', css] : locator),
      '--limit',
      String(integer(payload.limit, 'payload.limit', 1, 200, 50)),
      '--text-max',
      String(integer(payload.textMax, 'payload.textMax', 1, 2_000, 120)),
      ...pageOption(payload),
    ];
  } else if (action === 'read_page') {
    if (payload.format !== undefined && payload.format !== 'html' && payload.format !== 'json') {
      throw new Error('payload.format must be html or json');
    }
    const format = payload.format === 'html' ? 'html' : 'json';
    command = [
      'get',
      'html',
      '--as',
      format,
      '--max',
      String(integer(payload.maxChars, 'payload.maxChars', 1, 200_000, 40_000)),
      ...(payload.selector === undefined
        ? []
        : ['--selector', boundedString(payload.selector, 'payload.selector', 2_000, true)]),
      ...(format === 'json'
        ? [
            '--depth',
            String(integer(payload.depth, 'payload.depth', 0, 20, 8)),
            '--children-max',
            String(integer(payload.childrenMax, 'payload.childrenMax', 1, 500, 100)),
            '--text-max',
            String(integer(payload.textMax, 'payload.textMax', 1, 20_000, 2_000)),
          ]
        : []),
      ...pageOption(payload),
    ];
  } else if (action === 'read_element') {
    if (payload.field !== undefined && payload.field !== 'text' && payload.field !== 'attributes') {
      throw new Error('payload.field must be text or attributes');
    }
    const field = payload.field === 'attributes' ? 'attributes' : 'text';
    const resolved = targetAndLocator(payload);
    command = [
      'get',
      field,
      ...(resolved.target ? [resolved.target] : []),
      ...resolved.options,
      ...pageOption(payload),
    ];
  } else if (action === 'extract') {
    command = [
      'extract',
      '--chunk-size',
      String(integer(payload.chunkSize, 'payload.chunkSize', 1_000, 32_000, 20_000)),
      '--start',
      String(integer(payload.start, 'payload.start', 0, 10_000_000, 0)),
      ...(payload.selector === undefined
        ? []
        : ['--selector', boundedString(payload.selector, 'payload.selector', 2_000, true)]),
      ...pageOption(payload),
    ];
  } else if (action === 'frames') command = ['frames', ...pageOption(payload)];
  else if (action === 'network') command = ['network', ...pageOption(payload)];
  else if (action === 'wait') {
    const kind = payload.kind;
    if (!['selector', 'text', 'xhr', 'download'].includes(kind)) {
      throw new Error('payload.kind must be selector, text, xhr, or download');
    }
    command = [
      'wait',
      kind,
      kind === 'download'
        ? boundedString(String(payload.value ?? ''), 'payload.value', 2_000)
        : boundedString(payload.value, 'payload.value', 2_000, true),
      '--timeout',
      String(integer(payload.timeoutMs, 'payload.timeoutMs', 100, 120_000, 10_000)),
      ...pageOption(payload),
    ];
  } else throw new Error(`unsupported read action: ${action}`);

  const result = await runOpenCli(browserArgs(session, command, payload));
  const safeResult = action === 'network'
    ? redactNetworkValue(result)
    : action === 'snapshot' ? normalizeSnapshotResult(result) : result;
  const normalized = Array.isArray(safeResult)
    ? {
        [action === 'list_tabs'
          ? 'tabs'
          : action === 'frames' ? 'frames' : 'entries']: safeResult,
      }
    : safeResult && typeof safeResult === 'object'
      ? safeResult
      : { value: safeResult };
  const observationId = OBSERVATION_ACTIONS.has(action)
    ? randomUUID()
    : undefined;
  return {
    ...normalized,
    ...(observationId ? { observationId } : {}),
    untrusted: true,
  };
}

async function executeDomInteraction(action, session, payload) {
  targetAndLocator(payload);
  const locator = {
    target: payload.element ?? payload.ref ?? payload.locator ?? payload.selector,
    role: payload.role,
    name: payload.name,
    label: payload.label,
    text: payload.text,
    testid: payload.testid,
    nth: payload.nth,
  };
  const script = `(() => {
    const __mimiOperation = ${JSON.stringify(action)};
    const __mimiLocator = ${JSON.stringify(locator)};
    const normalized = (value) => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    const implicitRole = (element) => {
      const explicit = element.getAttribute('role');
      if (explicit) return explicit.toLowerCase();
      const tag = element.tagName.toLowerCase();
      const type = String(element.getAttribute('type') || '').toLowerCase();
      if (tag === 'button' || (tag === 'input' && ['button', 'submit', 'reset', 'image'].includes(type))) return 'button';
      if ((tag === 'a' || tag === 'area') && element.hasAttribute('href')) return 'link';
      if (tag === 'textarea' || (tag === 'input' && !['button', 'submit', 'reset', 'image', 'checkbox', 'radio', 'range', 'number', 'hidden', 'file'].includes(type))) return 'textbox';
      if (tag === 'select' || (tag === 'input' && element.hasAttribute('list'))) return 'combobox';
      if (tag === 'input' && type === 'checkbox') return 'checkbox';
      if (tag === 'input' && type === 'radio') return 'radio';
      if (tag === 'input' && type === 'range') return 'slider';
      if (tag === 'input' && type === 'number') return 'spinbutton';
      if (tag === 'option') return 'option';
      if (/^h[1-6]$/.test(tag)) return 'heading';
      if (tag === 'img') return 'img';
      return '';
    };
    const labelText = (element) => normalized([
      ...(element.labels ? Array.from(element.labels).map((label) => label.textContent || '') : []),
      element.getAttribute('aria-label') || '',
    ].join(' '));
    const accessibleName = (element) => {
      const labelledBy = String(element.getAttribute('aria-labelledby') || '')
        .split(/\\s+/)
        .filter(Boolean)
        .map((id) => document.getElementById(id)?.textContent || '')
        .join(' ');
      return normalized([
        element.getAttribute('aria-label') || '',
        labelledBy,
        labelText(element),
        element.getAttribute('alt') || '',
        element.getAttribute('title') || '',
        element.getAttribute('placeholder') || '',
        element.textContent || '',
        'value' in element ? element.value || '' : '',
      ].join(' '));
    };
    let matches;
    try {
      if (__mimiLocator.target !== undefined && __mimiLocator.target !== null) {
        const target = String(__mimiLocator.target);
        matches = Array.from(document.querySelectorAll(/^\\d+$/.test(target)
          ? '[data-opencli-ref="' + target + '"]'
          : target));
      } else {
        const candidates = Array.from(document.querySelectorAll('*'));
        if (candidates.length > 50000) return { verified: false, code: 'dom_too_large', matches_n: candidates.length };
        matches = candidates.filter((element) => {
          if (__mimiLocator.role && implicitRole(element) !== normalized(__mimiLocator.role)) return false;
          if (__mimiLocator.name && !accessibleName(element).includes(normalized(__mimiLocator.name))) return false;
          if (__mimiLocator.label && !labelText(element).includes(normalized(__mimiLocator.label))) return false;
          if (__mimiLocator.text && !normalized(element.textContent).includes(normalized(__mimiLocator.text))) return false;
          if (__mimiLocator.testid) {
            const testId = element.getAttribute('data-testid') || element.getAttribute('data-test') || element.getAttribute('test-id') || '';
            if (!normalized(testId).includes(normalized(__mimiLocator.testid))) return false;
          }
          return true;
        });
      }
    } catch (error) {
      return { verified: false, code: 'invalid_selector', message: String(error).slice(0, 300) };
    }
    const selectedIndex = Number.isInteger(__mimiLocator.nth)
      ? __mimiLocator.nth
      : matches.length === 1 ? 0 : -1;
    const element = selectedIndex >= 0 ? matches[selectedIndex] : undefined;
    if (!element) return {
      verified: false,
      code: matches.length ? 'ambiguous_target' : 'not_found',
      matches_n: matches.length,
    };
    try {
      if (__mimiOperation === 'click') {
        const beforeUrl = location.href;
        const expectedUrl = element.matches('a[href],area[href]') ? element.href : undefined;
        const newTabExpected = expectedUrl !== undefined
          && String(element.getAttribute('target') || '').toLowerCase() === '_blank';
        if (newTabExpected) {
          const event = new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            composed: true,
            view: window,
          });
          event.preventDefault();
          element.dispatchEvent(event);
        } else {
          element.click();
        }
        return {
          verified: true,
          clicked: true,
          matches_n: matches.length,
          dispatch: newTabExpected ? 'dom_deferred_new_tab' : 'dom',
          ...(expectedUrl ? { navigationExpected: true, beforeUrl, expectedUrl, newTabExpected } : {}),
        };
      }
      const desired = __mimiOperation === 'check';
      const state = () => {
        if ('checked' in element && typeof element.checked === 'boolean') return element.checked;
        const aria = element.getAttribute('aria-checked');
        return aria === 'true' ? true : aria === 'false' ? false : undefined;
      };
      const before = state();
      if (before === undefined) return { verified: false, code: 'not_checkable', matches_n: matches.length };
      if (before !== desired) element.click();
      const checked = state();
      return {
        verified: checked === desired,
        checked,
        changed: before !== checked,
        matches_n: matches.length,
        dispatch: 'dom',
      };
    } catch (error) {
      return { verified: false, code: 'dispatch_failed', message: String(error).slice(0, 300), matches_n: matches.length };
    }
  })()`;
  let result = await runOpenCli(
    browserArgs(session, ['eval', script, ...pageOption(payload)], payload),
    { uncertainOnFailure: true },
  );
  if (action === 'click' && result?.navigationExpected === true) {
    if (result.newTabExpected === true) {
      const tab = await createLogicalTab(session, { url: result.expectedUrl });
      result = {
        ...result,
        ...tab,
        navigationSettled: true,
      };
    } else {
      result = {
        ...result,
        ...await settleNavigation(session, payload, result.beforeUrl, result.expectedUrl),
      };
    }
  }
  const succeeded = action === 'click'
    ? result?.clicked === true && result?.verified === true
    : result?.verified === true && typeof result?.checked === 'boolean';
  if (succeeded) return result;
  const code = typeof result?.code === 'string' ? result.code : 'dom_interaction_failed';
  const failedSafe = ['not_found', 'ambiguous_target', 'invalid_selector', 'not_checkable', 'dom_too_large'].includes(code);
  throw new OpenCliError(
    `${code}: structured DOM ${action} did not complete (${JSON.stringify(result)})`,
    !failedSafe,
  );
}

async function createLogicalTab(session, payload) {
  if (session.tabs.size >= MAX_LOGICAL_TABS) {
    throw new Error(`browser session supports at most ${MAX_LOGICAL_TABS} logical tabs`);
  }
  const opencliSession = `mimi-tab-${randomUUID().slice(0, 12)}`;
  const requestedUrl = payload.url === undefined ? 'about:blank' : url(payload.url);
  try {
    const result = await runOpenCli([
      'browser', opencliSession, 'open', requestedUrl, '--window', 'background',
    ], { uncertainOnFailure: true });
    const tab = registerLogicalTab(session, opencliSession, 'owned', result);
    return publicTabResult(result, tab, { tabCount: session.tabs.size });
  } catch (error) {
    if (error?.uncertain === true) registerLogicalTab(session, opencliSession, 'owned', undefined);
    throw error;
  }
}

function selectLogicalTab(session, payload) {
  const page = boundedString(payload.page, 'payload.page', 500, true);
  const tab = session.tabs.get(page);
  if (!tab) throw new Error('browser page is missing or expired; call list_tabs and use a current page ID');
  session.activePage = page;
  return {
    selected: true,
    page,
    ...(tab.url ? { url: tab.url } : {}),
    activePage: page,
    tabCount: session.tabs.size,
  };
}

async function closeLogicalTab(session, payload) {
  const tab = logicalTab(session, payload);
  const result = await runOpenCli(
    ['browser', tab.opencliSession, tab.kind === 'bound' ? 'unbind' : 'close'],
    { uncertainOnFailure: true },
  );
  session.tabs.delete(tab.page);
  if (session.activePage === tab.page) {
    session.activePage = [...session.tabs.keys()].at(-1);
  }
  const active = session.activePage ? session.tabs.get(session.activePage) : undefined;
  return {
    ...(result && typeof result === 'object' && !Array.isArray(result) ? result : {}),
    closed: true,
    closedPage: tab.page,
    activePage: session.activePage,
    ...(active?.url ? { activeUrl: active.url } : {}),
    tabCount: session.tabs.size,
  };
}

async function executeWriteAction(action, session, payload) {
  let command;
  let result;
  if (action === 'new_tab') {
    result = await createLogicalTab(session, payload);
  } else if (action === 'select_tab') {
    result = selectLogicalTab(session, payload);
  } else if (action === 'close_tab') {
    result = await closeLogicalTab(session, payload);
  } else if (action === 'navigate') {
    command = ['open', url(payload.url), ...pageOption(payload)];
  } else if (action === 'back') command = ['back', ...pageOption(payload)];
  else if (action === 'click' || action === 'check' || action === 'uncheck') {
    result = await executeDomInteraction(action, session, payload);
  } else if (['hover', 'focus', 'double_click'].includes(action)) {
    const resolved = targetAndLocator(payload);
    const opencliAction = action === 'double_click' ? 'dblclick' : action;
    command = [
      opencliAction,
      ...(resolved.target ? [resolved.target] : []),
      ...resolved.options,
      ...pageOption(payload),
    ];
  } else if (action === 'type' || action === 'fill' || action === 'select') {
    const resolved = targetAndLocator(payload);
    const value = boundedString(payload.value, 'payload.value', 20_000, true);
    command = [
      action,
      ...(resolved.target ? [resolved.target, value] : [value]),
      ...resolved.options,
      ...pageOption(payload),
    ];
  } else if (action === 'keys') {
    command = [
      'keys',
      boundedString(payload.key, 'payload.key', 100, true),
      ...pageOption(payload),
    ];
  } else if (action === 'scroll') {
    if (payload.direction !== 'up' && payload.direction !== 'down') {
      throw new Error('payload.direction must be up or down');
    }
    command = [
      'scroll',
      payload.direction,
      '--amount',
      String(integer(payload.amount, 'payload.amount', 1, 100_000, 500)),
      ...pageOption(payload),
    ];
  } else if (action === 'upload') {
    const resolved = targetAndLocator(payload);
    if (!Array.isArray(payload.files) || payload.files.length < 1 || payload.files.length > 20) {
      throw new Error('payload.files must contain between 1 and 20 absolute file paths');
    }
    const files = payload.files.map((file, index) => {
      const value = boundedString(file, `payload.files[${index}]`, 4_000, true);
      if (!path.isAbsolute(value)) throw new Error(`payload.files[${index}] must be absolute`);
      return value;
    });
    await Promise.all(files.map((file) => access(file)));
    command = [
      'upload',
      ...(resolved.target ? [resolved.target, ...files] : files),
      ...resolved.options,
      ...pageOption(payload),
    ];
  } else if (action === 'drag') {
    const source = targetAndLocator(payload, 'source', 'from');
    const destination = targetAndLocator(payload, 'destination', 'to');
    if (Boolean(source.target) !== Boolean(destination.target)) {
      throw new Error('drag source and destination must both use explicit targets or both use semantic locators');
    }
    command = [
      'drag',
      ...(source.target ? [source.target] : []),
      ...(destination.target ? [destination.target] : []),
      ...source.options,
      ...destination.options,
      ...pageOption(payload),
    ];
  } else if (action === 'dialog') {
    if (payload.decision !== 'accept' && payload.decision !== 'dismiss') {
      throw new Error('payload.decision must be accept or dismiss');
    }
    command = [
      'dialog',
      payload.decision,
      ...(payload.value === undefined
        ? []
        : ['--text', boundedString(payload.value, 'payload.value', 20_000)]),
      ...pageOption(payload),
    ];
  } else if (action === 'execute_javascript') {
    const script = payload.script ?? payload.code;
    if (payload.script !== undefined && payload.code !== undefined) {
      throw new Error('use payload.script or payload.code, not both');
    }
    command = [
      'eval',
      boundedString(script, 'payload.script or payload.code', 100_000, true),
      ...pageOption(payload),
    ];
  } else throw new Error(`unsupported write action: ${action}`);

  if (result === undefined) {
    result = await runOpenCli(
      browserArgs(session, command, payload),
      { uncertainOnFailure: true },
    );
  }
  const currentTab = session.tabs.size > 0
    ? logicalTab(session, action === 'close_tab' ? {} : payload)
    : undefined;
  const currentUrl = pageUrlFromResult(result);
  if (currentTab && currentUrl) currentTab.url = currentUrl;
  const safeResult = sanitizeWriteResult(action, result, payload);
  const interactionVerified = safeResult?.verified === true
    || safeResult?.filled === true
    || safeResult?.selected !== undefined
    || safeResult?.clicked === true;
  return {
    ...safeResult,
    ...(interactionVerified ? { verified: true } : {}),
    outcome: 'confirmed',
    completionScope: 'interaction',
    businessOutcome: 'unverified',
    verificationPlan: {
      timing: 'after_action_group',
      method: 'browser_assert_or_precise_observe',
      listTabsOnlyIfNewTabExpected: true,
    },
    untrusted: true,
  };
}

async function execute(message) {
  if (!message || typeof message !== 'object') throw new Error('message must be an object');
  if (typeof message.id !== 'string' || !message.id) throw new Error('message.id is required');
  if (!ACTIONS.has(message.action)) throw new Error(`unsupported action: ${message.action}`);
  const payload = payloadObject(message.payload);
  if (message.action === 'doctor') {
    const status = await inspectOpenCliStatus();
    return {
      type: 'action_result',
      id: message.id,
      ok: true,
      result: { ...status, ready: true, probe: 'daemon_status' },
    };
  }
  if (message.action === 'read_url') {
    const result = await readUrl(message.target, payload);
    return { type: 'action_result', id: message.id, ok: true, result };
  }
  if (message.action === 'open_session') {
    const result = await createSession('owned', message.target, payload);
    return { type: 'action_result', id: message.id, ok: true, result };
  }
  if (message.action === 'bind_session') {
    const result = await createSession('bound', message.target, payload);
    return { type: 'action_result', id: message.id, ok: true, result };
  }
  if (message.action === 'close_session') {
    const result = await closeSession(message.target);
    return { type: 'action_result', id: message.id, ok: true, result };
  }
  if (message.action === 'probe_tabs') {
    const uniqueSessions = [...new Map(
      [...sessions.values()].map((session) => [session.ref, session]),
    ).values()];
    return {
      type: 'action_result',
      id: message.id,
      ok: true,
      result: {
        sessions: uniqueSessions.length,
        total: uniqueSessions.reduce((sum, session) => sum + session.tabs.size, 0),
        truncated: false,
      },
    };
  }
  const session = sessionRef(message.target);
  const result = WRITE_ACTIONS.has(message.action)
    ? await executeWriteAction(message.action, session, payload)
    : await executeReadAction(message.action, session, payload);
  return { type: 'action_result', id: message.id, ok: true, result };
}

let actionLane = Promise.resolve();
process.stdin.setEncoding('utf8');
let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (Buffer.byteLength(input) > 1_000_000) {
    process.stderr.write('[browser] input exceeded 1MB; resetting buffer\n');
    input = '';
    return;
  }
  while (input.includes('\n')) {
    const newline = input.indexOf('\n');
    const line = input.slice(0, newline).trim();
    input = input.slice(newline + 1);
    if (!line) continue;
    actionLane = actionLane.then(async () => {
      let message;
      try {
        message = JSON.parse(line);
        write(await execute(message));
      } catch (error) {
        write({
          type: 'action_result',
          id: message?.id ?? 'invalid',
          ok: false,
          ...(error?.uncertain === true ? { uncertain: true } : {}),
          error: errorText(error),
        });
      }
    });
  }
});

async function reportReadiness() {
  try {
    await inspectOpenCliStatus();
    write({
      type: 'status',
      inbound: 'unavailable',
      outbound: 'ready',
      deliveryConfirmed: false,
      coverage: 'bounded',
      backgroundSafe: true,
    });
  } catch (error) {
    process.stderr.write(`[browser] OpenCLI status check failed: ${errorText(error)}\n`);
    write({
      type: 'status',
      inbound: 'unavailable',
      outbound: 'unavailable',
      deliveryConfirmed: false,
      coverage: 'unavailable',
      backgroundSafe: true,
      reasonCode: 'opencli_unavailable',
    });
  }
}

void reportReadiness();

async function shutdown() {
  const active = [...new Map(
    [...sessions.values()].map((session) => [session.ref, session]),
  ).values()];
  sessions.clear();
  await Promise.allSettled(active.flatMap((session) => [...session.tabs.values()].map((tab) =>
    runOpenCli(
      ['browser', tab.opencliSession, tab.kind === 'bound' ? 'unbind' : 'close'],
      { timeoutMs: 5_000 },
    ))));
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { void shutdown(); });
}
