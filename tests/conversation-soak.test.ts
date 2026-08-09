import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  assessScenarioEligibility,
  assistantTextForNonce,
  auditConversationTurnEvidence,
  conversationTaskEvidenceIdentity,
  deriveConversationResumeState,
  estimateConversationUsd,
  materializeConversationTurn,
  parseConversationManifest,
  redactTerminalSecrets,
  sha256,
  stripTerminalControl,
  terminalBytesContainAssistant,
  type ConversationJournalRecord,
} from '../scripts/conversation-soak-contract.js';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const manifestFile = path.join(repositoryRoot, 'evals', 'conversation', 'manifest.v1.json');
const execFileAsync = promisify(execFile);

async function manifest() {
  return parseConversationManifest(JSON.parse(await readFile(manifestFile, 'utf8')) as unknown);
}

test('conversation manifest freezes the 100 by 30 real-terminal matrix', async () => {
  const value = await manifest();
  const core = value.scenarios.filter((scenario) => !scenario.supplemental);
  const supplemental = value.scenarios.filter((scenario) => scenario.supplemental);
  assert.equal(value.scenarios.length, 103);
  assert.equal(new Set(value.scenarios.map((scenario) => scenario.scenarioId)).size, 103);
  assert.equal(core.length, 100);
  assert.equal(core.reduce((total, scenario) => total + scenario.turnCount, 0), 3_000);
  assert.ok(core.every((scenario) => ['S', 'W', 'F'].includes(scenario.lane)));
  assert.ok(core.every((scenario) => scenario.unattendedEligible));
  assert.deepEqual(supplemental.map((scenario) => scenario.lane).sort(), ['L', 'V', 'V']);
  const suites = new Map<string, typeof value.scenarios>();
  for (const scenario of value.scenarios) {
    const grouped = suites.get(scenario.suite) ?? [];
    grouped.push(scenario);
    suites.set(scenario.suite, grouped);
  }
  assert.equal(suites.size, 10);
  for (const scenarios of suites.values()) assert.ok(scenarios.length >= 10);
  assert.deepEqual(core.map((scenario) => scenario.ordinal),
    Array.from({ length: 100 }, (_, index) => index + 1));
  assert.equal(value.scenarios[0]?.entry, 'persistent-pty');
  assert.match(value.scenarios[0]?.title ?? '', /persistent PTY/iu);
  for (const scenario of value.scenarios.filter((item) => item.lane === 'V' || item.lane === 'L')) {
    assert.equal(scenario.unattendedEligible, false);
    assert.equal(scenario.enabledByDefault, false);
    assert.equal(scenario.supplemental, true);
  }
  assert.ok(value.scenarios.some((scenario) => scenario.evidenceKind === 'fixture'));
  assert.ok(value.scenarios.some((scenario) => scenario.evidenceKind === 'readiness'));
  assert.ok(value.scenarios.some((scenario) => scenario.evidenceKind === 'live_action'));
  assert.ok(value.scenarios.some((scenario) => scenario.evidenceKind === 'soak'));
  assert.ok(core.every((scenario) => scenario.turnActions.length === 30));
  assert.ok(core.every((scenario) => new Set(scenario.turnActions).size === 30));
  assert.ok(core.every((scenario) => scenario.machineOracle.assertions.length >= 3));
  assert.ok(core.every((scenario) => scenario.fixture.receipt.length > 0));
  assert.ok(core.every((scenario) => scenario.toolExpectation.mode === 'none'
    || scenario.toolExpectation.names.length > 0));
  assert.equal(value.scenarios[20]?.toolExpectation.names.includes('list_directory'), true);
  assert.equal(value.scenarios[27]?.toolExpectation.mode, 'none');
  assert.deepEqual(value.scenarios[30]?.toolExpectation.names, ['memory_search']);
  assert.deepEqual(value.scenarios[33]?.toolExpectation.names, ['forget']);
  assert.deepEqual(value.scenarios[58]?.toolExpectation.names, ['model_control']);
  assert.deepEqual(value.scenarios.slice(65, 68).map((scenario) => scenario.toolExpectation.names[0]), [
    'delegate_research', 'delegate_review', 'delegate_architecture',
  ]);
  assert.equal(value.scenarios[67]?.runtimeContract.mode, 'plan');
  assert.equal(value.scenarios[68]?.runtimeContract.mode, 'ultra');
  assert.deepEqual(value.scenarios[68]?.runtimeContract.allowedTools, ['run_team']);
  assert.ok(value.scenarios.every((scenario) => scenario.turnActions.every((action) => (
    action.includes(scenario.scenarioId) && !action.startsWith('Case ')
  ))));
});

