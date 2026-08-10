import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  auditPtyCanonicalChain,
  finalizeExternalRawRuntime,
  RetainedEvidencePrivacyError,
  scanRetainedEvidenceTree,
  type PtyCanonicalChainInput,
} from '../scripts/conversation-evidence-integrity.js';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, '..');
const tsxImport = fileURLToPath(import.meta.resolve('tsx'));

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

test('retained evidence scanner hashes safe originals and catches all exact private values across chunks', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-evidence-integrity-'));
  const secret = 'synthetic-provider-secret-never-log-this';
  const privateHome = '/synthetic/private/home';
  const credentialRoot = '/private/tmp/synthetic-credential-root';
  const credentialFile = `${credentialRoot}/.env`;
  const runtimeRoot = '/private/tmp/synthetic-runtime-root';
  const needles = [
    { kind: 'provider-secret' as const, value: secret },
    { kind: 'private-home' as const, value: privateHome },
    { kind: 'credential-root' as const, value: credentialRoot },
    { kind: 'credential-file' as const, value: credentialFile },
    { kind: 'runtime-root' as const, value: runtimeRoot },
  ];
  try {
    await mkdir(path.join(root, 'canonical'), { mode: 0o700 });
    const safe = Buffer.from('{"event":"event-1","status":"completed"}\n');
    await writeFile(path.join(root, 'canonical', 'event.json'), safe, { mode: 0o600 });
    const report = await scanRetainedEvidenceTree(root, needles);
    assert.equal(report.fileCount, 1);
    assert.equal(report.bytes, safe.byteLength);
    assert.deepEqual(report.files, [{
      path: 'canonical/event.json',
      sha256: createHash('sha256').update(safe).digest('hex'),
      bytes: safe.byteLength,
      mode: 0o600,
      role: 'canonical-entity',
      generation: 0,
    }]);
    assert.deepEqual(report.checkedNeedleKinds, [
      'credential-file', 'credential-root', 'private-home', 'provider-secret', 'runtime-root',
    ]);

    const cases = [
      ['provider-secret', secret],
      ['private-home', privateHome],
      ['credential-root', credentialRoot],
      ['credential-file', credentialFile],
      ['runtime-root', runtimeRoot],
    ] as const;
    for (const [kind, value] of cases) {
      const unsafe = path.join(root, `${kind}.bin`);
      await writeFile(unsafe, Buffer.concat([
        Buffer.alloc(64 * 1024 - 3, 0x61),
        Buffer.from(value),
      ]), { mode: 0o600 });
      await assert.rejects(
        scanRetainedEvidenceTree(root, needles),
        (error: unknown) => {
          assert.ok(error instanceof RetainedEvidencePrivacyError);
          assert.equal(error.kind, kind);
          assert.equal(error.evidencePath, `${kind}.bin`);
          assert.doesNotMatch(error.message, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
          return true;
        },
      );
      await rm(unsafe);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('retained evidence scanner rejects symlinks instead of following them', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-evidence-symlink-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'mimi-evidence-outside-'));
  try {
    await writeFile(path.join(outside, 'private.txt'), 'safe-looking-data', { mode: 0o600 });
    await symlink(path.join(outside, 'private.txt'), path.join(root, 'linked.txt'));
    await assert.rejects(
      scanRetainedEvidenceTree(root, [{ kind: 'provider-secret', value: 'synthetic-secret' }]),
      /unsupported entry linked\.txt/u,
    );
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  }
});

test('retained evidence scanner rejects public modes, hardlinks, credential names, and secret patterns', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-evidence-metadata-'));
  const needle = [{ kind: 'private-home' as const, value: '/synthetic/private/home' }];
  try {
    const file = path.join(root, 'artifact.json');
    await writeFile(file, '{}\n', { mode: 0o600 });
    await chmod(file, 0o644);
    await assert.rejects(scanRetainedEvidenceTree(root, needle), /file is not private/u);
    await chmod(file, 0o600);

    const hardlink = path.join(root, 'artifact-copy.json');
    await link(file, hardlink);
    await assert.rejects(scanRetainedEvidenceTree(root, needle), /multiple links/u);
    await rm(hardlink);

    for (const name of ['control.token', '.env', '.owner', 'daemon.socket']) {
      const forbidden = path.join(root, name);
      await writeFile(forbidden, 'placeholder\n', { mode: 0o600 });
      await assert.rejects(scanRetainedEvidenceTree(root, needle), (error: unknown) => {
        assert.ok(error instanceof RetainedEvidencePrivacyError);
        assert.equal(error.kind, 'forbidden-name');
        assert.equal(error.evidencePath, name);
        return true;
      });
      await rm(forbidden);
    }

    const secretPatterns: Array<readonly [string, string]> = [
      ['bearer.txt', 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345'],
      ['openai.txt', 'sk-abcdefghijklmnopqrstuvwxyz012345'],
      ['dotenv.txt', 'FRIDAY_API_KEY=actual-network-credential-value'],
    ];
    for (const [name, value] of secretPatterns) {
      const forbidden = path.join(root, name);
      await writeFile(forbidden, value, { mode: 0o600 });
      await assert.rejects(scanRetainedEvidenceTree(root, needle), (error: unknown) => {
        assert.ok(error instanceof RetainedEvidencePrivacyError);
        assert.equal(error.kind, 'secret-pattern');
        assert.equal(error.evidencePath, name);
        assert.doesNotMatch(error.message, /actual-network|abcdefghijklmnopqrstuvwxyz/u);
        return true;
      });
      await rm(forbidden);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function validPtyCanonicalInput(): PtyCanonicalChainInput & {
  task: Record<string, unknown>;
  run: Record<string, unknown> & {
    answer: { answer: string; finalization: { runId: string; outcome: string } };
  };
  trace: unknown[];
  sessionItems: unknown[];
} {
  const sessionId = 'session-1';
  const prompt = 'SCENE=conv-001 TURN=1 NONCE=nonce-1';
  const assistantText = 'completed nonce-1';
  return {
    event: {
      id: 'event-1', source: 'local-cli', trust: 'owner', profileId: 'owner',
      sessionKey: sessionId, payload: { prompt },
    },
    task: {
      taskId: 'task-1', id: 'task-1',
      triggerEventId: 'event-1', authorityEventId: 'event-1',
      sessionId, sessionKey: sessionId, profileId: 'owner', status: 'completed',
    },
    run: {
      id: 'daemon-run-1', taskId: 'task-1', sessionKey: sessionId, status: 'completed',
      answer: {
        answer: assistantText,
        finalization: { runId: 'runtime-run-1', outcome: 'completed' },
      },
    },
    trace: [
      { type: 'turn_start', sessionId, data: { input: prompt } },
      {
        type: 'model_binding_event', sessionId,
        data: { workUnitKind: 'conversation', workUnitId: 'runtime-run-1' },
      },
      {
        type: 'model_tool_surface', sessionId,
        data: {
          phase: 'before_model_dispatch', runId: 'runtime-run-1', advertisedTools: [],
          advertisedToolCount: 0,
          toolSetDigest: `sha256:${createHash('sha256').update('[]').digest('hex')}`,
        },
      },
      { type: 'run_finalization', sessionId, data: { runId: 'runtime-run-1', outcome: 'completed' } },
      { type: 'turn_end', sessionId, data: { answer: assistantText } },
    ],
    sessionItems: [
      { type: 'message', role: 'user', content: prompt },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: assistantText }] },
    ],
    sessionId,
    prompt,
    nonce: 'nonce-1',
    assistantText,
    daemonRunId: 'daemon-run-1',
    taskId: 'task-1',
    helperRuntimeRunId: 'runtime-run-1',
  };
}

test('PTY canonical chain binds Event, Task, Daemon Run, runtime Run, Trace, and Session protocol', () => {
  const valid = validPtyCanonicalInput();
  assert.deepEqual(auditPtyCanonicalChain(valid), {
    proven: true,
    runtimeRunId: 'runtime-run-1',
    reasons: [],
  });
  const mismatched = structuredClone(valid);
  mismatched.task.triggerEventId = 'event-from-another-turn';
  mismatched.task.authorityEventId = 'event-from-another-authority';
  (mismatched.task as Record<string, unknown>).id = 'task-from-another-record';
  mismatched.run.answer.finalization.runId = 'runtime-run-from-another-turn';
  const audit = auditPtyCanonicalChain(mismatched);
  assert.equal(audit.proven, false);
  assert.match(audit.reasons.join('\n'), /trigger Event/u);
  assert.match(audit.reasons.join('\n'), /Task Event aliases disagree/u);
  assert.match(audit.reasons.join('\n'), /id aliases disagree/u);
  assert.match(audit.reasons.join('\n'), /Trace does not contain/u);

  const wrongAuthority = validPtyCanonicalInput();
  (wrongAuthority.event as Record<string, unknown>).trust = 'external';
  wrongAuthority.task.profileId = 'different-profile';
  const authorityAudit = auditPtyCanonicalChain(wrongAuthority);
  assert.equal(authorityAudit.proven, false);
  assert.match(authorityAudit.reasons.join('\n'), /local owner CLI authority/u);
  assert.match(authorityAudit.reasons.join('\n'), /Event profile/u);
});

test('PTY canonical chain rejects every conflicting Task identity alias', () => {
  const input = validPtyCanonicalInput();
  input.task.id = 'task-from-another-record';
  input.task.authorityEventId = 'event-from-another-authority';
  input.task.sessionKey = 'session-from-another-record';
  const audit = auditPtyCanonicalChain(input);
  assert.equal(audit.proven, false);
  assert.match(audit.reasons.join('\n'), /Task id aliases disagree/u);
  assert.match(audit.reasons.join('\n'), /Task Event aliases disagree/u);
  assert.match(audit.reasons.join('\n'), /Task Session aliases disagree/u);
});

test('PTY canonical chain requires exact owner CLI Event and Task authority for the PTY Session', () => {
  const wrongSource = validPtyCanonicalInput();
  (wrongSource.event as Record<string, unknown>).source = 'connector:local-cli';
  let audit = auditPtyCanonicalChain(wrongSource);
  assert.equal(audit.proven, false);
  assert.match(audit.reasons.join('\n'), /local owner CLI authority/u);

  const wrongTrust = validPtyCanonicalInput();
  (wrongTrust.event as Record<string, unknown>).trust = 'system';
  audit = auditPtyCanonicalChain(wrongTrust);
  assert.equal(audit.proven, false);
  assert.match(audit.reasons.join('\n'), /local owner CLI authority/u);

  const nonOwnerProfile = validPtyCanonicalInput();
  (nonOwnerProfile.event as Record<string, unknown>).profileId = 'shared-profile';
  nonOwnerProfile.task.profileId = 'shared-profile';
  audit = auditPtyCanonicalChain(nonOwnerProfile);
  assert.equal(audit.proven, false);
  assert.match(audit.reasons.join('\n'), /owner profile/u);

  const wrongEventSession = validPtyCanonicalInput();
  (wrongEventSession.event as Record<string, unknown>).sessionKey = 'session-from-another-pty';
  audit = auditPtyCanonicalChain(wrongEventSession);
  assert.equal(audit.proven, false);
  assert.match(audit.reasons.join('\n'), /Event Session/u);

  const missingEventSession = validPtyCanonicalInput();
  delete (missingEventSession.event as Record<string, unknown>).sessionKey;
  audit = auditPtyCanonicalChain(missingEventSession);
  assert.equal(audit.proven, false);
  assert.match(audit.reasons.join('\n'), /Event Session/u);

  const mismatchedTaskProfile = validPtyCanonicalInput();
  mismatchedTaskProfile.task.profileId = 'shared-profile';
  audit = auditPtyCanonicalChain(mismatchedTaskProfile);
  assert.equal(audit.proven, false);
  assert.match(audit.reasons.join('\n'), /Task profile/u);

  const mismatchedTaskSession = validPtyCanonicalInput();
  mismatchedTaskSession.task.sessionId = 'session-from-another-task';
  mismatchedTaskSession.task.sessionKey = 'session-from-another-task';
  audit = auditPtyCanonicalChain(mismatchedTaskSession);
  assert.equal(audit.proven, false);
  assert.match(audit.reasons.join('\n'), /Task Session/u);
});

test('PTY canonical chain rejects malformed and duplicated Session protocol units', () => {
  const misordered = validPtyCanonicalInput();
  misordered.sessionItems.splice(1, 0,
    { type: 'function_call_result', callId: 'call-1', name: 'read_file', output: 'ok' },
    { type: 'function_call', callId: 'call-1', name: 'read_file', arguments: '{}' },
  );
  let audit = auditPtyCanonicalChain(misordered);
  assert.equal(audit.proven, false);
  assert.match(audit.reasons.join('\n'), /tool result .* does not follow its call/u);
  assert.match(audit.reasons.join('\n'), /empty advertised Tool surface/u);

  const duplicateAssistant = validPtyCanonicalInput();
  duplicateAssistant.sessionItems.push(structuredClone(duplicateAssistant.sessionItems.at(-1)!));
  audit = auditPtyCanonicalChain(duplicateAssistant);
  assert.equal(audit.proven, false);
  assert.match(audit.reasons.join('\n'), /exactly one canonical assistant/u);

  const duplicateUser = validPtyCanonicalInput();
  duplicateUser.sessionItems.push(structuredClone(duplicateUser.sessionItems[0]!));
  audit = auditPtyCanonicalChain(duplicateUser);
  assert.equal(audit.proven, false);
  assert.match(audit.reasons.join('\n'), /exactly one canonical user/u);

  const danglingCall = validPtyCanonicalInput();
  danglingCall.sessionItems.splice(1, 0,
    { type: 'function_call', callId: 'call-1', name: 'read_file', arguments: '{}' },
  );
  audit = auditPtyCanonicalChain(danglingCall);
  assert.equal(audit.proven, false);
  assert.match(audit.reasons.join('\n'), /tool pair call-1 is not exactly 1:1/u);
});

test('PTY canonical chain rejects out-of-order, duplicate, stale, and helper-mismatched Trace proof', () => {
  const outOfOrder = validPtyCanonicalInput();
  [outOfOrder.trace[1], outOfOrder.trace[2]] = [outOfOrder.trace[2]!, outOfOrder.trace[1]!];
  let audit = auditPtyCanonicalChain(outOfOrder);
  assert.equal(audit.proven, false);
  assert.match(audit.reasons.join('\n'), /strictly ordered/u);

  const duplicate = validPtyCanonicalInput();
  duplicate.trace.splice(3, 0, structuredClone(duplicate.trace[2]!));
  audit = auditPtyCanonicalChain(duplicate);
  assert.equal(audit.proven, false);
  assert.match(audit.reasons.join('\n'), /exactly one model_tool_surface/u);

  const stale = validPtyCanonicalInput();
  stale.trace.splice(2, 0, {
    type: 'model_binding_event', sessionId: stale.sessionId,
    data: { workUnitKind: 'conversation', workUnitId: 'stale-runtime-run' },
  });
  audit = auditPtyCanonicalChain(stale);
  assert.equal(audit.proven, false);
  assert.match(audit.reasons.join('\n'), /stale runtime Run/u);

  const helperMismatch = validPtyCanonicalInput();
  helperMismatch.helperRuntimeRunId = 'helper-stale-runtime-run';
  audit = auditPtyCanonicalChain(helperMismatch);
  assert.equal(audit.proven, false);
  assert.match(audit.reasons.join('\n'), /helper runtime Run/u);

  const contradicted = validPtyCanonicalInput();
  contradicted.trace.splice(-1, 0, {
    type: 'turn_interrupted', sessionId: contradicted.sessionId,
    data: { runId: 'runtime-run-1' },
  });
  audit = auditPtyCanonicalChain(contradicted);
  assert.equal(audit.proven, false);
  assert.match(audit.reasons.join('\n'), /error or interruption/u);
});

test('successful canonical export deletes external raw runtime while failure retains only an opaque quarantine', async () => {
  const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), 'mimi-evidence-finalize-'));
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), 'mimi-cr-success-'));
  const failedRuntime = await mkdtemp(path.join(os.tmpdir(), 'mimi-cr-failed-'));
  try {
    await writeFile(path.join(runtimeRoot, 'control.token'), 'private-control-token', { mode: 0o600 });
    const canonical = path.join(evidenceRoot, 'pty-smoke-canonical');
    await mkdir(canonical, { mode: 0o700 });
    const artifacts = [
      ['turn-01.event.json', '{"id":"event-1"}\n'],
      ['turn-01.task.json', '{"taskId":"task-1"}\n'],
      ['turn-01.daemon-run.json', '{"id":"run-1"}\n'],
      ['session.json', '{"items":[]}\n'],
      ['trace.jsonl', '{"type":"turn_end"}\n'],
    ] as const;
    for (const [name, contents] of artifacts) {
      await writeFile(path.join(canonical, name), contents, { mode: 0o600 });
    }
    await writeFile(path.join(evidenceRoot, 'pty-smoke.canonical-index.json'), JSON.stringify({
      schemaVersion: 1,
      kind: 'persistent-pty-canonical-evidence-index',
      artifacts: artifacts.map(([name, contents]) => ({
        path: `pty-smoke-canonical/${name}`,
        sha256: createHash('sha256').update(contents).digest('hex'),
        bytes: Buffer.byteLength(contents),
      })),
    }), { mode: 0o600 });
    await writeFile(path.join(evidenceRoot, 'pty-smoke.proof.json'), '{"passed":true}\n', { mode: 0o600 });

    const removed = await finalizeExternalRawRuntime(runtimeRoot, evidenceRoot);
    assert.deepEqual(removed, { retainedExternally: false, rawRuntimeDeleted: true });
    await assert.rejects(lstat(runtimeRoot), (error: unknown) => (
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ));
    const scan = await scanRetainedEvidenceTree(evidenceRoot, [
      { kind: 'runtime-root', value: runtimeRoot },
      { kind: 'private-home', value: '/synthetic/private/home' },
    ]);
    assert.equal(scan.files.some((file) => file.path === 'control.token'), false);
    assert.equal(scan.files.filter((file) => file.role === 'canonical-entity').length, 5);

    await writeFile(path.join(failedRuntime, 'control.token'), 'private-control-token', { mode: 0o600 });
    const retained = await finalizeExternalRawRuntime(failedRuntime, evidenceRoot, 'functional-failure');
    assert.equal(retained.retainedExternally, true);
    assert.equal(retained.rawRuntimeDeleted, false);
    assert.equal(retained.retentionReason, 'functional-failure');
    assert.match(retained.quarantineDigest ?? '', /^[0-9a-f]{64}$/u);
    assert.doesNotMatch(JSON.stringify(retained), new RegExp(failedRuntime.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
    assert.equal((await lstat(failedRuntime)).isDirectory(), true);
  } finally {
    await Promise.all([
      rm(evidenceRoot, { recursive: true, force: true }),
      rm(runtimeRoot, { recursive: true, force: true }),
      rm(failedRuntime, { recursive: true, force: true }),
    ]);
  }
});

