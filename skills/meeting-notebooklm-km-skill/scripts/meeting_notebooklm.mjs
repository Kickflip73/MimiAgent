#!/usr/bin/env node

import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";

const DEFAULT_PACKAGE = "notebooklm@0.1.1";
const DEFAULT_AUTH = join(homedir(), ".notebooklm", "storage-state.json");
const NOTEBOOKLM_URL = "https://notebooklm.google.com/";
const TEXT_EXTENSIONS = new Set([".md", ".txt", ".markdown", ".csv", ".json"]);

export class WorkflowError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
    this.details = details;
  }
}

function usage() {
  return `Usage:
  meeting_notebooklm.mjs setup [--auth FILE] [--proxy URL] [--skip-browser-install]
  meeting_notebooklm.mjs doctor [--auth FILE] [--proxy URL] [--skip-provider-check]
  meeting_notebooklm.mjs run --title TITLE --source FILE [--source FILE ...]
      [--prompt TEXT | --prompt-file FILE] --output FILE --receipt FILE
      [--auth FILE] [--proxy URL] [--auto-setup] [--cleanup] [--dry-run]

Environment:
  NOTEBOOKLM_STORAGE_STATE  Playwright storage-state JSON
  NOTEBOOKLM_PROXY          off or an explicit HTTP(S) proxy URL
  NOTEBOOKLM_PACKAGE        pinned npm package (default notebooklm@0.1.1)
  NOTEBOOKLM_PROVIDER       real (default) or fake (tests only)
  NOTEBOOKLM_FAKE_RESPONSE fake-provider response file
`;
}

export function parseArgs(argv) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    return { command: "help" };
  }
  const [command, ...rest] = argv;
  if (!new Set(["setup", "doctor", "run"]).has(command)) {
    throw new WorkflowError("usage", `Unknown command: ${command}`);
  }
  const options = { command, sources: [], cleanup: false, dryRun: false };
  for (let i = 0; i < rest.length; i += 1) {
    const key = rest[i];
    if (key === "--auto-setup") {
      options.autoSetup = true;
      continue;
    }
    if (key === "--skip-browser-install") {
      options.skipBrowserInstall = true;
      continue;
    }
    if (key === "--cleanup") {
      options.cleanup = true;
      continue;
    }
    if (key === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (key === "--skip-provider-check") {
      options.skipProviderCheck = true;
      continue;
    }
    if (!key.startsWith("--")) {
      throw new WorkflowError("usage", `Unexpected argument: ${key}`);
    }
    const value = rest[i + 1];
    if (!value || value.startsWith("--")) {
      throw new WorkflowError("usage", `Missing value for ${key}`);
    }
    i += 1;
    const name = key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (name === "source") options.sources.push(value);
    else options[name] = value;
  }
  return options;
}

