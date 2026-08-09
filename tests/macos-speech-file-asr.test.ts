import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { MacOsSpeechFileAsrPort } from '../src/runtime/macos-speech-file-asr.js';

test('macOS file ASR invokes the packaged helper on-device with bounded arguments', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-macos-asr-port-'));
  const log = path.join(root, 'args.jsonl');
  const swift = path.join(root, 'swift.sh');
  const helper = path.join(root, 'recognizer.swift');
  const audio = path.join(root, 'audio.wav');
  await writeFile(helper, '// fixture');
  await writeFile(audio, 'fixture');
  await writeFile(swift, `#!/bin/sh
printf '%s\\037' "$@" > ${JSON.stringify(log)}
printf '%s\\n' '{"receiptVersion":1,"adapter":"macos-speech-framework","adapterVersion":"1","final":true,"text":"hello","charCount":5,"truncated":false,"locale":"en-US","onDevice":true,"segments":[{"startMs":0,"endMs":100,"text":"hello"}],"untrusted":true}'
`);
  await chmod(swift, 0o755);
  const port = new MacOsSpeechFileAsrPort({
    platform: 'darwin',
    swiftPath: swift,
    helperPath: helper,
    timeoutMs: 2_000,
  });

  const receipt = await port.transcribe({
    filePath: audio,
    locale: 'en-US',
    onDevice: true,
    maxChars: 123,
  }) as Record<string, unknown>;

  assert.equal(receipt.text, 'hello');
  assert.deepEqual((await readFile(log, 'utf8')).split('\u001f').slice(0, 7), [
    helper, 'transcribe', audio, 'en-US', 'true', '2', '123',
  ]);
});

test('file ASR fails closed off macOS and bounds timeout/cancellation', async () => {
  const unavailable = new MacOsSpeechFileAsrPort({
    platform: 'linux',
    swiftPath: '/must/not/run',
    helperPath: '/must/not/run',
  });
  await assert.rejects(unavailable.transcribe({
    filePath: '/tmp/audio.wav', locale: 'en-US', onDevice: true, maxChars: 100,
  }), /macOS|darwin/iu);

  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-macos-asr-timeout-'));
  const swift = path.join(root, 'swift.sh');
  const helper = path.join(root, 'recognizer.swift');
  const audio = path.join(root, 'audio.wav');
  await Promise.all([
    writeFile(helper, '// fixture'),
    writeFile(audio, 'fixture'),
    writeFile(swift, '#!/bin/sh\nexec /bin/sleep 10\n'),
  ]);
  await chmod(swift, 0o755);
  const timed = new MacOsSpeechFileAsrPort({
    platform: 'darwin', swiftPath: swift, helperPath: helper, timeoutMs: 100,
  });
  await assert.rejects(timed.transcribe({
    filePath: audio, locale: 'en-US', onDevice: true, maxChars: 100,
  }), /timed out|timeout/iu);

  const controller = new AbortController();
  const cancelled = new MacOsSpeechFileAsrPort({
    platform: 'darwin', swiftPath: swift, helperPath: helper, timeoutMs: 2_000,
  });
  const pending = cancelled.transcribe({
    filePath: audio, locale: 'en-US', onDevice: true, maxChars: 100,
    signal: controller.signal,
  });
  controller.abort(new Error('cancel fixture'));
  await assert.rejects(pending, /cancel fixture/iu);
});

test('file ASR cancellation terminates the helper process group including descendants', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-macos-asr-tree-'));
  const swift = path.join(root, 'swift.sh');
  const helper = path.join(root, 'recognizer.swift');
  const audio = path.join(root, 'audio.wav');
  const descendantPid = path.join(root, 'descendant.pid');
  await Promise.all([
    writeFile(helper, '// fixture'),
    writeFile(audio, 'fixture'),
    writeFile(swift, `#!/bin/sh
/bin/sleep 30 &
printf '%s' "$!" > ${JSON.stringify(descendantPid)}
wait
`),
  ]);
  await chmod(swift, 0o755);
  const port = new MacOsSpeechFileAsrPort({
    platform: 'darwin', swiftPath: swift, helperPath: helper, timeoutMs: 5_000,
  });
  const controller = new AbortController();
  const pending = port.transcribe({
    filePath: audio, locale: 'en-US', onDevice: true, maxChars: 100, signal: controller.signal,
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await readFile(descendantPid, 'utf8').then(() => true).catch(() => false)) break;
    await delay(20);
  }
  const pid = Number.parseInt(await readFile(descendantPid, 'utf8'), 10);
  controller.abort(new Error('cancel helper tree'));
  await assert.rejects(pending, /cancel helper tree/iu);
  let alive = true;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      process.kill(pid, 0);
      await delay(20);
    } catch {
      alive = false;
      break;
    }
  }
  assert.equal(alive, false, `ASR descendant ${pid} survived timeout`);
});