test('all core and supplemental prompts have stable unique actions and never become slash commands', async () => {
  const value = await manifest();
  const turns = value.scenarios.flatMap((scenario) => Array.from(
    { length: scenario.turnCount },
    (_, index) => materializeConversationTurn(value, scenario, index + 1),
  ));
  assert.equal(new Set(turns.map((turn) => turn.nonce)).size, 3_090);
  assert.equal(new Set(turns.map((turn) => turn.prompt)).size, 3_090);
  for (const turn of turns) {
    assert.ok(turn.prompt.startsWith(`SCENE=${turn.scenarioId} TURN=${turn.turn} NONCE=${turn.nonce}`));
    assert.equal(turn.prompt.trimStart().startsWith('/'), false);
    assert.doesNotMatch(turn.action, /\{\{(?:SCENE|TURN|NONCE)\}\}/u);
    assert.match(turn.action, new RegExp(`Exact target=.*${turn.scenarioId}`));
  }
});

test('eligibility uses each scenario mode, exact Tool surface, and exact fixture capability', async () => {
  const value = await manifest();
  const architecture = value.scenarios[67]!;
  const team = value.scenarios[68]!;
  const connector = value.scenarios[91]!;
  const snapshot = (overrides: Partial<Parameters<typeof assessScenarioEligibility>[1]> = {}) => ({
    mode: 'general' as const,
    securityProfile: 'safe' as const,
    advertisedTools: [] as string[],
    enabledFixtureCapabilities: [] as string[],
    source: 'run-finalization' as const,
    ...overrides,
  });
  assert.match(assessScenarioEligibility(architecture, snapshot({
    advertisedTools: ['delegate_architecture'],
  })).reasons.join('\n'), /required plan/u);
  assert.equal(assessScenarioEligibility(architecture, snapshot({
    mode: 'plan',
    advertisedTools: ['delegate_architecture'],
  })).eligible, true);
  assert.match(assessScenarioEligibility(team, snapshot({
    advertisedTools: ['run_team'],
  })).reasons.join('\n'), /required ultra/u);
  assert.equal(assessScenarioEligibility(team, snapshot({
    mode: 'ultra',
    advertisedTools: ['run_team'],
  })).eligible, true);
  assert.match(assessScenarioEligibility(connector, snapshot({
    securityProfile: 'workstation',
    advertisedTools: connector.runtimeContract.allowedTools,
  })).reasons.join('\n'), /fixture capability fixture-092/u);
  assert.equal(assessScenarioEligibility(connector, snapshot({
    securityProfile: 'workstation',
    advertisedTools: connector.runtimeContract.allowedTools,
    enabledFixtureCapabilities: ['fixture-092'],
  })).eligible, true);
  assert.match(assessScenarioEligibility(architecture, snapshot({
    mode: 'plan',
    advertisedTools: ['delegate_architecture', 'web_search'],
  })).reasons.join('\n'), /outside the scenario allowlist.*web_search/u);
});

test('manifest Tool expectations fail closed against the frozen advertised snapshot', async () => {
  const value = await manifest();
  const unknown = structuredClone(value);
  unknown.scenarios[0]!.toolExpectation = { mode: 'all', names: ['made_up_tool'] };
  unknown.scenarios[0]!.expectedTools = ['made_up_tool'];
  assert.throws(() => parseConversationManifest(unknown), /unknown advertised Tool made_up_tool/);
  for (const scenario of value.scenarios.filter((item) => item.lane !== 'V')) {
    assert.ok(scenario.forbiddenTools.includes('run_shell'));
    assert.ok(scenario.forbiddenTools.includes('inspect_processes'));
  }
  assert.ok(value.advertisedTools.includes('computer_act'));
  assert.ok(value.advertisedTools.includes('connector_action'));
  assert.equal(value.advertisedTools.includes('shell'), false);
  assert.equal(value.advertisedTools.includes('process'), false);
  assert.equal(value.advertisedTools.includes('undo_file'), false);
  const policy = await readFile(path.join(repositoryRoot, 'src', 'runtime', 'tool-policy.ts'), 'utf8');
  const referenced = new Set(value.scenarios.flatMap((scenario) => [
    ...scenario.expectedTools,
    ...scenario.expectedToolsAnyOf,
    ...scenario.toolExpectation.names,
    ...scenario.forbiddenTools,
  ]));
  for (const name of referenced) {
    assert.match(policy, new RegExp(`^\\s{2}${name}:`, 'mu'), `${name} is not a production Tool policy name`);
  }
});

