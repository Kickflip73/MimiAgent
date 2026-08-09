import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunContext } from '@openai/agents';
import { ExecutionLedger } from '../src/core/execution-ledger.js';
import type { ProviderDefinition } from '../src/core/model-routing.js';
import { FileSession } from '../src/core/session.js';
import {
  MediaArtifactStore,
  sessionMediaArtifactOwner,
} from '../src/runtime/media-artifact-store.js';
import { createMediaTools, MediaRuntime } from '../src/runtime/media-runtime.js';
import { ModelGateway } from '../src/runtime/model-gateway.js';
import { registerRunMediaEvidence } from '../src/runtime/pipeline/media-evidence-registration.js';
import { withExecutionLedger } from '../src/runtime/tool-ledger.js';
import { WorkUnitModelResolver } from '../src/runtime/work-unit-model-resolver.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, payload: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const chunk = Buffer.alloc(12 + payload.length);
  chunk.writeUInt32BE(payload.length, 0);
  typeBytes.copy(chunk, 4);
  payload.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, payload])), chunk.length - 4);
  return chunk;
}

function largePng(): Buffer {
  const iend = png.subarray(png.length - 12);
  return Buffer.concat([
    png.subarray(0, png.length - 12),
    pngChunk('tEXt', Buffer.alloc(70 * 1024, 0x61)),
    iend,
  ]);
}

function imageProvider(input: {
  id: string;
  transport: 'openai-responses' | 'google-generate-content';
  baseUrl: string;
  apiKeyEnv: string;
  imageInput: boolean;
}): ProviderDefinition {
  return {
    id: input.id,
    label: input.id,
    transport: input.transport,
    baseUrl: input.baseUrl,
    apiKeyEnv: input.apiKeyEnv,
    models: [{
      target: { providerId: input.id, modelId: 'image-model' },
      kind: 'image-generation',
      capabilities: {
        imageInput: input.imageInput,
        imageOutput: true,
        toolCalling: false,
      },
    }],
  };
}

function resolverFor(provider: ProviderDefinition): WorkUnitModelResolver {
  const target = provider.models[0]!.target;
  return new WorkUnitModelResolver({
    providers: [provider],
    routing: {
      globalDefault: target,
      scenarios: {
        'image-generation.default': { candidates: [target] },
        'image-editing.default': { candidates: [target] },
      },
    },
  });
}

