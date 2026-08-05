import assert from 'node:assert/strict';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { diagnoseWrittenFiles } from '../src/runtime/file-diagnostics.js';

test('post-write diagnostics validate JSON, syntax-only files, missing compiler, and a real TypeScript project', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-file-diagnostics-'));
  const validJson = path.join(root, 'valid.json');
  const invalidJson = path.join(root, 'invalid.json');
  const textFile = path.join(root, 'notes.md');
  const codeFile = path.join(root, 'index.ts');
  await writeFile(validJson, '{"ok":true}\n');
  await writeFile(invalidJson, '{\n');
  await writeFile(textFile, 'notes\n');
  await writeFile(codeFile, 'export const value: number = 1;\n');

  assert.deepEqual(await diagnoseWrittenFiles(root, []), { status: 'unavailable', files: [] });
  const invalid = await diagnoseWrittenFiles(root, [invalidJson]);
  assert.equal(invalid.status, 'issues');
  assert.equal(invalid.command, 'JSON.parse');
  assert.match(invalid.output ?? '', /invalid\.json/);
  assert.equal((await diagnoseWrittenFiles(root, [validJson, validJson])).status, 'clean');
  assert.deepEqual(await diagnoseWrittenFiles(root, [textFile]), {
    status: 'clean',
    command: 'syntax-only',
    files: [textFile],
  });
  const missing = await diagnoseWrittenFiles(root, [codeFile]);
  assert.equal(missing.status, 'unavailable');
  assert.match(missing.output ?? '', /tsc/);

  await mkdir(path.join(root, 'node_modules', '.bin'), { recursive: true });
  await symlink(
    path.join(process.cwd(), 'node_modules', '.bin', 'tsc'),
    path.join(root, 'node_modules', '.bin', 'tsc'),
  );
  await writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext' },
    include: ['index.ts'],
  }));
  const checked = await diagnoseWrittenFiles(root, [codeFile]);
  assert.equal(checked.status, 'clean');
  assert.equal(checked.command, 'tsc --noEmit');
});