async function pathExists(path) {
  try {
    await access(path, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveProxy(spec = process.env.NOTEBOOKLM_PROXY) {
  if (!spec || spec === "off" || spec === "none") return null;
  let url;
  try {
    url = new URL(spec);
  } catch {
    throw new WorkflowError("proxy_config_invalid", `Invalid proxy URL: ${spec}`);
  }
  if (!new Set(["http:", "https:"]).has(url.protocol) || !url.hostname || !url.port) {
    throw new WorkflowError(
      "proxy_config_invalid",
      "Proxy must be an explicit http(s) URL with a port",
    );
  }
  return url.toString().replace(/\/$/, "");
}

export async function assertProxyReachable(proxy, timeoutMs = 2500) {
  if (!proxy) return;
  const url = new URL(proxy);
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  await new Promise((resolvePromise, rejectPromise) => {
    const socket = createConnection({ host: url.hostname, port });
    const timer = setTimeout(() => {
      socket.destroy();
      rejectPromise(
        new WorkflowError("proxy_unreachable", `Proxy did not respond: ${url.hostname}:${port}`),
      );
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolvePromise();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      rejectPromise(
        new WorkflowError("proxy_unreachable", `Cannot connect to proxy ${url.hostname}:${port}`, {
          cause: String(error),
        }),
      );
    });
  });
}

function cookieDomain(cookie) {
  return String(cookie?.domain || "").replace(/^\./, "").toLowerCase();
}

export async function validateAuthState(authPath) {
  let state;
  try {
    state = JSON.parse(await readFile(authPath, "utf8"));
  } catch (error) {
    throw new WorkflowError("auth_missing", `NotebookLM auth state is unavailable: ${authPath}`, {
      cause: String(error),
    });
  }
  if (!Array.isArray(state.cookies)) {
    throw new WorkflowError("auth_invalid", "Auth state does not contain a cookies array");
  }
  const now = Date.now() / 1000;
  const relevant = state.cookies.filter((cookie) => {
    const domain = cookieDomain(cookie);
    return domain.endsWith("google.com") || domain.endsWith("notebooklm.google.com");
  });
  const live = relevant.filter((cookie) => !cookie.expires || cookie.expires < 0 || cookie.expires > now);
  if (live.length === 0) {
    throw new WorkflowError("auth_expired", "Auth state has no live Google/NotebookLM cookies");
  }
  return { cookieCount: live.length };
}

function applyProxyEnvironment(proxy) {
  process.env.NODE_USE_ENV_PROXY = "1";
  if (proxy) {
    process.env.HTTP_PROXY = proxy;
    process.env.HTTPS_PROXY = proxy;
    process.env.ALL_PROXY = proxy;
  }
}

function providerEnvironment(proxy) {
  const env = { ...process.env, NODE_USE_ENV_PROXY: "1" };
  if (proxy) {
    env.HTTP_PROXY = proxy;
    env.HTTPS_PROXY = proxy;
    env.ALL_PROXY = proxy;
  }
  return env;
}

async function checkNetwork(proxy) {
  if (process.env.NOTEBOOKLM_SKIP_NETWORK === "1") {
    return { status: null, effectiveUrl: NOTEBOOKLM_URL, skipped: true };
  }
  const env = providerEnvironment(proxy);
  const result = await runProcess("curl", ["-sS", "-L", "--max-time", "20", "-o", "/dev/null", "-w", "%{http_code} %{url_effective}", NOTEBOOKLM_URL], { env });
  const [statusText, ...urlParts] = result.stdout.trim().split(/\s+/);
  const status = Number(statusText);
  const effectiveUrl = urlParts.join(" ");
  if (!status || status >= 500) {
    throw new WorkflowError("network_unreachable", `NotebookLM reachability failed: HTTP ${statusText || "unknown"}`);
  }
  if (effectiveUrl.includes("location=unsupported")) {
    throw new WorkflowError("region_unsupported", `NotebookLM rejected the current egress region: ${effectiveUrl}`);
  }
  return { status, effectiveUrl };
}

function runInteractive(command, args, { env = process.env } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { env, stdio: "inherit" });
    child.once("error", (error) => rejectPromise(error));
    child.once("close", (code) => {
      if (code === 0) resolvePromise({ code });
      else rejectPromise(new WorkflowError("process_failed", `${command} exited with ${code}`, { command, code }));
    });
  });
}

