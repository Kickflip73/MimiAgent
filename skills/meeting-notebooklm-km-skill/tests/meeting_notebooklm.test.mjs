import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  parseArgs,
  resolveProxy,
  validateAuthState,
  createRealProvider,
} from "../scripts/meeting_notebooklm.mjs";

const script = fileURLToPath(new URL("../scripts/meeting_notebooklm.mjs", import.meta.url));

async function runNode(args, env = {}) {
  const { spawn } = await import("node:child_process");
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { ...process.env, ...env },
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

test("parseArgs accepts repeated sources and explicit cleanup", () => {
  const parsed = parseArgs([
    "run",
    "--title",
    "meeting",
    "--source",
    "/tmp/a.md",
    "--source",
    "/tmp/b.pdf",
    "--output",
    "/tmp/out.md",
    "--receipt",
    "/tmp/receipt.json",
    "--cleanup",
  ]);
  assert.deepEqual(parsed.sources, ["/tmp/a.md", "/tmp/b.pdf"]);
  assert.equal(parsed.cleanup, true);
});

test("resolveProxy rejects implicit or malformed proxy endpoints", async () => {
  await assert.rejects(resolveProxy("127.0.0.1:7897"), { code: "proxy_config_invalid" });
  await assert.rejects(resolveProxy("auto"), { code: "proxy_config_invalid" });
  assert.equal(await resolveProxy("off"), null);
  assert.equal(await resolveProxy("http://127.0.0.1:7897"), "http://127.0.0.1:7897");
});

test("validateAuthState accepts a live Google cookie and rejects unrelated cookies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "meeting-notebooklm-auth-"));
  const live = join(dir, "live.json");
  const unrelated = join(dir, "unrelated.json");
  await writeFile(
    live,
    JSON.stringify({ cookies: [{ domain: ".google.com", name: "SID", value: "secret", expires: -1 }] }),
  );
  await writeFile(
    unrelated,
    JSON.stringify({ cookies: [{ domain: ".example.com", name: "SID", value: "x", expires: -1 }] }),
  );
  assert.deepEqual(await validateAuthState(live), { cookieCount: 1 });
  await assert.rejects(validateAuthState(unrelated), { code: "auth_expired" });
});

test("real-provider adapter calls the pinned client contract correctly", async () => {
  const calls = [];
  const fakeClient = {
    notebooks: {
      list: async () => calls.push(["list"]),
      create: async (title) => ({ id: "nb-real-contract", title }),
      delete: async (id) => calls.push(["delete", id]),
    },
    sources: {
      addText: async (...args) => {
        calls.push(["addText", ...args]);
        return { id: "source-text" };
      },
      addFile: async (...args) => {
        calls.push(["addFile", ...args]);
        return { id: "source-file" };
      },
      waitForSources: async (...args) => {
        calls.push(["waitForSources", ...args]);
        return [{ id: "source-file", status: "ready" }];
      },
    },
    chat: {
      ask: async (...args) => {
        calls.push(["ask", ...args]);
        return { answer: "ok" };
      },
    },
  };
  const module = {
    NotebookLMClient: {
      fromStorage: async (path) => {
        calls.push(["fromStorage", path]);
        return fakeClient;
      },
    },
  };
  const dir = await mkdtemp(join(tmpdir(), "meeting-notebooklm-contract-"));
  const binary = join(dir, "meeting.pdf");
  await writeFile(binary, Buffer.from([1, 2, 3]));
  const provider = createRealProvider(module, "/secret/auth.json");
  await provider.connect();
  await provider.addSource("nb", {
    path: binary,
    title: "meeting.pdf",
    mimeType: "application/pdf",
  });
  await provider.waitForSources("nb", ["source-file"], { timeout: 300000 });
  await provider.ask("nb", "question", ["source-file"]);
  assert.deepEqual(calls[0], ["fromStorage", "/secret/auth.json"]);
  assert.deepEqual(calls[1], ["list"]);
  assert.equal(calls[2][0], "addFile");
  assert.equal(calls[2][1], "nb");
  assert.equal(calls[2][2], "meeting.pdf");
  assert.ok(Buffer.isBuffer(calls[2][3]));
  assert.equal(calls[2][4], "application/pdf");
  assert.deepEqual(calls[3], [
    "waitForSources",
    "nb",
    ["source-file"],
    { timeout: 300000 },
  ]);
  assert.deepEqual(calls[4], ["ask", "nb", "question", { sourceIds: ["source-file"] }]);
});

test("dry-run records exact sources without contacting NotebookLM", async () => {
  const dir = await mkdtemp(join(tmpdir(), "meeting-notebooklm-dry-"));
  const source = join(dir, "meeting.md");
  const output = join(dir, "result.md");
  const receipt = join(dir, "receipt.json");
  await writeFile(source, "# Meeting\nDecision A");
  const result = await runNode([
    "run",
    "--title",
    "Dry meeting",
    "--source",
    source,
    "--output",
    output,
    "--receipt",
    receipt,
    "--dry-run",
  ]);
  assert.equal(result.code, 0, result.stderr);
  const parsed = JSON.parse(await readFile(receipt, "utf8"));
  assert.equal(parsed.status, "dry_run");
  assert.equal(parsed.sources.length, 1);
  assert.equal(parsed.sources[0].path, source);
});

test("fake provider completes the full create-upload-ask receipt contract", async () => {
  const dir = await mkdtemp(join(tmpdir(), "meeting-notebooklm-fake-"));
  const source = join(dir, "meeting.md");
  const answer = join(dir, "answer.md");
  const output = join(dir, "result.md");
  const receipt = join(dir, "receipt.json");
  const auth = join(dir, "auth.json");
  await writeFile(source, "# Meeting\nDecision A");
  await writeFile(answer, "# 核心结论与明确决策\n\n- 决策 A。\n\n# 事实与 AI 推断说明\n\n- 来自原文。\n");
  await writeFile(
    auth,
    JSON.stringify({ cookies: [{ domain: ".google.com", name: "SID", value: "secret", expires: -1 }] }),
  );
  const result = await runNode(
    [
      "run",
      "--title",
      "Fake meeting",
      "--source",
      source,
      "--output",
      output,
      "--receipt",
      receipt,
      "--auth",
      auth,
    ],
    {
      NOTEBOOKLM_PROVIDER: "fake",
      NOTEBOOKLM_FAKE_RESPONSE: answer,
      NOTEBOOKLM_SKIP_NETWORK: "1",
    },
  );
  assert.equal(result.code, 0, result.stderr);
  const parsed = JSON.parse(await readFile(receipt, "utf8"));
  assert.equal(parsed.status, "completed");
  assert.equal(parsed.notebookId, "fake-notebook-id");
  assert.equal(parsed.sources[0].sourceId, "fake-source-1");
  const markdown = await readFile(output, "utf8");
  assert.match(markdown, /NotebookLM notebook:/);
  assert.match(markdown, /决策 A/);
});
