import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  DATA_LIFECYCLE_POLICIES,
  sanitizeSensitiveData,
  scanSensitiveData,
} from '../src/core/data-sanitizer.js';
import { TraceStore } from '../src/core/trace.js';
import { sanitizedMemoryEvidenceSnapshot } from '../src/daemon/memory-evidence.js';
import { MimiStore } from '../src/daemon/store.js';
import { backgroundTaskSummary } from '../src/daemon/task-tools.js';
import { WikiVault } from '../src/extensions/memory/wiki-vault.js';

const fixture = Object.freeze({
  token: 'sk-JRV001FixtureNotARealKey12345',
  email: 'jarvis-fixture@example.test',
  phone: '13800138000',
});

function assertFixtureAbsent(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const raw of Object.values(fixture)) assert.doesNotMatch(serialized, new RegExp(raw));
}

test('sensitive scan reports only category, fingerprint and location', () => {
  const findings = scanSensitiveData({
    objective: `use ${fixture.token} for ${fixture.email}`,
    password: 'fixture-password-value',
  });
  assert.ok(findings.length >= 3);
  assertFixtureAbsent(findings);
  assert.ok(findings.every((finding) => /^.+:sha256:[a-f0-9]{16}$/.test(finding.fingerprint)));
  assert.ok(findings.every((finding) => finding.disposition === 'detected'));
  assert.deepEqual(
    DATA_LIFECYCLE_POLICIES.map((policy) => policy.surface),
    ['task', 'work-unit', 'trace', 'memory', 'management'],
  );
});

test('Task persistence and management WorkUnit views redact sensitive fixtures', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-sensitive-task-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    const now = new Date().toISOString();
    const eventId = randomUUID();
    const routed = store.ingestEvent({
      id: eventId,
      externalId: eventId,
      source: 'test',
      kind: 'command',
      trust: 'owner',
      payload: {
        prompt: `contact ${fixture.email} with ${fixture.token}`,
        credential: fixture.phone,
      },
      occurredAt: now,
      receivedAt: now,
      profileId: 'owner',
      priority: 50,
      sessionKey: 'sensitive-fixture',
      replyRoute: { channel: 'system' },
    });
    const task = routed.task;
    assert.ok(task);
    assertFixtureAbsent(task);
    const listed = store.listTasks();
    assertFixtureAbsent(listed);
    assertFixtureAbsent(backgroundTaskSummary(listed[0]!));
    assert.match(JSON.stringify(listed[0]!.objective), /REDACTED/);

    const claimed = store.claimTaskById(task.id, 'fixture-worker');
    assert.ok(claimed);
    const attempt = store.beginTaskAttempt(
      task.id,
      'fixture-worker',
      'sensitive-fixture',
      'fixture-worker',
    );
    store.blockTask(
      task.id,
      'fixture-worker',
      { answer: `${fixture.email} ${fixture.token}` },
      `failed for ${fixture.phone}`,
      attempt.id,
    );
    assertFixtureAbsent(store.getTask(task.id));
    assertFixtureAbsent(store.getRun(attempt.id));
    assertFixtureAbsent(store.listRunSummaries());
    const schedule = store.addSchedule({
      name: `follow up ${fixture.email}`,
      type: 'at',
      value: 'once',
      prompt: `use ${fixture.token} then call ${fixture.phone}`,
      profileId: 'owner',
      trust: 'owner',
      nextRunAt: '2030-01-01T00:00:00.000Z',
    });
    assertFixtureAbsent(schedule);
    assertFixtureAbsent(store.listScheduleSummaries());

    store.close();
    const database = new DatabaseSync(path.join(root, 'mimi.db'), { readOnly: true });
    try {
      const persisted = {
        task: database.prepare(`
          SELECT objective_json, result_json, error FROM tasks WHERE id = ?
        `).get(task.id),
        run: database.prepare(`
          SELECT answer_json, error FROM runs WHERE id = ?
        `).get(attempt.id),
        management: database.prepare(`
          SELECT name, prompt FROM schedules WHERE id = ?
        `).get(schedule.id),
      };
      assertFixtureAbsent(persisted);
      assert.match(JSON.stringify(persisted), /REDACTED/);
    } finally {
      database.close();
    }
  } finally {
    try {
      store.close();
    } catch {
      // The persistence assertion closes the store before reopening the database read-only.
    }
  }
});