function runProcess(command, args, { env = process.env, input = null } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", (error) => rejectPromise(error));
    child.once("close", (code) => {
      if (code === 0) resolvePromise({ stdout, stderr, code });
      else {
        rejectPromise(
          new WorkflowError("process_failed", `${command} exited with ${code}`, {
            command,
            code,
            stdout: stdout.slice(-4000),
            stderr: stderr.slice(-4000),
          }),
        );
      }
    });
    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

async function ensureProviderPackage() {
  const packageSpec = process.env.NOTEBOOKLM_PACKAGE || DEFAULT_PACKAGE;
  const cacheDir = join(homedir(), ".cache", "meeting-notebooklm-km", "provider");
  await mkdir(cacheDir, { recursive: true });
  const packageJson = join(cacheDir, "package.json");
  if (!(await pathExists(packageJson))) {
    await writeFile(packageJson, '{"private":true,"type":"module"}\n', "utf8");
  }
  await runProcess(
    "npm",
    ["install", "--no-audit", "--no-fund", "--silent", "--prefix", cacheDir, packageSpec],
    { env: process.env },
  );
  return { cacheDir, packageSpec };
}

async function importProvider(authPath) {
  if (process.env.NOTEBOOKLM_PROVIDER === "fake") {
    return createFakeProvider();
  }
  const packageSpec = process.env.NOTEBOOKLM_PACKAGE || DEFAULT_PACKAGE;
  const importScript = `import(${JSON.stringify(packageSpec.split("@")[0] || "notebooklm")}).then(()=>{});`;
  try {
    const module = await import("notebooklm");
    return createRealProvider(module, authPath);
  } catch {
    const { cacheDir } = await ensureProviderPackage();
    const modulePath = pathToFileURL(join(cacheDir, "node_modules", "notebooklm", "dist", "index.js")).href;
    const module = await import(modulePath);
    void importScript;
    return createRealProvider(module, authPath);
  }
}

export function createRealProvider(module, authPath) {
  let client;
  return {
    async connect() {
      client = await module.NotebookLMClient.fromStorage(authPath);
      await client.notebooks.list();
    },
    async createNotebook(title) {
      return client.notebooks.create(title);
    },
    async addSource(notebookId, source) {
      if (TEXT_EXTENSIONS.has(extname(source.path).toLowerCase())) {
        const content = await readFile(source.path, "utf8");
        return client.sources.addText(notebookId, source.title, content);
      }
      const content = await readFile(source.path);
      return client.sources.addFile(notebookId, source.title, content, source.mimeType);
    },
    async waitForSources(notebookId, sourceIds, options = {}) {
      return client.sources.waitForSources(notebookId, sourceIds, options);
    },
    async ask(notebookId, question, sourceIds) {
      return client.chat.ask(notebookId, question, { sourceIds });
    },
    async deleteNotebook(notebookId) {
      return client.notebooks.delete(notebookId);
    },
  };
}

function createFakeProvider() {
  const responsePath = process.env.NOTEBOOKLM_FAKE_RESPONSE;
  return {
    async connect() {},
    async createNotebook(title) {
      return { id: "fake-notebook-id", title };
    },
    async addSource(_notebookId, source) {
      return { id: `fake-source-${source.index}`, title: source.title };
    },
    async waitForSources() {},
    async ask() {
      const answer = responsePath
        ? await readFile(responsePath, "utf8")
        : "# 核心结论与明确决策\n\nFake provider result.\n\n# 事实与 AI 推断说明\n\n用于测试。";
      return { answer, conversationId: "fake-conversation-id", references: [] };
    },
    async deleteNotebook() {},
  };
}

function mimeTypeFor(path) {
  const extension = extname(path).toLowerCase();
  const known = {
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".mp4": "video/mp4",
  };
  return known[extension] || "application/octet-stream";
}

async function normalizeSources(paths) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new WorkflowError("source_missing", "At least one --source is required");
  }
  const sources = [];
  for (let index = 0; index < paths.length; index += 1) {
    const path = resolve(paths[index]);
    if (!(await pathExists(path))) {
      throw new WorkflowError("source_missing", `Source is not readable: ${path}`);
    }
    sources.push({
      index: index + 1,
      path,
      title: basename(path),
      mimeType: mimeTypeFor(path),
    });
  }
  return sources;
}

async function resolvePrompt(options) {
  if (options.prompt && options.promptFile) {
    throw new WorkflowError("usage", "Use either --prompt or --prompt-file, not both");
  }
  if (options.prompt) return options.prompt;
  if (options.promptFile) return readFile(resolve(options.promptFile), "utf8");
  const defaultPrompt = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "meeting-extraction-prompt.md");
  return readFile(defaultPrompt, "utf8");
}

function notebookUrl(notebookId) {
  return `https://notebooklm.google.com/notebook/${notebookId}`;
}

function renderMarkdown({ title, sources, response, notebookId }) {
  const sourceList = sources.map((source) => `- ${source.title}`).join("\n");
  const provenance = [
    `# ${title}`,
    "",
    "> 整理方式：将以下原始材料提交至 Google NotebookLM，并按会议提炼契约生成。NotebookLM 为外部服务；正文中的 AI 建议不等同于会议决策。历史负责人和时间点需要结合当前进度重新确认。",
    "",
    "## 原始材料",
    "",
    sourceList,
    "",
    `NotebookLM notebook: ${notebookUrl(notebookId)}`,
    "",
  ].join("\n");
  return `${provenance}${String(response.answer || "").trim()}\n`;
}