test('runner exact-empty environment starts a real foreground Daemon with zero Connectors and no Provider turn', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-cr-spawn-'));
  const workspace = path.join(root, 'workspace');
  const dataRoot = path.join(root, 'data');
  const daemonRoot = path.join(root, 'daemon');
  const home = path.join(root, 'home');
  const temporary = path.join(root, 'tmp');
  const config = path.join(root, 'config');
  await Promise.all([workspace, dataRoot, daemonRoot, home, temporary, config]
    .map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })));
  const connectors = path.join(config, 'connectors.json');
  const mcp = path.join(config, 'mcp.json');
  const environmentFile = path.join(config, 'provider.env');
  const exact = '{"connectors":{}}\n';
  await Promise.all([
    writeFile(connectors, exact, { mode: 0o600 }),
    writeFile(mcp, '{"mcpServers":{}}\n', { mode: 0o600 }),
    writeFile(environmentFile, 'OPENAI_API_KEY="synthetic-never-used-provider-key"\n', { mode: 0o600 }),
  ]);
  const entry = path.join(repositoryRoot, 'src', 'index.ts');
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    LANG: process.env.LANG,
    HOME: home,
    TMPDIR: temporary,
    MIMI_CONFIG_VERSION: '4',
    MIMI_WORKSPACE: workspace,
    MIMI_DATA_DIR: dataRoot,
    MIMI_DAEMON_DATA_DIR: daemonRoot,
    MIMI_DAEMON_SUPERVISOR: 'foreground',
    MIMI_ENV_FILE: environmentFile,
    MIMI_CONNECTORS_CONFIG: connectors,
    MIMI_CONNECTORS_CONFIG_MODE: 'exact',
    MIMI_MCP_CONFIG: mcp,
    MIMI_COMPUTER_BACKEND: 'off',
    MIMI_SECURITY_PROFILE: 'safe',
    MIMI_PERMISSION_MODE: 'read-only',
    MIMI_CONVERSATION_RUN_POLICY: 'benchmark-no-tools-v1',
  };
  const daemon = spawn(process.execPath, ['--import', tsxImport, entry, 'daemon', 'run'], {
    cwd: workspace,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs: Buffer[] = [];
  daemon.stdout?.on('data', (value: Buffer) => logs.push(Buffer.from(value)));
  daemon.stderr?.on('data', (value: Buffer) => logs.push(Buffer.from(value)));
  try {
    let status: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 100 && !status; attempt += 1) {
      try {
        const result = await execFileAsync(process.execPath, [
          '--import', tsxImport, entry, 'daemon', 'status', '--json',
        ], { cwd: workspace, env, encoding: 'utf8', timeout: 2_000 });
        const candidate = JSON.parse(result.stdout) as Record<string, unknown>;
        if (typeof candidate.pid === 'number') status = candidate;
      } catch {
        await delay(50);
      }
    }
    assert.ok(status, `foreground Daemon did not become ready: ${Buffer.concat(logs).toString('utf8')}`);
    assert.equal(status.connectorCount, 0, JSON.stringify(status));
    assert.equal(await readFile(connectors, 'utf8'), exact);
    const runs = await execFileAsync(process.execPath, [
      '--import', tsxImport, entry, 'daemon', 'runs', '100',
    ], { cwd: workspace, env, encoding: 'utf8', timeout: 2_000 });
    assert.deepEqual(JSON.parse(runs.stdout), [], 'readiness must not execute a Provider conversation turn');
  } finally {
    await execFileAsync(process.execPath, ['--import', tsxImport, entry, 'daemon', 'stop'], {
      cwd: workspace,
      env,
      encoding: 'utf8',
      timeout: 10_000,
    }).catch(() => undefined);
    const deadline = Date.now() + 10_000;
    while (daemon.exitCode === null && daemon.signalCode === null && Date.now() < deadline) await delay(50);
    if (daemon.exitCode === null && daemon.signalCode === null && daemon.pid) {
      try { process.kill(-daemon.pid, 'SIGKILL'); } catch { daemon.kill('SIGKILL'); }
    }
    await rm(root, { recursive: true, force: true });
  }
});
