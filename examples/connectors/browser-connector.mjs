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
  const page = optionalString(payload.page, 'payload.page', 500);
  return page ? ['--tab', page] : [];
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
  const targetCandidates = [explicitTarget, ref, locatorTarget].filter(
    (candidate) => candidate !== undefined,
  );
  if (targetCandidates.length > 1) {
    throw new Error('use only one of payload.ref, payload.locator, or payload.element');
  }
  const target = targetCandidates[0];
  const locator = locatorOptions(payload, prefix);
  if (!target && locator.length === 0) {
    throw new Error(
      targetKey === 'element'
        ? 'payload.ref, payload.locator, payload.element, or a semantic locator is required'
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

function browserArgs(session, command) {
  return ['browser', session.opencliSession, ...command];
}

function newObservation(session, source) {
  const observationId = randomUUID();
  session.observationId = observationId;
  session.observationSource = source;
  return observationId;
}

function requireObservation(session, payload, requiredSource) {
  const observationId = boundedString(
    payload.observationId,
    'payload.observationId',
    100,
    true,
  );
  if (!session.observationId || observationId !== session.observationId) {
    throw new Error('observationId is stale; call snapshot, find, or list_tabs again');
  }
  if (requiredSource && session.observationSource !== requiredSource) {
    throw new Error(
      `${requiredSource} observation is required before this action; call ${requiredSource} first`,
    );
  }
  session.observationId = undefined;
  session.observationSource = undefined;
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

async function createSession(kind, target, payload) {
  const logicalLabel = label(target);
  const ref = `browser:${randomUUID()}`;
  const opencliSession = `mimi-${logicalLabel}-${randomUUID().slice(0, 8)}`;
  const session = {
    ref,
    opencliSession,
    kind,
    observationId: undefined,
    observationSource: undefined,
  };
  sessions.set(ref, session);
  if (kind === 'owned') {
    if (payload.window !== undefined
      && payload.window !== 'background'
      && payload.window !== 'foreground') {
      sessions.delete(ref);
      throw new Error('payload.window must be background or foreground');
    }
    try {
      const result = await runOpenCli([
        'browser',
        opencliSession,
        'open',
        url(payload.url),
        '--window',
        payload.window === 'foreground' ? 'foreground' : 'background',
      ], { uncertainOnFailure: true });
      return {
        sessionRef: ref,
        kind,
        ...result,
        outcome: 'confirmed',
        untrusted: true,
      };
    } catch (error) {
      if (error?.uncertain === true) {
        return {
          sessionRef: ref,
          kind,
          outcome: 'accepted',
          reason: errorText(error),
          untrusted: true,
        };
      }
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
    return {
      sessionRef: ref,
      kind,
      ...result,
      outcome: 'confirmed',
      untrusted: true,
    };
  } catch (error) {
    if (error?.uncertain === true) {
      return {
        sessionRef: ref,
        kind,
        outcome: 'accepted',
        reason: errorText(error),
        untrusted: true,
      };
    }
    sessions.delete(ref);
    throw error;
  }
}

async function closeSession(target) {
  const session = sessionRef(target);
  const command = session.kind === 'bound' ? 'unbind' : 'close';
  const result = await runOpenCli(
    browserArgs(session, [command]),
    { uncertainOnFailure: true },
  );
  sessions.delete(session.ref);
  return { ...result, closed: true, outcome: 'confirmed' };
}

async function readUrl(target, payload) {
  const requestedUrl = url(target, 'target');
  const temporarySession = {
    ref: `browser:${randomUUID()}`,
    opencliSession: `mimi-read-${randomUUID().slice(0, 8)}`,
    kind: 'owned',
    observationId: undefined,
    observationSource: undefined,
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

  const result = await runOpenCli(browserArgs(session, command));
  const safeResult = action === 'network' ? redactNetworkValue(result) : result;
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
    ? newObservation(session, action)
    : session.observationId;
  return {
    ...normalized,
    ...(observationId ? { observationId } : {}),
    untrusted: true,
  };
}

async function executeWriteAction(action, session, payload) {
  let command;
  if (action === 'new_tab') {
    command = ['tab', 'new', ...(payload.url === undefined ? [] : [url(payload.url)])];
  } else if (action === 'select_tab' || action === 'close_tab') {
    command = [
      'tab',
      action === 'select_tab' ? 'select' : 'close',
      boundedString(payload.page, 'payload.page', 500, true),
    ];
  } else if (action === 'navigate') {
    command = ['open', url(payload.url), ...pageOption(payload)];
  } else if (action === 'back') command = ['back', ...pageOption(payload)];
  else if (['click', 'hover', 'focus', 'double_click', 'check', 'uncheck'].includes(action)) {
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

  // Consume the observation only after every payload field has been validated.
  // A rejected command never reaches Chrome and must remain safely correctable
  // with the same snapshot.
  requireObservation(session, payload, action === 'execute_javascript' ? 'snapshot' : undefined);
  const result = await runOpenCli(
    browserArgs(session, command),
    { uncertainOnFailure: true },
  );
  return {
    ...sanitizeWriteResult(action, result, payload),
    outcome: 'confirmed',
    completionScope: 'interaction',
    businessOutcome: 'unverified',
    observationInvalidated: true,
    nextRead: action === 'click' || action === 'double_click'
      ? {
          action: 'list_tabs',
          reason: '点击可能打开或选择新标签页；先重新列出 page，再读取目标 page',
        }
      : {
          action: 'snapshot',
          reason: '写动作后重新观察页面，不能复用旧 observationId 或元素 ref',
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
    const result = await runOpenCli(['doctor'], { timeoutMs: Math.min(commandTimeoutMs, 15_000) });
    return { type: 'action_result', id: message.id, ok: true, result: { ...result, ready: true } };
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
    const counts = await Promise.all([...sessions.values()].map(async (session) => {
      const result = await runOpenCli(browserArgs(session, ['tab', 'list']));
      return Array.isArray(result) ? result.length : 0;
    }));
    return {
      type: 'action_result',
      id: message.id,
      ok: true,
      result: {
        sessions: counts.length,
        total: counts.reduce((sum, count) => sum + count, 0),
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
    await runOpenCli(['doctor'], { timeoutMs: Math.min(commandTimeoutMs, 15_000) });
    write({
      type: 'status',
      inbound: 'unavailable',
      outbound: 'ready',
      deliveryConfirmed: false,
      coverage: 'bounded',
      backgroundSafe: true,
    });
  } catch (error) {
    process.stderr.write(`[browser] OpenCLI doctor failed: ${errorText(error)}\n`);
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
  const active = [...sessions.values()];
  sessions.clear();
  await Promise.allSettled(active.map((session) => runOpenCli(
    browserArgs(session, [session.kind === 'bound' ? 'unbind' : 'close']),
    { timeoutMs: 5_000 },
  )));
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { void shutdown(); });
}
