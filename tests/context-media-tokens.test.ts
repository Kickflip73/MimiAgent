import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AgentInputItem } from '@openai/agents';
import { ContextManager, estimateTokens } from '../src/core/context.js';
import { FileSession } from '../src/core/session.js';

function base64PayloadForBytes(bytes: number): string {
  const completeGroups = Math.floor(bytes / 3);
  const remainder = bytes % 3;
  return `${'A'.repeat(completeGroups * 4)}${remainder === 1 ? 'AA==' : remainder === 2 ? 'AAA=' : ''}`;
}

function dataUrl(mediaType: string, bytes: number): string {
  return `data:${mediaType};base64,${base64PayloadForBytes(bytes)}`;
}

function mediaInput(type: 'input_image' | 'input_file', value: string): AgentInputItem[] {
  return [{
    role: 'user',
    content: [{
      type,
      ...(type === 'input_image'
        ? { image: value, detail: 'auto' }
        : { file: value, filename: 'evidence.pdf' }),
    }],
  }] as AgentInputItem[];
}

test('provider-bound image and file data URLs use bounded opaque token estimates at 1/10/20 MiB', () => {
  const manager = new ContextManager(40, 128_000, 0.55, 16_000);
  let previousImageTokens = 0;
  let previousFileTokens = 0;
  for (const mib of [1, 10, 20]) {
    const bytes = mib * 1024 * 1024;
    const imageUrl = dataUrl('image/png', bytes);
    const fileUrl = dataUrl('application/pdf', bytes);
    const image = mediaInput('input_image', imageUrl);
    const file = mediaInput('input_file', fileUrl);
    const imageBefore = JSON.stringify(image);
    const fileBefore = JSON.stringify(file);

    const imageTokens = estimateTokens(image);
    const fileTokens = estimateTokens(file);
    assert.ok(imageTokens > previousImageTokens, `${mib}MiB image estimate must grow by size`);
    assert.ok(fileTokens > previousFileTokens, `${mib}MiB file estimate must grow by size`);
    assert.ok(imageTokens <= 17_000, `${mib}MiB image estimate must stay provider-opaque`);
    assert.ok(fileTokens <= 66_000, `${mib}MiB file estimate must stay provider-opaque`);
    assert.ok(imageTokens < estimateTokens(imageUrl) / 10);
    assert.ok(fileTokens < estimateTokens(fileUrl) / 10);

    const imageView = manager.modelContextView(image, '', 100_000);
    const fileView = manager.modelContextView(file, '', 100_000);
    assert.equal(
      ((imageView.input[0] as { content: Array<{ image?: string }> }).content[0]?.image),
      imageUrl,
    );
    assert.equal(
      ((fileView.input[0] as { content: Array<{ file?: string }> }).content[0]?.file),
      fileUrl,
    );
    assert.equal(JSON.stringify(image), imageBefore, 'estimation must not mutate provider input');
    assert.equal(JSON.stringify(file), fileBefore, 'estimation must not mutate provider input');
    previousImageTokens = imageTokens;
    previousFileTokens = fileTokens;
  }
});

test('only valid typed provider media fields receive opaque accounting', () => {
  const long = dataUrl('image/png', 1024 * 1024);
  const ordinary = 'x'.repeat(1024 * 1024);
  const rawTokens = estimateTokens(long);
  assert.ok(rawTokens > 300_000);
  assert.ok(estimateTokens(mediaInput('input_image', ordinary)) > 250_000);
  assert.ok(estimateTokens([{ role: 'user', content: [{ type: 'input_text', text: long }] }]) > 300_000);
  assert.ok(estimateTokens([{
    type: 'function_call',
    name: 'generate_image',
    callId: 'call-1',
    arguments: JSON.stringify({ image: long }),
  }]) > 300_000);
  assert.ok(estimateTokens(mediaInput('input_image', `${long.slice(0, -1)}!`)) > 300_000);
  assert.ok(estimateTokens(mediaInput(
    'input_file',
    dataUrl('audio/wav', 1024 * 1024),
  )) > 300_000);
});

test('context summaries and canonical Session omit provider-bound binary payloads', async () => {
  const marker = 'UNIQUE_MEDIA_PAYLOAD_MARKER';
  const imageUrl = `data:image/png;base64,${Buffer.from(marker).toString('base64')}`;
  const fileUrl = `data:application/pdf;base64,${Buffer.from(marker).toString('base64')}`;
  const mediaItem = {
    role: 'user',
    content: [
      { type: 'input_text', text: 'inspect both artifacts' },
      { type: 'input_image', image: imageUrl, detail: 'auto' },
      { type: 'input_file', file: fileUrl, filename: 'evidence.pdf' },
    ],
  } as AgentInputItem;
  const history = [
    mediaItem,
    { role: 'assistant', content: 'first answer' },
    { role: 'user', content: 'second question' },
    { role: 'assistant', content: 'second answer' },
    { role: 'user', content: 'third question' },
  ] as AgentInputItem[];
  const manager = new ContextManager(2);
  const summary = manager.summarizeHistory(history);
  assert.doesNotMatch(summary, /data:image|data:application|UNIQUE_MEDIA_PAYLOAD_MARKER/);
  assert.match(summary, /inspect both artifacts/);

  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-media-token-session-'));
  const session = new FileSession(root, 'media-token-session');
  await session.addItems([mediaItem]);
  const durable = await readFile(path.join(root, 'media-token-session.json'), 'utf8');
  assert.doesNotMatch(durable, /data:image|data:application|UNIQUE_MEDIA_PAYLOAD_MARKER/);
  assert.match(durable, /inspect both artifacts/);
});
