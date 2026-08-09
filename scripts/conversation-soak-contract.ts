import { createHash } from 'node:crypto';

export const conversationLanes = ['S', 'W', 'F', 'V', 'L'] as const;
export const conversationEvidenceKinds = ['fixture', 'readiness', 'live_action', 'soak'] as const;
export const conversationEntries = ['headless-cli', 'persistent-pty'] as const;
export const conversationModes = ['general', 'plan', 'ultra'] as const;
export const conversationSecurityProfiles = ['safe', 'workstation', 'full-owner'] as const;

export type ConversationLane = typeof conversationLanes[number];
export type ConversationEvidenceKind = typeof conversationEvidenceKinds[number];
export type ConversationEntry = typeof conversationEntries[number];
export type ConversationMode = typeof conversationModes[number];
export type ConversationSecurityProfile = typeof conversationSecurityProfiles[number];

export interface ConversationScenario {
  scenarioId: string;
  ordinal: number;
  suite: string;
  title: string;
  lane: ConversationLane;
  evidenceKind: ConversationEvidenceKind;
  entry: ConversationEntry;
  turnCount: number;
  unattendedEligible: boolean;
  enabledByDefault: boolean;
  effectClass: 'read' | 'temporary-write' | 'fixture-write' | 'vm-write' | 'live-action';
  promptTemplate: string;
  turnActions: string[];
  terminalScript: {
    driver: ConversationEntry;
    beforeModel: string[];
    duringModel: string[];
    afterModel: string[];
  };
  runtimeContract: {
    mode: ConversationMode;
    securityProfile: ConversationSecurityProfile;
    fixtureCapability: string;
    allowedTools: string[];
  };
  fixture: {
    kind: 'none' | 'policy-only' | 'temp-workspace' | 'loopback' | 'dedicated-host';
    id: string;
    setup: string;
    receipt: string;
  };
  machineOracle: {
    kind: string;
    assertions: string[];
  };
  toolExpectation: {
    mode: 'none' | 'all' | 'any';
    names: string[];
  };
  supplemental: boolean;
  oracle: string;
  expectedTools: string[];
  expectedToolsAnyOf: string[];
  forbiddenTools: string[];
  tags: string[];
}

export interface ConversationManifest {
  schemaVersion: 1;
  datasetRevision: string;
  seed: string;
  requiredScenarioCount: number;
  minimumTurnsPerScenario: number;
  minimumScenariosPerSuite: number;
  toolSnapshotRevision: string;
  advertisedTools: string[];
  scenarios: ConversationScenario[];
}

export interface MaterializedTurn {
  key: string;
  scenarioId: string;
  turn: number;
  nonce: string;
  prompt: string;
  action: string;
}

export interface ScenarioCapabilitySnapshot {
  mode: ConversationMode;
  securityProfile: ConversationSecurityProfile;
  advertisedTools: string[];
  enabledFixtureCapabilities: string[];
  source: 'isolated-config' | 'run-finalization';
}

export interface ScenarioEligibility {
  eligible: boolean;
  reasons: string[];
}

export interface ConversationJournalRecord {
  kind: string;
  scenarioId?: string;
  turn?: number;
  [key: string]: unknown;
}

export interface TurnEvidenceInput {
  scenario: ConversationScenario;
  turn: MaterializedTurn;
  sessionId: string;
  eventId: string;
  taskId: string;
  daemonRunId: string;
  runtimeRunId?: string;
  cliExitCode: number | null;
  cliTimedOut: boolean;
  run: unknown;
  sessionDelta: unknown[];
  traceDelta: unknown[];
  terminal: {
    rawPath: string;
    rawSha256: string;
    normalizedPath: string;
    normalizedSha256: string;
    normalizedText: string;
  };
  oraclePassed: boolean;
  leaks: {
    pendingTask: boolean;
    pendingOutbox: boolean;
    activeSessionRun: boolean;
    sourceTreeChanged: boolean;
  };
}

export interface TurnEvidenceAudit {
  proven: boolean;
  reasons: string[];
  toolCalls: string[];
  usage: { inputTokens?: number; outputTokens?: number };
  finalizationOutcome?: string;
}