test('resume excludes every dispatched turn and exposes incomplete dispatch as uncertain', async () => {
  const value = await manifest();
  const scenario = value.scenarios[7]!;
  const planned = [1, 2, 3, 4].map((turn) => materializeConversationTurn(value, scenario, turn));
  const journal: ConversationJournalRecord[] = [
    { kind: 'turn_dispatch_started', scenarioId: scenario.scenarioId, turn: 1 },
    { kind: 'turn_proof', scenarioId: scenario.scenarioId, turn: 1 },
    { kind: 'turn_dispatch_started', scenarioId: scenario.scenarioId, turn: 2 },
    { kind: 'turn_dispatch_started', scenarioId: scenario.scenarioId, turn: 3 },
    { kind: 'turn_unproven', scenarioId: scenario.scenarioId, turn: 3 },
  ];
  const resumed = deriveConversationResumeState(planned, journal);
  assert.deepEqual(resumed.pending.map((turn) => turn.turn), [4]);
  assert.deepEqual(resumed.uncertain.map((turn) => turn.turn), [2]);
  assert.deepEqual(resumed.terminal.map((turn) => turn.turn), [1, 3]);
  assert.throws(() => deriveConversationResumeState(planned, [
    journal[0]!,
    { kind: 'turn_dispatch_started', scenarioId: scenario.scenarioId, turn: 1 },
  ]), /re-dispatched/);
});

