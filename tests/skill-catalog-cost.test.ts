import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { SkillLoader } from '../src/extensions/skills.js';

test('model Skill catalog preserves discovery while dropping diagnostic path cost', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), `mimi-${'long-root-'.repeat(8)}`));
  const root = path.join(parent, 'skills');
  for (let index = 0; index < 20; index += 1) {
    const name = `skill-${index}`;
    const directory = path.join(root, name);
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Handle capability ${index} with bounded evidence.\n---\nUse it.\n`,
    );
  }
  const loader = new SkillLoader(root);
  await loader.load();

  const diagnostic = loader.catalog();
  const modelFacing = loader.catalog(undefined, { includeLocations: false });
  assert.match(modelFacing, /skill-0: Handle capability 0/u);
  assert.match(modelFacing, /skill-19: Handle capability 19/u);
  assert.doesNotMatch(modelFacing, /source:|location:/u);
  assert.ok(Buffer.byteLength(modelFacing) <= Buffer.byteLength(diagnostic) * 0.6);
  assert.match(diagnostic, /location:/u);
});