const scenarioKeys = new Set([
  'scenarioId',
  'ordinal',
  'suite',
  'title',
  'lane',
  'evidenceKind',
  'entry',
  'turnCount',
  'unattendedEligible',
  'enabledByDefault',
  'effectClass',
  'promptTemplate',
  'turnActions',
  'terminalScript',
  'runtimeContract',
  'fixture',
  'machineOracle',
  'toolExpectation',
  'supplemental',
  'oracle',
  'expectedTools',
  'expectedToolsAnyOf',
  'forbiddenTools',
  'tags',
]);

const manifestKeys = new Set([
  'schemaVersion',
  'datasetRevision',
  'seed',
  'requiredScenarioCount',
  'minimumTurnsPerScenario',
  'minimumScenariosPerSuite',
  'toolSnapshotRevision',
  'advertisedTools',
  'scenarios',
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${field} must be an array of strings`);
  }
  return value as string[];
}

function exactKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  if (extra.length) throw new Error(`${label} has unsupported fields: ${extra.join(', ')}`);
}

function scenarioFrom(value: unknown, index: number): ConversationScenario {
  const item = record(value);
  if (!item) throw new Error(`scenarios[${index}] must be an object`);
  exactKeys(item, scenarioKeys, `scenarios[${index}]`);
  const requiredStrings = ['scenarioId', 'suite', 'title', 'promptTemplate', 'oracle'] as const;
  for (const field of requiredStrings) {
    if (typeof item[field] !== 'string' || !item[field].trim()) {
      throw new Error(`scenarios[${index}].${field} must be a non-empty string`);
    }
  }
  if (!/^conv-[0-9]{3}$/.test(String(item.scenarioId))) {
    throw new Error(`scenarios[${index}].scenarioId must match conv-NNN`);
  }
  if (!Number.isSafeInteger(item.ordinal) || Number(item.ordinal) < 1) {
    throw new Error(`scenarios[${index}].ordinal must be a positive integer`);
  }
  if (!Number.isSafeInteger(item.turnCount) || Number(item.turnCount) < 1) {
    throw new Error(`scenarios[${index}].turnCount must be a positive integer`);
  }
  if (!conversationLanes.includes(item.lane as ConversationLane)) {
    throw new Error(`scenarios[${index}].lane is invalid`);
  }
  if (!conversationEvidenceKinds.includes(item.evidenceKind as ConversationEvidenceKind)) {
    throw new Error(`scenarios[${index}].evidenceKind is invalid`);
  }
  if (!conversationEntries.includes(item.entry as ConversationEntry)) {
    throw new Error(`scenarios[${index}].entry is invalid`);
  }
  if (typeof item.unattendedEligible !== 'boolean' || typeof item.enabledByDefault !== 'boolean') {
    throw new Error(`scenarios[${index}] unattended flags must be boolean`);
  }
  if (typeof item.supplemental !== 'boolean') {
    throw new Error(`scenarios[${index}].supplemental must be boolean`);
  }
  const effects = ['read', 'temporary-write', 'fixture-write', 'vm-write', 'live-action'];
  if (!effects.includes(String(item.effectClass))) {
    throw new Error(`scenarios[${index}].effectClass is invalid`);
  }
  const scenario = {
    ...item,
    expectedTools: stringArray(item.expectedTools, `scenarios[${index}].expectedTools`),
    expectedToolsAnyOf: stringArray(item.expectedToolsAnyOf, `scenarios[${index}].expectedToolsAnyOf`),
    forbiddenTools: stringArray(item.forbiddenTools, `scenarios[${index}].forbiddenTools`),
    tags: stringArray(item.tags, `scenarios[${index}].tags`),
    turnActions: stringArray(item.turnActions, `scenarios[${index}].turnActions`),
  } as unknown as ConversationScenario;
  if (scenario.turnActions.length !== scenario.turnCount
    || new Set(scenario.turnActions).size !== scenario.turnCount
    || scenario.turnActions.some((action) => action.length < 12)) {
    throw new Error(`${scenario.scenarioId} must define ${scenario.turnCount} unique, non-trivial turnActions`);
  }
  const terminalScript = record(item.terminalScript);
  if (!terminalScript
    || !conversationEntries.includes(terminalScript.driver as ConversationEntry)
    || terminalScript.driver !== scenario.entry) {
    throw new Error(`${scenario.scenarioId}.terminalScript.driver must match entry`);
  }
  for (const field of ['beforeModel', 'duringModel', 'afterModel'] as const) {
    stringArray(terminalScript[field], `${scenario.scenarioId}.terminalScript.${field}`);
  }
  const fixture = record(item.fixture);
  if (!fixture
    || !['none', 'policy-only', 'temp-workspace', 'loopback', 'dedicated-host'].includes(String(fixture.kind))
    || typeof fixture.id !== 'string'
    || typeof fixture.setup !== 'string'
    || typeof fixture.receipt !== 'string') {
    throw new Error(`${scenario.scenarioId}.fixture is invalid`);
  }
  const runtimeContract = record(item.runtimeContract);
  if (!runtimeContract
    || !conversationModes.includes(runtimeContract.mode as ConversationMode)
    || !conversationSecurityProfiles.includes(runtimeContract.securityProfile as ConversationSecurityProfile)
    || typeof runtimeContract.fixtureCapability !== 'string'
    || !runtimeContract.fixtureCapability.trim()) {
    throw new Error(`${scenario.scenarioId}.runtimeContract is invalid`);
  }
  const expectedSecurity: Record<ConversationLane, ConversationSecurityProfile> = {
    S: 'safe',
    W: 'workstation',
    F: 'workstation',
    V: 'full-owner',
    L: 'full-owner',
  };
  if (runtimeContract.securityProfile !== expectedSecurity[scenario.lane]) {
    throw new Error(`${scenario.scenarioId}.runtimeContract.securityProfile does not match lane ${scenario.lane}`);
  }
  const expectedFixtureCapability = fixture.kind === 'none' ? 'none' : String(fixture.id);
  if (runtimeContract.fixtureCapability !== expectedFixtureCapability) {
    throw new Error(`${scenario.scenarioId}.runtimeContract.fixtureCapability must be ${expectedFixtureCapability}`);
  }
  const allowedTools = stringArray(
    runtimeContract.allowedTools,
    `${scenario.scenarioId}.runtimeContract.allowedTools`,
  );
  if (new Set(allowedTools).size !== allowedTools.length) {
    throw new Error(`${scenario.scenarioId}.runtimeContract.allowedTools must be unique`);
  }
  const oracle = record(item.machineOracle);
  if (!oracle || typeof oracle.kind !== 'string'
    || stringArray(oracle.assertions, `${scenario.scenarioId}.machineOracle.assertions`).length < 3) {
    throw new Error(`${scenario.scenarioId}.machineOracle must define at least three assertions`);
  }
  const expectation = record(item.toolExpectation);
  if (!expectation || !['none', 'all', 'any'].includes(String(expectation.mode))) {
    throw new Error(`${scenario.scenarioId}.toolExpectation is invalid`);
  }
  const expectationNames = stringArray(expectation.names, `${scenario.scenarioId}.toolExpectation.names`);
  if ((expectation.mode === 'none') !== (expectationNames.length === 0)) {
    throw new Error(`${scenario.scenarioId}.toolExpectation mode/names disagree`);
  }
  if (!scenario.promptTemplate.startsWith('SCENE={{SCENE}} TURN={{TURN}} NONCE={{NONCE}}')) {
    throw new Error(`${scenario.scenarioId} promptTemplate must begin with the evidence marker`);
  }
  if (scenario.promptTemplate.trimStart().startsWith('/')) {
    throw new Error(`${scenario.scenarioId} promptTemplate cannot be a slash command`);
  }
  if (scenario.lane === 'V' || scenario.lane === 'L') {
    if (scenario.unattendedEligible || scenario.enabledByDefault) {
      throw new Error(`${scenario.scenarioId} lane ${scenario.lane} must be disabled unattended`);
    }
    if (!scenario.supplemental) throw new Error(`${scenario.scenarioId} lane ${scenario.lane} must be supplemental`);
  }
  const expectedEffect: Record<ConversationLane, ConversationScenario['effectClass']> = {
    S: 'read',
    W: 'temporary-write',
    F: 'fixture-write',
    V: 'vm-write',
    L: 'live-action',
  };
  if (scenario.effectClass !== expectedEffect[scenario.lane]) {
    throw new Error(`${scenario.scenarioId} effectClass does not match lane ${scenario.lane}`);
  }
  if (scenario.lane === 'F' && scenario.evidenceKind !== 'fixture') {
    throw new Error(`${scenario.scenarioId} fixture lane must use fixture evidence`);
  }
  if (scenario.lane === 'L' && scenario.evidenceKind !== 'live_action') {
    throw new Error(`${scenario.scenarioId} live lane must use live_action evidence`);
  }
  return scenario;
}

export function parseConversationManifest(value: unknown): ConversationManifest {
  const input = record(value);
  if (!input) throw new Error('conversation manifest must be an object');
  exactKeys(input, manifestKeys, 'manifest');
  if (input.schemaVersion !== 1) throw new Error('manifest.schemaVersion must be 1');
  for (const field of ['datasetRevision', 'seed'] as const) {
    if (typeof input[field] !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,119}$/.test(input[field])) {
      throw new Error(`manifest.${field} is invalid`);
    }
  }
  if (typeof input.toolSnapshotRevision !== 'string'
    || !/^[a-z0-9][a-z0-9._-]{0,119}$/.test(input.toolSnapshotRevision)) {
    throw new Error('manifest.toolSnapshotRevision is invalid');
  }
  const advertisedTools = stringArray(input.advertisedTools, 'manifest.advertisedTools');
  if (!advertisedTools.length || advertisedTools.length !== new Set(advertisedTools).size) {
    throw new Error('manifest.advertisedTools must be non-empty and unique');
  }
  for (const field of ['requiredScenarioCount', 'minimumTurnsPerScenario', 'minimumScenariosPerSuite'] as const) {
    if (!Number.isSafeInteger(input[field]) || Number(input[field]) < 1) {
      throw new Error(`manifest.${field} must be a positive integer`);
    }
  }
  if (!Array.isArray(input.scenarios)) throw new Error('manifest.scenarios must be an array');
  const manifest = {
    ...input,
    scenarios: input.scenarios.map(scenarioFrom),
  } as unknown as ConversationManifest;
  if (manifest.requiredScenarioCount < 100 || manifest.scenarios.length < manifest.requiredScenarioCount) {
    throw new Error('conversation manifest must contain at least 100 scenarios');
  }
  if (manifest.minimumTurnsPerScenario < 30) {
    throw new Error('minimumTurnsPerScenario must be at least 30');
  }
  const advertised = new Set(manifest.advertisedTools);
  const ids = new Set<string>();
  const ordinals = new Set<number>();
  const suites = new Map<string, number>();
  for (const scenario of manifest.scenarios) {
    if (ids.has(scenario.scenarioId)) throw new Error(`duplicate scenarioId ${scenario.scenarioId}`);
    if (ordinals.has(scenario.ordinal)) throw new Error(`duplicate scenario ordinal ${scenario.ordinal}`);
    ids.add(scenario.scenarioId);
    ordinals.add(scenario.ordinal);
    suites.set(scenario.suite, (suites.get(scenario.suite) ?? 0) + 1);
    if (scenario.turnCount < manifest.minimumTurnsPerScenario) {
      throw new Error(`${scenario.scenarioId} has fewer than ${manifest.minimumTurnsPerScenario} turns`);
    }
    for (const name of [
      ...scenario.expectedTools,
      ...scenario.expectedToolsAnyOf,
      ...scenario.forbiddenTools,
      ...scenario.toolExpectation.names,
      ...scenario.runtimeContract.allowedTools,
    ]) {
      if (!advertised.has(name)) {
        throw new Error(`${scenario.scenarioId} references unknown advertised Tool ${name}`);
      }
    }
  }
  for (let ordinal = 1; ordinal <= 100; ordinal += 1) {
    if (!ordinals.has(ordinal)) throw new Error(`matrix scenario ${ordinal} is missing`);
  }
  if (suites.size < 10) throw new Error('conversation manifest must cover at least 10 suites');
  for (const [suite, count] of suites) {
    if (count < manifest.minimumScenariosPerSuite) {
      throw new Error(`suite ${suite} has only ${count} scenarios`);
    }
  }
  const core = manifest.scenarios.filter((scenario) => !scenario.supplemental);
  if (core.length < 100
    || core.some((scenario) => !['S', 'W', 'F'].includes(scenario.lane))
    || core.some((scenario) => !scenario.unattendedEligible)) {
    throw new Error('at least 100 core scenarios must be unattended-eligible S/W/F lanes');
  }
  return structuredClone(manifest);
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function materializeConversationTurn(
  manifest: ConversationManifest,
  scenario: ConversationScenario,
  turn: number,
): MaterializedTurn {
  if (!Number.isSafeInteger(turn) || turn < 1 || turn > scenario.turnCount) {
    throw new Error(`${scenario.scenarioId} turn ${turn} is outside 1..${scenario.turnCount}`);
  }
  const nonce = `mimi-${sha256(`${manifest.seed}\0${scenario.scenarioId}\0${turn}`).slice(0, 24)}`;
  const action = scenario.turnActions[turn - 1];
  if (!action) throw new Error(`${scenario.scenarioId}/${turn} is missing its action script`);
  const materializedAction = action
    .replaceAll('{{SCENE}}', scenario.scenarioId)
    .replaceAll('{{TURN}}', String(turn))
    .replaceAll('{{NONCE}}', nonce);
  const prompt = scenario.promptTemplate
    .replaceAll('{{SCENE}}', scenario.scenarioId)
    .replaceAll('{{TURN}}', String(turn))
    .replaceAll('{{NONCE}}', nonce);
  const materializedPrompt = prompt.replaceAll('{{ACTION}}', materializedAction);
  if (materializedPrompt.startsWith('/')
    || !materializedPrompt.startsWith(`SCENE=${scenario.scenarioId} TURN=${turn} NONCE=${nonce}`)) {
    throw new Error(`${scenario.scenarioId}/${turn} generated an invalid evidence marker`);
  }
  return {
    key: `${scenario.scenarioId}:${turn}`,
    scenarioId: scenario.scenarioId,
    turn,
    nonce,
    prompt: materializedPrompt,
    action: materializedAction,
  };
}

export function assessScenarioEligibility(
  scenario: ConversationScenario,
  snapshot: ScenarioCapabilitySnapshot,
): ScenarioEligibility {
  const reasons: string[] = [];
  if (snapshot.mode !== scenario.runtimeContract.mode) {
    reasons.push(`mode ${snapshot.mode} does not satisfy required ${scenario.runtimeContract.mode}`);
  }
  if (snapshot.securityProfile !== scenario.runtimeContract.securityProfile) {
    reasons.push(
      `security profile ${snapshot.securityProfile} does not satisfy required ${scenario.runtimeContract.securityProfile}`,
    );
  }
  if (scenario.runtimeContract.fixtureCapability !== 'none'
    && !snapshot.enabledFixtureCapabilities.includes(scenario.runtimeContract.fixtureCapability)) {
    reasons.push(`fixture capability ${scenario.runtimeContract.fixtureCapability} is not enabled`);
  }
  const advertised = new Set(snapshot.advertisedTools);
  const allowed = new Set(scenario.runtimeContract.allowedTools);
  const unexpected = snapshot.advertisedTools.filter((name) => !allowed.has(name));
  if (unexpected.length) {
    reasons.push(`RunPolicy advertised Tools outside the scenario allowlist: ${unexpected.join(', ')}`);
  }
  for (const name of scenario.expectedTools) {
    if (!advertised.has(name)) reasons.push(`required Tool ${name} is not advertised`);
  }
  if (scenario.expectedToolsAnyOf.length
    && !scenario.expectedToolsAnyOf.some((name) => advertised.has(name))) {
    reasons.push(`none of required Tools are advertised: ${scenario.expectedToolsAnyOf.join(', ')}`);
  }
  if (scenario.toolExpectation.mode === 'all') {
    for (const name of scenario.toolExpectation.names) {
      if (!advertised.has(name)) reasons.push(`required Tool ${name} is not advertised`);
    }
  }
  if (scenario.toolExpectation.mode === 'any'
    && !scenario.toolExpectation.names.some((name) => advertised.has(name))) {
    reasons.push(`none of scenario Tools are advertised: ${scenario.toolExpectation.names.join(', ')}`);
  }
  return { eligible: reasons.length === 0, reasons: [...new Set(reasons)] };
}

export function deriveConversationResumeState(
  planned: readonly MaterializedTurn[],
  journal: readonly ConversationJournalRecord[],
): { pending: MaterializedTurn[]; uncertain: MaterializedTurn[]; terminal: MaterializedTurn[] } {
  const started = new Set<string>();
  const terminal = new Set<string>();
  for (const entry of journal) {
    if (!entry.scenarioId || !Number.isSafeInteger(entry.turn)) continue;
    const key = `${entry.scenarioId}:${entry.turn}`;
    if (entry.kind === 'turn_dispatch_started') {
      if (started.has(key)) throw new Error(`journal re-dispatched ${key}`);
      started.add(key);
    }
    if (['turn_proof', 'turn_unproven', 'turn_quarantined', 'turn_ineligible'].includes(entry.kind)) {
      terminal.add(key);
    }
  }
  return {
    pending: planned.filter((turn) => !started.has(turn.key) && !terminal.has(turn.key)),
    uncertain: planned.filter((turn) => started.has(turn.key) && !terminal.has(turn.key)),
    terminal: planned.filter((turn) => terminal.has(turn.key)),
  };
}

function itemType(value: unknown): string | undefined {
  return typeof record(value)?.type === 'string' ? String(record(value)?.type) : undefined;
}

function itemRole(value: unknown): string | undefined {
  return typeof record(value)?.role === 'string' ? String(record(value)?.role) : undefined;
}

function callId(value: unknown): string | undefined {
  const item = record(value);
  const raw = item?.callId ?? item?.call_id;
  return typeof raw === 'string' ? raw : undefined;
}

function toolName(value: unknown): string | undefined {
  const item = record(value);
  return typeof item?.name === 'string' ? item.name : undefined;
}

function protocolText(value: unknown): string {
  return JSON.stringify(value);
}

function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function runFacts(value: unknown): {
  status?: string;
  inputTokens?: number;
  outputTokens?: number;
  finalizationOutcome?: string;
} {
  const run = record(value);
  const answer = record(run?.answer);
  const usage = record(answer?.usage);
  const finalization = record(answer?.finalization);
  return {
    status: typeof run?.status === 'string' ? run.status : undefined,
    inputTokens: numeric(usage?.runInputTokens) ?? numeric(usage?.inputTokens),
    outputTokens: numeric(usage?.runOutputTokens) ?? numeric(usage?.outputTokens),
    finalizationOutcome: typeof finalization?.outcome === 'string' ? finalization.outcome : undefined,
  };
}

export function auditConversationTurnEvidence(input: TurnEvidenceInput): TurnEvidenceAudit {
  const reasons: string[] = [];
  if (input.cliExitCode !== 0) reasons.push(`CLI exit code was ${String(input.cliExitCode)}`);
  if (input.cliTimedOut) reasons.push('CLI timed out');
  for (const [field, value] of Object.entries({
    sessionId: input.sessionId,
    eventId: input.eventId,
    taskId: input.taskId,
    daemonRunId: input.daemonRunId,
  })) {
    if (!value) reasons.push(`${field} is missing`);
  }

  const facts = runFacts(input.run);
  if (facts.status !== 'completed') reasons.push(`Daemon Run status was ${facts.status ?? 'missing'}`);
  if (!facts.inputTokens || facts.inputTokens <= 0) reasons.push('Run input token usage is missing or zero');
  if (!facts.outputTokens || facts.outputTokens <= 0) reasons.push('Run output token usage is missing or zero');
  if (!facts.finalizationOutcome) reasons.push('Run finalization outcome is missing');

  const users = input.sessionDelta.filter((item) => itemRole(item) === 'user');
  const assistants = input.sessionDelta.filter((item) => itemRole(item) === 'assistant');
  if (users.length !== 1 || !protocolText(users[0]).includes(input.turn.nonce)) {
    reasons.push('Session delta does not contain exactly one nonce-bearing user unit');
  }
  if (assistants.length !== 1 || !protocolText(assistants[0]).includes(input.turn.nonce)) {
    reasons.push('Session delta does not contain exactly one nonce-bearing assistant unit');
  }
  const calls = input.sessionDelta.filter((item) => itemType(item) === 'function_call');
  const results = input.sessionDelta.filter((item) => itemType(item) === 'function_call_result');
  const callCounts = new Map<string, number>();
  const resultCounts = new Map<string, number>();
  for (const item of calls) {
    const id = callId(item);
    if (!id) reasons.push('function_call is missing callId');
    else callCounts.set(id, (callCounts.get(id) ?? 0) + 1);
  }
  for (const item of results) {
    const id = callId(item);
    if (!id) reasons.push('function_call_result is missing callId');
    else resultCounts.set(id, (resultCounts.get(id) ?? 0) + 1);
  }
  for (const id of new Set([...callCounts.keys(), ...resultCounts.keys()])) {
    if (callCounts.get(id) !== 1 || resultCounts.get(id) !== 1) {
      reasons.push(`tool protocol pair ${id} is not exactly 1:1`);
    }
  }
  const toolCalls = calls.map(toolName).filter((name): name is string => Boolean(name));
  for (const expected of input.scenario.expectedTools) {
    if (!toolCalls.includes(expected)) reasons.push(`expected tool ${expected} was not called`);
  }
  if (input.scenario.expectedToolsAnyOf.length
    && !input.scenario.expectedToolsAnyOf.some((name) => toolCalls.includes(name))) {
    reasons.push(`none of the expected tools were called: ${input.scenario.expectedToolsAnyOf.join(', ')}`);
  }
  for (const forbidden of input.scenario.forbiddenTools) {
    if (toolCalls.includes(forbidden)) reasons.push(`forbidden tool ${forbidden} was called`);
  }
  const expectation = input.scenario.toolExpectation;
  if (expectation.mode === 'none' && toolCalls.length) {
    reasons.push(`scenario requires no function calls but observed: ${toolCalls.join(', ')}`);
  }
  if (expectation.mode === 'all') {
    for (const expected of expectation.names) {
      if (!toolCalls.includes(expected)) reasons.push(`required Tool ${expected} was not called`);
    }
  }
  if (expectation.mode === 'any'
    && !expectation.names.some((expected) => toolCalls.includes(expected))) {
    reasons.push(`none of required Tools were called: ${expectation.names.join(', ')}`);
  }

  const trace = input.traceDelta.map(record).filter((item): item is Record<string, unknown> => Boolean(item));
  const start = trace.findIndex((entry) => entry.type === 'turn_start'
    && protocolText(entry.data).includes(input.turn.nonce));
  const binding = trace.findIndex((entry, index) => index > start
    && entry.type === 'model_binding_event'
    && record(entry.data)?.workUnitKind === 'conversation');
  const end = trace.findIndex((entry, index) => index > binding && entry.type === 'turn_end');
  if (start < 0) reasons.push('trace delta is missing nonce-bearing turn_start');
  if (binding < 0) reasons.push('trace delta is missing conversation model_binding_event after turn_start');
  if (end < 0) reasons.push('trace delta is missing turn_end after model binding');
  const tracedRunId = binding >= 0 ? record(trace[binding]?.data)?.workUnitId : undefined;
  if (typeof tracedRunId !== 'string') reasons.push('runtime Run id is missing from model binding trace');
  else if (input.runtimeRunId && tracedRunId !== input.runtimeRunId) reasons.push('runtime Run id does not match trace');

  if (!input.terminal.rawPath || !/^[0-9a-f]{64}$/.test(input.terminal.rawSha256)) {
    reasons.push('raw terminal evidence reference is invalid');
  }
  if (!input.terminal.normalizedPath || !/^[0-9a-f]{64}$/.test(input.terminal.normalizedSha256)) {
    reasons.push('normalized terminal evidence reference is invalid');
  }
  if (!input.terminal.normalizedText.includes(input.turn.nonce)) {
    reasons.push('normalized terminal evidence does not contain the nonce');
  }
  if (!input.oraclePassed) reasons.push('scenario state oracle did not pass');
  for (const [name, leaked] of Object.entries(input.leaks)) {
    if (leaked) reasons.push(`leak guard failed: ${name}`);
  }
  return {
    proven: reasons.length === 0,
    reasons,
    toolCalls,
    usage: { inputTokens: facts.inputTokens, outputTokens: facts.outputTokens },
    finalizationOutcome: facts.finalizationOutcome,
  };
}

export function stripTerminalControl(value: string): string {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/gu, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/\r(?!\n)/gu, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
    .replace(/\n{4,}/gu, '\n\n\n');
}

export function redactTerminalSecrets(value: string, secrets: readonly string[]): {
  text: string;
  hits: number;
} {
  let text = value;
  let hits = 0;
  for (const secret of [...new Set(secrets)].filter((item) => item.length >= 8)) {
    if (!text.includes(secret)) continue;
    hits += text.split(secret).length - 1;
    text = text.replaceAll(secret, '<redacted-provider-secret>');
  }
  const patterns = [
    /\bsk-[A-Za-z0-9_-]{16,}\b/gu,
    /\bBearer\s+[A-Za-z0-9._~+\/-]{16,}=*\b/giu,
  ];
  for (const pattern of patterns) {
    text = text.replace(pattern, () => {
      hits += 1;
      return '<redacted-secret-pattern>';
    });
  }
  return { text, hits };
}