test('a turn is proven only with CLI, Run usage, Trace order, Session protocol, and leak evidence', async () => {
  const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), 'mimi-conversation-evidence-'));
  const value = await manifest();
  const scenario = {
    ...value.scenarios[10]!,
    toolExpectation: { mode: 'any' as const, names: ['read_file'] },
  };
  const turn = materializeConversationTurn(value, scenario, 1);
  const rawTerminal = `raw terminal ${turn.nonce}`;
  const normalizedTerminal = `Mimi terminal answer ${turn.nonce}`;
  const event = { id: 'event-1', payload: { prompt: turn.prompt } };
  const task = {
    taskId: 'task-1', authorityEventId: 'event-1',
    sessionId: 'conv-session-008', status: 'completed',
  };
  const run = {
    id: 'daemon-run-1', taskId: 'task-1', sessionKey: 'conv-session-008',
    status: 'completed',
    answer: {
      usage: { runInputTokens: 31, runOutputTokens: 7 },
      finalization: { outcome: 'completed' },
    },
  };
  const sessionDelta = [
    { role: 'user', content: turn.prompt },
    { type: 'function_call', callId: 'call-1', name: 'read_file', arguments: '{}' },
    { type: 'function_call_result', callId: 'call-1', name: 'read_file', output: 'ok' },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `done ${turn.nonce}` }] },
  ];
  const sessionSnapshot = { items: sessionDelta };
  const expectedAdvertisedTools = ['read_file'];
  const traceDelta = [
    { sessionId: 'conv-session-008', type: 'turn_start', data: { input: turn.prompt } },
    {
      sessionId: 'conv-session-008',
      type: 'model_binding_event',
      data: { workUnitKind: 'conversation', workUnitId: 'runtime-run-1' },
    },
    {
      sessionId: 'conv-session-008',
      type: 'model_tool_surface',
      data: {
        phase: 'before_model_dispatch',
        runId: 'runtime-run-1',
        advertisedTools: expectedAdvertisedTools,
        advertisedToolCount: 1,
        toolSetDigest: `sha256:${sha256(JSON.stringify(expectedAdvertisedTools))}`,
      },
    },
    { sessionId: 'conv-session-008', type: 'turn_end', data: { answer: `done ${turn.nonce}` } },
  ];
  const artifact = async (name: string, content: string) => {
    await writeFile(path.join(evidenceRoot, name), content, { mode: 0o600 });
    return { path: name, sha256: sha256(content), bytes: Buffer.byteLength(content) };
  };
  const jsonArtifact = (name: string, entity: unknown) => artifact(name, `${JSON.stringify(entity, null, 2)}\n`);
  await Promise.all([
    writeFile(path.join(evidenceRoot, 'turn.raw.ansi'), rawTerminal, { mode: 0o600 }),
    writeFile(path.join(evidenceRoot, 'turn.txt'), normalizedTerminal, { mode: 0o600 }),
  ]);
  const evidence = {
    scenario,
    turn,
    sessionId: 'conv-session-008',
    eventId: 'event-1',
    taskId: 'task-1',
    daemonRunId: 'daemon-run-1',
    runtimeRunId: 'runtime-run-1',
    cliExitCode: 0,
    cliTimedOut: false,
    event,
    task,
    run,
    sessionSnapshot,
    sessionDelta,
    traceDelta,
    expectedAdvertisedTools,
    evidenceRoot,
    entityArtifacts: {
      event: await jsonArtifact('event.json', event),
      task: await jsonArtifact('task.json', task),
      run: await jsonArtifact('run.json', run),
      session: await jsonArtifact('session.json', sessionSnapshot),
      trace: await jsonArtifact('trace.json', traceDelta),
    },
    terminal: {
      rawPath: 'turn.raw.ansi',
      rawSha256: sha256(rawTerminal),
      rawBytes: Buffer.byteLength(rawTerminal),
      normalizedPath: 'turn.txt',
      normalizedSha256: sha256(normalizedTerminal),
      normalizedBytes: Buffer.byteLength(normalizedTerminal),
      normalizedText: normalizedTerminal,
    },
    oraclePassed: true,
    leaks: {
      pendingTask: false,
      pendingOutbox: false,
      activeSessionRun: false,
      sourceTreeChanged: false,
    },
  };
  try {
    const result = await auditConversationTurnEvidence(evidence);
    assert.equal(result.proven, true, result.reasons.join('\n'));
    assert.equal(result.usage.inputTokens, 31);
    assert.equal(result.usage.outputTokens, 7);

    const unproven = await auditConversationTurnEvidence({
      ...evidence,
      task: { ...task, authorityEventId: 'wrong-event' },
      sessionDelta: [sessionDelta[0], sessionDelta[2], sessionDelta[1], sessionDelta[3]],
      traceDelta: traceDelta.filter((entry) => entry.type !== 'model_tool_surface'),
      terminal: { ...evidence.terminal, rawSha256: 'a'.repeat(64) },
      leaks: { ...evidence.leaks, pendingOutbox: true },
    });
    assert.equal(unproven.proven, false);
    assert.match(unproven.reasons.join('\n'), /authorityEventId/);
    assert.match(unproven.reasons.join('\n'), /does not follow its call/);
    assert.match(unproven.reasons.join('\n'), /model tool surface/);
    assert.match(unproven.reasons.join('\n'), /digest does not match/);
    assert.match(unproven.reasons.join('\n'), /pendingOutbox/);
  } finally {
    await rm(evidenceRoot, { recursive: true, force: true });
  }
});

test('Task evidence identity accepts the Daemon inspection projection and rejects conflicts', () => {
  assert.deepEqual(conversationTaskEvidenceIdentity({
    taskId: 'task-1',
    authorityEventId: 'event-1',
    sessionId: 'session-1',
  }), {
    taskId: 'task-1',
    eventId: 'event-1',
    sessionId: 'session-1',
  });
  assert.deepEqual(conversationTaskEvidenceIdentity({
    taskId: 'task-1', id: 'different-task',
    authorityEventId: 'event-1', triggerEventId: 'different-event',
    sessionId: 'session-1', sessionKey: 'different-session',
  }), {
    taskId: undefined,
    eventId: undefined,
    sessionId: undefined,
  });
});

test('conversation USD estimate includes the just-finished turn', () => {
  assert.ok(Math.abs((estimateConversationUsd(3183, 1087, 50, 200) ?? 0) - 0.37655) < 1e-12);
  assert.equal(estimateConversationUsd(3183, 1087, undefined, 200), undefined);
});

test('terminal evidence is normalized and secrets are stopped before persistence', () => {
  const secret = 'provider-secret-fixture-value-123456789';
  const redacted = redactTerminalSecrets(`\x1b[31manswer\x1b[0m ${secret}\rnext`, [secret]);
  assert.ok(redacted.hits >= 1);
  assert.doesNotMatch(redacted.text, /provider-secret-fixture/u);
  assert.equal(stripTerminalControl(redacted.text), 'answer <redacted-provider-secret>\nnext');
});