test('generate_image rejects raw input before ledger and replays one ref-only CAS result', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-media-ledger-'));
  const source = largePng();
  let providerCalls = 0;
  const server = http.createServer((_request, response) => {
    providerCalls += 1;
    response.writeHead(200, {
      'content-type': 'application/json',
      'x-request-id': 'request-media-ledger',
    });
    response.end(JSON.stringify({ data: [{ b64_json: source.toString('base64') }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  const provider = imageProvider({
    id: 'image-openai',
    transport: 'openai-responses',
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKeyEnv: 'IMAGE_OPENAI_KEY',
    imageInput: false,
  });
  const gateway = new ModelGateway({
    providers: [provider],
    environment: { IMAGE_OPENAI_KEY: 'fixture-key' },
  });
  const resolver = resolverFor(provider);
  const sessionId = 'media-ledger';
  const runId = 'run-media-ledger';
  const session = new FileSession(path.join(root, 'sessions'), sessionId);
  await session.ensure();
  await session.beginRun('generate', runId, 'owner-media-ledger');
  const artifacts = new MediaArtifactStore(path.join(root, 'attachments'));
  const runtime = new MediaRuntime(gateway, resolver, () => ({
    artifacts,
    session,
    runId,
    sessionId,
    profileId: 'owner',
    trust: 'owner',
  }));
  const ledgerFile = path.join(root, 'execution-ledger.json');
  const wrap = (ledger: ExecutionLedger) => withExecutionLedger(
    createMediaTools({ runtime: () => runtime, routeVersion: () => 9 }),
    ledger,
    () => ({ sessionId, runId }),
  )[0]!;
  try {
    const firstLedger = new ExecutionLedger(ledgerFile);
    const firstTool = wrap(firstLedger);
    assert.ok('invoke' in firstTool);
    await assert.rejects(
      firstTool.invoke(
        new RunContext({}),
        JSON.stringify({ prompt: 'legacy edit', image: `data:image/png;base64,${source.toString('base64')}` }),
        { toolCall: { callId: 'call-raw-image' } } as never,
      ),
      /unrecognized|Unrecognized|image/u,
    );
    assert.deepEqual(await firstLedger.listCalls(sessionId, runId), []);

    const first = await firstTool.invoke(
      new RunContext({}),
      JSON.stringify({ prompt: 'draw a durable image' }),
      { toolCall: { callId: 'call-generated-image' } } as never,
    );
    const replayTool = wrap(new ExecutionLedger(ledgerFile));
    assert.ok('invoke' in replayTool);
    const replay = await replayTool.invoke(
      new RunContext({}),
      JSON.stringify({ prompt: 'draw a durable image' }),
      { toolCall: { callId: 'call-generated-image' } } as never,
    );

    assert.deepEqual(replay, first);
    assert.equal(providerCalls, 1);
    const calls = await firstLedger.listCalls(sessionId, runId);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.status, 'succeeded');
    assert.deepEqual(JSON.parse(calls[0]!.argumentsJson), { prompt: 'draw a durable image' });
    const durable = [
      await readFile(ledgerFile, 'utf8'),
      await readFile(path.join(root, 'sessions', `${sessionId}.json`), 'utf8'),
    ].join('\n');
    assert.doesNotMatch(durable, /data:image|output_truncated/u);
    assert.doesNotMatch(durable, new RegExp(source.toString('base64').slice(0, 80), 'u'));
    const result = first as unknown as {
      evidence: { ref: string };
      artifact: { ref: string; sha256: string; bytes: number };
    };
    assert.match(result.evidence.ref, /^media-evidence:sha256:[a-f0-9]{64}$/u);
    assert.equal(result.artifact.sha256, createHash('sha256').update(source).digest('hex'));
    assert.equal(result.artifact.bytes, source.byteLength);
    assert.equal((await session.listMediaEvidence(10)).length, 1);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
  }
});

test('canonical Session preserves tool pairing while redacting hallucinated legacy media payloads', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-media-session-firewall-'));
  const session = new FileSession(path.join(root, 'sessions'), 'media-firewall');
  const inline = `data:image/png;base64,${png.toString('base64')}`;
  await session.addItems([
    {
      type: 'function_call',
      name: 'generate_image',
      callId: 'call-legacy-media',
      arguments: JSON.stringify({ prompt: 'legacy', image: inline }),
    },
    {
      type: 'function_call_result',
      name: 'generate_image',
      callId: 'call-legacy-media',
      output: JSON.stringify({
        artifacts: [{ data: png.toString('base64'), url: 'https://signed.invalid/private', mediaType: 'image/png' }],
      }),
    },
  ] as never[]);

  const durable = await readFile(path.join(root, 'sessions', 'media-firewall.json'), 'utf8');
  assert.doesNotMatch(durable, /data:image|signed\.invalid|iVBOR/u);
  assert.match(durable, /MEDIA_BINARY_REDACTED/);
  assert.match(durable, /MEDIA_URL_REDACTED/);
  const items = await session.getItems();
  assert.deepEqual(items.map((item) => (item as { type: string }).type), [
    'function_call', 'function_call_result',
  ]);
  assert.equal(
    (items[0] as { callId?: string }).callId,
    (items[1] as { callId?: string }).callId,
  );
});

test('restart edit rehydrates exact Session bytes and rejects cross-scope or tampered refs pre-provider', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-media-edit-restart-'));
  const sessionId = 'media-edit';
  const sourceRunId = 'run-source';
  const sessionDirectory = path.join(root, 'sessions');
  const artifactRoot = path.join(root, 'attachments');
  const sourceSession = new FileSession(sessionDirectory, sessionId);
  await sourceSession.ensure();
  await sourceSession.beginRun('attach source', sourceRunId, 'owner-source');
  const sourceStore = new MediaArtifactStore(artifactRoot);
  await writeFile(path.join(root, 'source.png'), png);
  const sourceBatch = await sourceStore.stageBatch([{ path: 'source.png', kind: 'image' }], root, {
    profileId: 'owner',
    workspaceId: 'workspace-A',
    sessionId,
    runId: sourceRunId,
    trust: 'owner',
  });
  const sourceEvidence = sourceBatch.attachments[0]!.evidence!;
  await registerRunMediaEvidence({
    artifacts: sourceStore,
    session: sourceSession,
    evidence: [sourceEvidence],
    runId: sourceRunId,
    sessionId,
    profileId: 'owner',
    workspaceId: 'workspace-A',
    trust: 'owner',
  });
  await sourceBatch.commit(sessionMediaArtifactOwner(sessionId));
  await sourceSession.completeRun('source stored', sourceRunId);

  let providerCalls = 0;
  let requestBody = '';
  const server = http.createServer((request, response) => {
    request.setEncoding('utf8');
    request.on('data', (chunk) => { requestBody += chunk; });
    request.on('end', () => {
      providerCalls += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        responseId: 'google-edit-request',
        candidates: [{ content: { parts: [{
          inlineData: { data: png.toString('base64'), mimeType: 'image/png' },
        }] } }],
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  const provider = imageProvider({
    id: 'image-google',
    transport: 'google-generate-content',
    baseUrl: `http://127.0.0.1:${address.port}/v1beta`,
    apiKeyEnv: 'IMAGE_GOOGLE_KEY',
    imageInput: true,
  });
  const gateway = new ModelGateway({
    providers: [provider],
    environment: { IMAGE_GOOGLE_KEY: 'fixture-key' },
  });
  const resolver = resolverFor(provider);
  const restartedSession = new FileSession(sessionDirectory, sessionId);
  const restartedStore = new MediaArtifactStore(artifactRoot);
  await restartedStore.reconcileEvidenceOwner(
    sessionMediaArtifactOwner(sessionId),
    await restartedSession.listMediaEvidence(1_000),
  );
  const editRunId = 'run-edit';
  await restartedSession.beginRun('edit source', editRunId, 'owner-edit');
  const authority = {
    artifacts: restartedStore,
    session: restartedSession,
    runId: editRunId,
    sessionId,
    profileId: 'owner',
    workspaceId: 'workspace-A',
    trust: 'owner' as const,
  };
  try {
    const runtime = new MediaRuntime(gateway, resolver, () => authority);
    const result = await runtime.run({
      prompt: 'make it brighter',
      mediaEvidenceId: sourceEvidence.id,
      routeVersion: 4,
    });
    assert.equal(providerCalls, 1);
    const request = JSON.parse(requestBody) as {
      contents: Array<{ parts: Array<{ inlineData?: { data?: string } }> }>;
    };
    assert.equal(request.contents[0]?.parts[1]?.inlineData?.data, png.toString('base64'));
    assert.equal(result.operation, 'edit');
    const output = await restartedSession.getMediaEvidence(result.evidence.ref);
    assert.deepEqual(output?.sourceRef.inputEvidenceIds, [sourceEvidence.id]);

    const wrongWorkspace = new MediaRuntime(gateway, resolver, () => ({
      ...authority,
      workspaceId: 'workspace-B',
    }));
    await assert.rejects(wrongWorkspace.run({
      prompt: 'cross workspace', mediaEvidenceId: sourceEvidence.id, routeVersion: 4,
    }), /Workspace/);
    assert.equal(providerCalls, 1);

    const otherSession = new FileSession(sessionDirectory, 'other-session');
    await otherSession.ensure();
    await otherSession.beginRun('steal source', 'run-other', 'owner-other');
    const otherRuntime = new MediaRuntime(gateway, resolver, () => ({
      ...authority,
      session: otherSession,
      sessionId: 'other-session',
      runId: 'run-other',
    }));
    await assert.rejects(otherRuntime.run({
      prompt: 'cross session', mediaEvidenceId: sourceEvidence.id, routeVersion: 4,
    }), /不存在 MediaEvidence/);
    assert.equal(providerCalls, 1);

    await restartedSession.completeRun('edited', editRunId);
    await writeFile(path.join(artifactRoot, sourceEvidence.sha256), Buffer.alloc(sourceEvidence.bytes));
    const tamperRunId = 'run-tamper';
    await restartedSession.beginRun('tampered source', tamperRunId, 'owner-tamper');
    const tamperRuntime = new MediaRuntime(gateway, resolver, () => ({
      ...authority,
      runId: tamperRunId,
    }));
    await assert.rejects(tamperRuntime.run({
      prompt: 'tampered', mediaEvidenceId: sourceEvidence.id, routeVersion: 4,
    }), /摘要不匹配/);
    assert.equal(providerCalls, 1);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
  }
});