function classifyLoginLaunchError(error, authPath) {
  const message = error instanceof Error ? error.message : String(error);
  const sandboxSignals = [
    "operation not permitted",
    "Target page, context or browser has been closed",
    "Received signal 6",
    "SIGABRT",
    "no-startup-window",
  ];
  if (sandboxSignals.some((signal) => message.includes(signal))) {
    return new WorkflowError(
      "interactive_browser_blocked",
      "The current agent runtime forbids launching an interactive browser from Shell. Run the same Skill in a normal terminal/agent runtime with GUI-process permission, or provision NOTEBOOKLM_STORAGE_STATE as a host secret.",
      { authPath, cause: message },
    );
  }
  return new WorkflowError(
    "requires_user_auth",
    "NotebookLM setup could not complete the Google login flow",
    { authPath, cause: message },
  );
}

async function runLoginBrowser({ authPath, proxy, cacheDir, timeoutMs = 600000 }) {
  const playwrightPath = pathToFileURL(
    join(cacheDir, "node_modules", "playwright", "index.mjs"),
  ).href;
  let playwright;
  try {
    playwright = await import(playwrightPath);
  } catch (error) {
    throw new WorkflowError(
      "browser_dependency_missing",
      "Playwright is unavailable after provider installation",
      { cause: String(error) },
    );
  }
  const browser = await playwright.chromium.launch({
    headless: false,
    proxy: proxy ? { server: proxy } : undefined,
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  const deadline = Date.now() + timeoutMs;
  try {
    await page.goto(NOTEBOOKLM_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    process.stdout.write(
      `${JSON.stringify({ status: "waiting_for_user_login", message: "请在已打开的 Google 页面完成登录；完成后会自动继续。", authPath })}\n`,
    );
    while (Date.now() < deadline) {
      await page.waitForTimeout(2000);
      const currentUrl = page.url();
      if (!currentUrl.startsWith("https://notebooklm.google.com")) continue;
      const cookies = await context.cookies();
      const hasSession = cookies.some((cookie) => {
        const domain = cookieDomain(cookie);
        return (
          domain.endsWith("google.com") &&
          new Set(["SID", "HSID", "SSID", "APISID", "SAPISID", "__Secure-1PSID"]).has(cookie.name)
        );
      });
      if (!hasSession || currentUrl.includes("location=unsupported")) continue;
      await mkdir(dirname(authPath), { recursive: true });
      await context.storageState({ path: authPath });
      await chmod(authPath, 0o600);
      await validateAuthState(authPath);
      return { status: "configured", authPath };
    }
    throw new WorkflowError(
      "requires_user_auth",
      "Google login was not completed before the 10-minute timeout",
      { authPath },
    );
  } finally {
    await browser.close();
  }
}

async function setup(options) {
  const authPath = resolve(options.auth || process.env.NOTEBOOKLM_STORAGE_STATE || DEFAULT_AUTH);
  const proxy = await resolveProxy(options.proxy);
  applyProxyEnvironment(proxy);
  await assertProxyReachable(proxy);
  await checkNetwork(proxy);
  await mkdir(dirname(authPath), { recursive: true });
  const { cacheDir, packageSpec } = await ensureProviderPackage();
  if (!options.skipBrowserInstall) {
    await runInteractive(
      "npx",
      ["-y", "-p", packageSpec, "playwright", "install", "chromium"],
      { env: providerEnvironment(proxy) },
    );
  }
  try {
    return await runLoginBrowser({ authPath, proxy, cacheDir });
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    throw classifyLoginLaunchError(error, authPath);
  }
}

async function doctor(options) {
  const authPath = resolve(options.auth || process.env.NOTEBOOKLM_STORAGE_STATE || DEFAULT_AUTH);
  const proxy = await resolveProxy(options.proxy);
  applyProxyEnvironment(proxy);
  await assertProxyReachable(proxy);
  const auth = await validateAuthState(authPath);
  const network = await checkNetwork(proxy);
  if (!options.skipProviderCheck) {
    const provider = await importProvider(authPath);
    try {
      await provider.connect();
    } catch (error) {
      throw new WorkflowError("auth_expired", "NotebookLM authenticated provider check failed", {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { status: "ready", authPath, proxy, auth, network };
}

async function runWorkflow(options) {
  for (const required of ["title", "output", "receipt"]) {
    if (!options[required]) throw new WorkflowError("usage", `--${required} is required`);
  }
  const sources = await normalizeSources(options.sources);
  const prompt = await resolvePrompt(options);
  if (!prompt.trim()) throw new WorkflowError("prompt_empty", "Extraction prompt is empty");
  const authPath = resolve(options.auth || process.env.NOTEBOOKLM_STORAGE_STATE || DEFAULT_AUTH);
  const proxy = await resolveProxy(options.proxy);
  applyProxyEnvironment(proxy);
  const outputPath = resolve(options.output);
  const receiptPath = resolve(options.receipt);

  if (options.dryRun) {
    const receipt = {
      status: "dry_run",
      title: options.title,
      sources: sources.map(({ path, title, mimeType }) => ({ path, title, mimeType })),
      outputPath,
      receiptPath,
      proxy,
    };
    await mkdir(dirname(receiptPath), { recursive: true });
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    return receipt;
  }

  await assertProxyReachable(proxy);
  try {
    await validateAuthState(authPath);
  } catch (error) {
    if (!options.autoSetup || !(error instanceof WorkflowError) || !new Set(["auth_missing", "auth_expired", "auth_invalid"]).has(error.code)) {
      throw error;
    }
    await setup({ auth: authPath, proxy: proxy || undefined });
    await validateAuthState(authPath);
  }
  await checkNetwork(proxy);
  const provider = await importProvider(authPath);
  await provider.connect();

  let notebook;
  const uploaded = [];
  try {
    notebook = await provider.createNotebook(options.title);
    if (!notebook?.id) throw new WorkflowError("provider_invalid", "Provider returned no notebook ID");
    for (const source of sources) {
      const uploadedSource = await provider.addSource(notebook.id, source);
      if (!uploadedSource?.id) {
        throw new WorkflowError("source_rejected", `Provider returned no source ID for ${source.path}`);
      }
      uploaded.push({ ...source, sourceId: uploadedSource.id });
    }
    await provider.waitForSources(
      notebook.id,
      uploaded.map((source) => source.sourceId),
      { timeout: 300000, pollInterval: 2000 },
    );
    const response = await provider.ask(
      notebook.id,
      prompt,
      uploaded.map((source) => source.sourceId),
    );
    if (!String(response?.answer || "").trim()) {
      throw new WorkflowError("empty_answer", "NotebookLM returned an empty answer");
    }
    const markdown = renderMarkdown({
      title: options.title,
      sources,
      response,
      notebookId: notebook.id,
    });
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, markdown, "utf8");
    const receipt = {
      status: "completed",
      provider: "Google NotebookLM (unofficial API client)",
      title: options.title,
      notebookId: notebook.id,
      notebookUrl: notebookUrl(notebook.id),
      sources: uploaded.map(({ path, title, mimeType, sourceId }) => ({
        path,
        title,
        mimeType,
        sourceId,
      })),
      conversationId: response.conversationId || null,
      referenceCount: Array.isArray(response.references) ? response.references.length : null,
      outputPath,
      cleanupRequested: options.cleanup,
      createdAt: new Date().toISOString(),
    };
    if (options.cleanup) {
      await provider.deleteNotebook(notebook.id);
      receipt.notebookDeleted = true;
      receipt.notebookUrl = null;
    } else {
      receipt.notebookDeleted = false;
    }
    await mkdir(dirname(receiptPath), { recursive: true });
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    return receipt;
  } catch (error) {
    const failureReceipt = {
      status: "failed",
      title: options.title,
      notebookId: notebook?.id || null,
      notebookUrl: notebook?.id ? notebookUrl(notebook.id) : null,
      sources: uploaded.map(({ path, title, mimeType, sourceId }) => ({
        path,
        title,
        mimeType,
        sourceId,
      })),
      error: serializeError(error),
      createdAt: new Date().toISOString(),
    };
    await mkdir(dirname(receiptPath), { recursive: true });
    await writeFile(receiptPath, `${JSON.stringify(failureReceipt, null, 2)}\n`, "utf8");
    throw error;
  }
}

function serializeError(error) {
  if (error instanceof WorkflowError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  return { code: "unexpected", message: error instanceof Error ? error.message : String(error) };
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    if (options.command === "help") {
      process.stdout.write(usage());
      return 0;
    }
    let result;
    if (options.command === "setup") result = await setup(options);
    else if (options.command === "doctor") result = await doctor(options);
    else result = await runWorkflow(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ status: "failed", error: serializeError(error) }, null, 2)}\n`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