test('PTY assistant proof uses protocol text and byte offsets instead of metadata or UTF-16 indexes', () => {
  const nonce = 'NONCE=mimi-0123456789abcdef';
  const answer = `这是终端必须真实显示的完整回答，不能由输入回显代替。\n${nonce}`;
  const extracted = assistantTextForNonce([{
    type: 'message',
    role: 'assistant',
    content: [{
      type: 'output_text',
      text: answer,
      providerData: { label: 'metadata-must-not-enter-answer' },
    }],
  }], nonce);
  assert.equal(extracted, answer);

  const prefix = Buffer.from('中文前缀\x1b[31m');
  const rendered = Buffer.from(`┊  这是终端必须真实显示的完整回答，\n┊  不能由输入回显代替。\n${nonce}\x1b[0m`);
  const raw = Buffer.concat([prefix, rendered, Buffer.from('尾部')]);
  assert.equal(terminalBytesContainAssistant(
    raw,
    prefix.byteLength,
    prefix.byteLength + rendered.byteLength,
    answer,
    `请确认终端输出，但不要复述答案。${nonce}`,
  ), true);

  const echoedPrompt = `输入中已经包含这段文字，因此不能把回显当作助手回答。${nonce}`;
  assert.equal(terminalBytesContainAssistant(
    Buffer.from(echoedPrompt),
    0,
    Buffer.byteLength(echoedPrompt),
    echoedPrompt,
    echoedPrompt,
  ), false);
});