test('Trace and Memory evidence sanitize before writing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-sensitive-trace-'));
  const traces = new TraceStore(path.join(root, 'traces'));
  await traces.record('fixture', 'work_unit', {
    objective: `${fixture.token} ${fixture.phone}`,
    authorization: `Bearer ${fixture.token}`,
  });
  const trace = await readFile(path.join(root, 'traces', 'fixture.jsonl'), 'utf8');
  assertFixtureAbsent(trace);
  assert.match(trace, /REDACTED/);

  const evidence = sanitizedMemoryEvidenceSnapshot(
    { objective: fixture.token },
    { result: fixture.email },
    `failed for ${fixture.phone}`,
  );
  assertFixtureAbsent(evidence);
  assert.match(JSON.stringify(evidence), /REDACTED/);
});

test('non-owner Wiki writes sanitized Memory content and returns the sanitized page', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-sensitive-wiki-'));
  const vault = new WikiVault(path.join(root, 'wiki'), 'private', 'delegate');
  await vault.initialize();
  const now = new Date().toISOString();
  const page = await vault.write({
    schemaVersion: 1,
    id: 'mem_fixture_0001',
    title: `Contact ${fixture.email}`,
    kind: 'fact',
    scope: 'private',
    profileId: 'delegate',
    status: 'active',
    confidence: 'user-confirmed',
    aliases: [],
    tags: [],
    sourceRefs: [{
      type: 'user-explicit',
      id: 'fixture',
      digest: `sha256:${'a'.repeat(64)}`,
      occurredAt: now,
      trust: 'owner',
    }],
    validFrom: null,
    validUntil: null,
    supersedes: [],
    createdAt: now,
    updatedAt: now,
  }, `# Fixture\n\n${fixture.token}\n${fixture.phone}`);
  assertFixtureAbsent(page);
  assert.match(page.body, /REDACTED/);
  assertFixtureAbsent(await vault.read(page.ref));
});

test('owner-private Memory keeps necessary contacts while always redacting credentials', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-private-contact-'));
  const vault = new WikiVault(path.join(root, 'wiki'), 'private', 'owner');
  await vault.initialize();
  const now = new Date().toISOString();
  const page = await vault.write({
    schemaVersion: 1,
    id: 'mem_private_contact_0001',
    title: `Owner contact ${fixture.email}`,
    kind: 'fact',
    scope: 'private',
    profileId: 'owner',
    status: 'active',
    confidence: 'user-confirmed',
    aliases: [],
    tags: [],
    sourceRefs: [{
      type: 'user-explicit',
      id: 'fixture-contact',
      digest: `sha256:${'b'.repeat(64)}`,
      occurredAt: now,
      trust: 'owner',
    }],
    validFrom: null,
    validUntil: null,
    supersedes: [],
    createdAt: now,
    updatedAt: now,
  }, `Reach me at ${fixture.email} or ${fixture.phone}; never keep ${fixture.token}.`);

  assert.match(page.metadata.title, new RegExp(fixture.email));
  assert.match(page.body, new RegExp(fixture.email));
  assert.match(page.body, new RegExp(fixture.phone));
  assert.doesNotMatch(page.body, new RegExp(fixture.token));
  assert.match(page.body, /REDACTED/);
});

test('recursive sanitizer preserves non-sensitive data and handles cycles', () => {
  const value: Record<string, unknown> = {
    safe: 'ordinary content',
    nested: { apiKey: fixture.token },
  };
  value.self = value;
  const sanitized = sanitizeSensitiveData(value);
  assert.equal(sanitized.safe, 'ordinary content');
  assert.equal((sanitized.nested as Record<string, unknown>).apiKey?.toString().includes('REDACTED'), true);
  assert.equal(sanitized.self, '[REDACTED:circular]');
});