test('runner uses only the built CLI boundary and Python stdlib PTY helper', async () => {
  const [runner, pty] = await Promise.all([
    readFile(path.join(repositoryRoot, 'scripts', 'run-conversation-soak.ts'), 'utf8'),
    readFile(path.join(repositoryRoot, 'scripts', 'run-conversation-pty.py'), 'utf8'),
  ]);
  assert.doesNotMatch(runner, /from ['"]\.\.\/src\//u);
  assert.doesNotMatch(runner, /FileSession|MimiStore|MimiHost|\.submit\(/u);
  assert.match(runner, /dist', 'index\.js'/u);
  assert.match(runner, /daemon', 'run'/u);
  assert.match(runner, /MIMI_DAEMON_SUPERVISOR/u);
  assert.match(pty, /^import pty$/mu);
  assert.match(pty, /os\.isatty\(0\)/u);
  assert.match(pty, /write_all\(master_fd, BRACKETED_PASTE_START\)[\s\S]+write_all\(master_fd, BRACKETED_PASTE_END\)[\s\S]+time\.sleep\(0\.05\)[\s\S]+write_all\(master_fd, b"\\r"\)/u);
  assert.match(pty, /def write_all\(descriptor, value\):/u);
  assert.match(pty, /def dispatch_action\(master_fd, action, args\):[\s\S]+append_dispatch_started\(args\.journal, action\)[\s\S]+submit_action\(master_fd, action\)/u);
  assert.match(pty, /os\.O_WRONLY \| os\.O_CREAT \| os\.O_APPEND/u);
  assert.match(pty, /os\.fsync\(descriptor\)[\s\S]+os\.fsync\(directory\)/u);
  assert.match(runner, /MIMI_CONVERSATION_RUN_POLICY: 'benchmark-no-tools-v1'/u);
  assert.match(runner, /MIMI_MEMORY_RETRIEVAL_MODE: 'lexical'/u);
  assert.match(runner, /MIMI_CONVERSATION_PROVIDER_ENV_ALLOWLIST is forbidden/u);
  assert.match(runner, /new DurableJournalWriter\(journalFile\)/u);
  assert.match(runner, /new MonotonicCheckpointWriter\(checkpointFile\)/u);
  assert.match(runner, /journalWriter\.dispatchBarrier\(\(\) => captureCliTurn/u);
  assert.match(runner, /createEphemeralCredentialFile/u);
  assert.match(runner, /projectConversationProviderConfigJson/u);
  assert.match(runner, /const values: NodeJS\.ProcessEnv = \{\};/u);
  assert.doesNotMatch(runner, /path\.join\(configRoot, '\.env'\)/u);
  assert.match(runner, /kind: 'turn_dispatch_started',[\s\S]{0,900}dispatchBarrier\(\(\) => captureCliTurn/u);
  assert.match(runner, /calibration proof mismatch/u);
  assert.match(runner, /formalDenominatorTurns: 0/u);
  assert.match(runner, /digestTree\(path\.join\(repositoryRoot, 'dist'\)\)/u);
  assert.match(runner, /durableIoFile/u);
  assert.match(runner, /providerConfigFile/u);
  assert.match(runner, /runtimeIntegrityFile/u);
  assert.match(runner, /snapshotRuntimeDependencyTree/u);
  assert.match(runner, /assertRuntimeDependencySnapshot/u);
  assert.match(runner, /P0 runtime closure changed/u);
  assert.match(runner, /real Provider modes require a clean build; --skip-build is forbidden/u);
  assert.doesNotMatch(runner, /streamCandidateObserved/u);
  assert.match(pty, /transportChunksObserved/u);
});

test('real Provider runner modes reject --skip-build before credentials or dispatch', async () => {
  const runner = path.join(repositoryRoot, 'scripts', 'run-conversation-soak.ts');
  await assert.rejects(
    execFileAsync(process.execPath, [
      '--import', 'tsx', runner,
      '--mode', 'calibrate',
      '--skip-build',
    ], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
      },
    }),
    /real Provider modes require a clean build; --skip-build is forbidden/u,
  );
});

test('PTY helper rejects input-echo completion and cannot pass a flooded action list', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-pty-contract-'));
  try {
    const helper = path.join(repositoryRoot, 'scripts', 'run-conversation-pty.py');
    const credentialFile = path.join(root, '.env');
    await writeFile(credentialFile, 'TEST_PROVIDER_KEY="synthetic-test-provider-key"\n', { mode: 0o600 });
    const invalidActions = path.join(root, 'invalid-actions.json');
    await writeFile(invalidActions, JSON.stringify([
      { kind: 'model_turn', text: '输入里已经有完成', waitFor: '完成' },
      { kind: 'terminal_action', text: '/exit', waitForExit: true },
    ]), { mode: 0o600 });
    await assert.rejects(execFileAsync('python3', [
      helper,
      '--actions', invalidActions,
      '--transcript', path.join(root, 'invalid.raw'),
      '--result', path.join(root, 'invalid.json'),
      '--session-id', 'test-session',
      '--', '/usr/bin/true', 'fake-dist-index.js',
    ], { cwd: root, encoding: 'utf8' }), /waitFor occurs in its input echo/u);

    const floodedActions = path.join(root, 'flooded-actions.json');
    const floodedResult = path.join(root, 'flooded-result.json');
    const floodedJournal = path.join(root, 'flooded-evidence.jsonl');
    await writeFile(floodedActions, JSON.stringify([
      ...Array.from({ length: 30 }, (_, index) => ({
        kind: 'model_turn', text: `SCENE=test TURN=${index + 1} NONCE=input-echo-${index + 1}`,
        scenarioId: 'conv-test',
        turn: index + 1,
        nonce: `input-echo-${index + 1}`,
        sessionId: 'test-session',
        evidenceKind: 'soak',
        timeoutMs: 50,
      })),
      { kind: 'terminal_action', text: '/exit', waitForExit: true, timeoutMs: 50 },
    ]), { mode: 0o600 });
    await assert.rejects(execFileAsync('python3', [
      helper,
      '--actions', floodedActions,
      '--transcript', path.join(root, 'flooded.raw'),
      '--result', floodedResult,
      '--journal', floodedJournal,
      '--session-id', 'test-session',
      '--startup-timeout-ms', '50',
      '--', '/usr/bin/true', 'fake-dist-index.js',
    ], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        MIMI_CONVERSATION_SECRET_NAMES: 'TEST_PROVIDER_KEY',
        MIMI_ENV_FILE: credentialFile,
      },
    }));
    const result = JSON.parse(await readFile(floodedResult, 'utf8')) as {
      passed: boolean;
      actions: unknown[];
      exitCode: number | null;
    };
    assert.equal(result.passed, false);
    assert.equal(result.actions.length, 0);
    assert.equal(result.exitCode, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('PTY exact-secret redaction reads only the private selected env record and fails closed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-pty-secret-redaction-'));
  try {
    const helper = path.join(repositoryRoot, 'scripts', 'run-conversation-pty.py');
    const credentialFile = path.join(root, '.env');
    const secret = 'friday-value-without-generic-token-shape!';
    await writeFile(credentialFile, `FRIDAY_API_KEY=${JSON.stringify(secret)}\n`, { mode: 0o600 });
    const program = String.raw`
import importlib.util
import json
import os

spec = importlib.util.spec_from_file_location("mimi_pty", os.environ["PTY_HELPER"])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
secrets = module.secret_values()
sanitized, hits = module.redact(b"prefix:" + secrets[0] + b":suffix", secrets)
passed = module.proof_passed(None, 0, True, hits, [{"modelRun": {"provenTerminal": True}}])
print(json.dumps({"hits": hits, "leaked": secrets[0] in sanitized, "passed": passed}))
`;
    const environment = {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: '1',
      PTY_HELPER: helper,
      MIMI_CONVERSATION_SECRET_NAMES: 'FRIDAY_API_KEY',
      MIMI_ENV_FILE: credentialFile,
    };
    const { stdout } = await execFileAsync('python3', ['-c', program], {
      cwd: root,
      encoding: 'utf8',
      env: environment,
    });
    assert.deepEqual(JSON.parse(stdout), { hits: 1, leaked: false, passed: false });
    assert.doesNotMatch(stdout, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));

    await chmod(credentialFile, 0o644);
    await assert.rejects(
      execFileAsync('python3', ['-c', program], { cwd: root, encoding: 'utf8', env: environment }),
      /permissions or link count are invalid/u,
    );
    await chmod(credentialFile, 0o600);
    await assert.rejects(
      execFileAsync('python3', ['-c', program], {
        cwd: root,
        encoding: 'utf8',
        env: { ...environment, MIMI_ENV_FILE: path.join(root, 'missing.env') },
      }),
      /FileNotFoundError|No such file or directory/u,
    );
    await assert.rejects(
      execFileAsync('python3', ['-c', program], {
        cwd: root,
        encoding: 'utf8',
        env: { ...environment, MIMI_CONVERSATION_SECRET_NAMES: 'FRIDAY_API_KEY,SECOND_KEY' },
      }),
      /exactly one valid declared Provider secret name/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('PTY dispatch journal is durable, private, ordered, and fail-closed before input', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-pty-journal-'));
  try {
    const helper = path.join(repositoryRoot, 'scripts', 'run-conversation-pty.py');
    const journal = path.join(root, 'evidence.jsonl');
    const program = String.raw`
import importlib.util
import json
import os
import types

spec = importlib.util.spec_from_file_location("mimi_pty", os.environ["PTY_HELPER"])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
action = {
    "kind": "model_turn",
    "text": "hello",
    "scenarioId": "conv-001",
    "turn": 1,
    "nonce": "nonce-001",
    "sessionId": "session-001",
    "evidenceKind": "soak",
}
submitted = []
def observe_submit(*_):
    with open(os.environ["JOURNAL"], encoding="utf-8") as journal:
        submitted.append(journal.read())
module.submit_action = observe_submit
module.dispatch_action(-1, action, types.SimpleNamespace(journal=os.environ["JOURNAL"]))
if not submitted or '"kind":"turn_dispatch_started"' not in submitted[0]:
    raise AssertionError("PTY input was submitted before the durable journal record was observable")
failed_submitted = []
module.append_dispatch_started = lambda *_: (_ for _ in ()).throw(OSError("injected journal failure"))
module.submit_action = lambda *_: failed_submitted.append(True)
try:
    module.dispatch_action(-1, action, types.SimpleNamespace(journal=os.environ["JOURNAL"]))
except OSError:
    pass
else:
    raise AssertionError("injected journal failure did not propagate")
if failed_submitted:
    raise AssertionError("PTY input was submitted after journal failure")
print(json.dumps({"ordered": len(submitted), "submittedAfterFailure": len(failed_submitted)}))
`;
    const { stdout } = await execFileAsync('python3', ['-c', program], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: '1',
        PTY_HELPER: helper,
        JOURNAL: journal,
      },
    });
    assert.deepEqual(JSON.parse(stdout), { ordered: 1, submittedAfterFailure: 0 });
    const bytes = await readFile(journal, 'utf8');
    const records = bytes.trimEnd().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(records.map(({ occurredAt: _occurredAt, ...record }) => record), [{
      kind: 'turn_dispatch_started',
      scenarioId: 'conv-001',
      turn: 1,
      nonce: 'nonce-001',
      sessionId: 'session-001',
      evidenceKind: 'soak',
      denominatorEligible: false,
    }]);
    assert.equal((await stat(journal)).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
