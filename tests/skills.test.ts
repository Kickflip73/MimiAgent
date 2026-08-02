import assert from 'node:assert/strict';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunContext } from '@openai/agents';
import type { AppConfig } from '../src/config.js';
import { FileSession } from '../src/core/session.js';
import { parseSkillInvocation } from '../src/extensions/skill-invocation.js';
import { SkillLoader, type SkillSource } from '../src/extensions/skills.js';
import { skillSources } from '../src/runtime/components.js';
import { MimiAgent } from '../src/runtime/mimi-agent.js';

async function writeSkill(
  root: string,
  name: string,
  body = 'Follow these instructions.',
  description = `${name} description`,
): Promise<string> {
  const directory = path.join(root, name);
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, 'SKILL.md');
  await writeFile(file, `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`);
  return file;
}

function source(
  id: SkillSource['id'],
  root: string,
  precedence: number,
  manifest?: string,
): SkillSource {
  return {
    id,
    scope: id === 'configured'
      ? 'configured'
      : id.startsWith('project-') ? 'project' : id.startsWith('user-') ? 'user' : 'builtin',
    root,
    precedence,
    ...(manifest ? { manifest } : {}),
  };
}

test('project skills override user skills and report every shadowed source', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-skills-precedence-'));
  const roots = await Promise.all(['project-native', 'project-shared', 'user-native', 'user-shared']
    .map(async (id) => {
      const directory = path.join(root, id);
      await writeSkill(directory, 'review', id);
      return directory;
    }));
  const loader = new SkillLoader([
    source('project-native', roots[0]!, 1),
    source('project-shared', roots[1]!, 2),
    source('user-native', roots[2]!, 3),
    source('user-shared', roots[3]!, 4),
  ]);

  await loader.load();

  assert.equal(loader.get('review')?.source.id, 'project-native');
  const shadowed = loader.diagnosticDetails().filter((issue) => issue.kind === 'shadowed');
  assert.equal(shadowed.length, 3);
  assert.deepEqual(shadowed.map((issue) => issue.loser?.sourceId), [
    'project-shared',
    'user-native',
    'user-shared',
  ]);
});

test('production source factory preserves configured project user builtin precedence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-skills-production-sources-'));
  const workspace = path.join(root, 'workspace');
  const home = path.join(root, 'home');
  const configured = path.join(root, 'configured');
  await writeSkill(configured, 'custom', 'configured winner');
  await writeSkill(path.join(workspace, 'skills'), 'custom', 'project fallback');
  await writeSkill(path.join(workspace, 'skills'), 'code-review', 'project native winner');
  await writeSkill(path.join(workspace, '.agents', 'skills'), 'code-review', 'project shared');
  await writeSkill(path.join(home, '.mimi-agent', 'skills'), 'code-review', 'user native');
  await writeSkill(path.join(home, '.agents', 'skills'), 'code-review', 'user shared');
  const config = {
    workspaceRoot: workspace,
    skillsRoot: configured,
    skillsRootConfigured: true,
  } as AppConfig;
  const loader = new SkillLoader(skillSources(config, home));

  await loader.load();

  assert.equal(loader.get('custom')?.source.id, 'configured');
  assert.equal(loader.get('code-review')?.source.id, 'project-native');
  assert.deepEqual(
    loader.diagnosticDetails()
      .filter((issue) => issue.kind === 'shadowed' && issue.loser?.name === 'code-review')
      .map((issue) => issue.loser?.sourceId),
    ['project-shared', 'user-native', 'user-shared', 'builtin'],
  );
});

test('builtin skills are package rooted manifest allowlisted and lowest precedence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-skills-builtin-'));
  const project = path.join(root, 'project');
  const builtin = path.join(root, 'builtin');
  await writeSkill(project, 'published', 'project wins');
  await writeSkill(builtin, 'published', 'builtin loses');
  await writeSkill(builtin, 'experimental', 'must not load');
  const manifest = path.join(builtin, 'manifest.json');
  await writeFile(manifest, JSON.stringify({
    schemaVersion: 1,
    skills: [
      { name: 'published', published: true },
      { name: 'experimental', published: false },
    ],
  }));
  const loader = new SkillLoader([
    source('project-native', project, 1),
    source('builtin', builtin, 5, manifest),
  ]);

  await loader.load();

  assert.equal(loader.get('published')?.source.id, 'project-native');
  assert.equal(loader.get('experimental'), undefined);
  assert.equal(loader.diagnosticDetails().filter((issue) => issue.kind === 'shadowed').length, 1);

  const config = {
    workspaceRoot: path.join(root, 'workspace'),
    skillsRoot: path.join(root, 'workspace', 'skills'),
  } as AppConfig;
  const discovered = skillSources(config, path.join(root, 'home'));
  assert.equal(discovered.at(-1)?.id, 'builtin');
  assert.match(discovered.at(-1)?.root ?? '', /\/skills$/);
  assert.notEqual(discovered.at(-1)?.root, path.join(config.workspaceRoot, 'skills'));
});

test('invalid builtin manifest fails closed with a diagnostic', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-skills-manifest-'));
  await writeSkill(root, 'published');
  const manifest = path.join(root, 'manifest.json');
  await writeFile(manifest, '{not-json');
  const loader = new SkillLoader([source('builtin', root, 5, manifest)]);

  await loader.load();

  assert.deepEqual(loader.list(), []);
  assert.match(loader.diagnostics().join('\n'), /manifest 无效/);
});

test('invalid higher precedence candidate does not hide a valid fallback', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-skills-invalid-'));
  const high = path.join(root, 'high');
  const low = path.join(root, 'low');
  await mkdir(path.join(high, 'review'), { recursive: true });
  await writeFile(path.join(high, 'review', 'SKILL.md'), 'not frontmatter');
  await writeSkill(low, 'review', 'valid fallback');
  const loader = new SkillLoader([
    source('configured', high, 0),
    source('user-native', low, 3),
  ]);

  await loader.load();

  assert.equal(loader.get('review')?.source.id, 'user-native');
  assert.match(loader.diagnostics().join('\n'), /缺少 YAML frontmatter/);
});

test('the same canonical skill file is read once without a shadow warning', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-skills-dedupe-'));
  const actual = path.join(root, 'actual');
  const alias = path.join(root, 'alias');
  await writeSkill(actual, 'review');
  await symlink(actual, alias, 'dir');
  const loader = new SkillLoader([
    source('configured', actual, 0),
    source('project-native', alias, 1),
  ]);

  await loader.load();

  assert.equal(loader.list().length, 1);
  assert.equal(loader.diagnosticDetails().filter((issue) => issue.kind === 'shadowed').length, 0);
  assert.equal(loader.get('review')?.source.id, 'configured');
});

test('multi-source discovery order is stable by precedence then directory name', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-skills-order-'));
  const first = path.join(root, 'first');
  const second = path.join(root, 'second');
  await writeSkill(first, 'zeta');
  await writeSkill(first, 'alpha');
  await writeSkill(second, 'middle');
  const loader = new SkillLoader([
    source('user-native', second, 3),
    source('project-native', first, 1),
  ]);

  await loader.load();

  assert.deepEqual(loader.list().map((skill) => skill.name), ['alpha', 'zeta', 'middle']);
});

test('valid skill count and total instruction bytes fail closed with diagnostics', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-skills-limits-'));
  const countRoot = path.join(root, 'count');
  await Promise.all(Array.from({ length: 201 }, (_, index) =>
    writeSkill(countRoot, `skill-${index.toString().padStart(3, '0')}`)));
  const countLoader = new SkillLoader(countRoot);
  await countLoader.load();
  assert.equal(countLoader.list().length, 200);
  assert.match(countLoader.diagnostics().join('\n'), /超过 200/);

  const bytesRoot = path.join(root, 'bytes');
  for (let index = 0; index < 21; index += 1) {
    await writeSkill(
      bytesRoot,
      `large-${index.toString().padStart(2, '0')}`,
      'x'.repeat(499_000),
    );
  }
  const bytesLoader = new SkillLoader(bytesRoot);
  await bytesLoader.load();
  assert.equal(bytesLoader.list().length, 20);
  assert.match(bytesLoader.diagnostics().join('\n'), /总文本超过 10MB/);
});

test('owner leading dollar mentions parse once while untrusted, escaped and inline mentions remain inert', () => {
  assert.deepEqual(parseSkillInvocation('$research $writing-partner $research do it', true), {
    names: ['research', 'writing-partner'],
    prefixLength: 37,
  });
  assert.deepEqual(parseSkillInvocation('please use $research', true).names, []);
  assert.deepEqual(parseSkillInvocation('\\$research literal', true).names, []);
  assert.deepEqual(parseSkillInvocation('$research external', false).names, []);
});

test('repeated activation is idempotent and changed source requires reactivation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-skill-session-'));
  const session = new FileSession(root, 'demo');
  const run = await session.beginRun('activate', 'run-1');
  const base = {
    name: 'review',
    sourceId: 'project-native' as const,
    file: '/canonical/review/SKILL.md',
    contentHash: 'a'.repeat(64),
  };

  assert.equal(await session.activateSkill(base, run.runId), 'activated');
  assert.equal(await session.activateSkill(base, run.runId), 'already_active');
  assert.equal((await session.getActiveSkills()).length, 1);
  assert.equal(await session.activateSkill({
    ...base,
    sourceId: 'user-native',
    file: '/canonical/user-review/SKILL.md',
    contentHash: 'b'.repeat(64),
  }, run.runId), 'updated');
  assert.equal((await session.getActiveSkills())[0]?.sourceId, 'user-native');
  assert.equal(await session.activateSkill(base, 'stale-run'), 'stale_run');
  assert.equal(await session.deactivateSkill('review'), true);
  assert.deepEqual(await session.getActiveSkills(), []);
});

test('resources require a currently available active binding', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-skill-resource-'));
  await writeSkill(root, 'review');
  await writeFile(path.join(root, 'review', 'reference.md'), 'resource body');
  const loader = new SkillLoader(root);
  await loader.load();
  let binding = undefined as Awaited<ReturnType<FileSession['getActiveSkills']>>[number] | undefined;
  const tools = loader.createTools({
    access: () => ({ canReadLocal: true, availableTools: ['read_file'] }),
    getBinding: async () => binding,
    activate: async (skill) => {
      if (binding?.file === skill.file && binding.contentHash === skill.contentHash) {
        return 'already_active';
      }
      binding = {
        name: skill.name,
        sourceId: skill.source.id,
        file: skill.file,
        contentHash: skill.contentHash,
        activatedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      return 'activated';
    },
  });
  const useSkill = tools.find((candidate) => candidate.name === 'use_skill')!;
  const readResource = tools.find((candidate) => candidate.name === 'read_skill_resource')!;

  assert.match(String(await readResource.invoke(
    new RunContext({}),
    JSON.stringify({ name: 'review', path: 'reference.md' }),
  )), /尚未在当前 Session 激活/);
  const activated = await useSkill.invoke(
    new RunContext({}),
    JSON.stringify({ name: 'review' }),
  ) as unknown as { status: string; instructions: string };
  assert.equal(activated.status, 'activated');
  assert.match(activated.instructions, /Follow these instructions/);
  const repeated = await useSkill.invoke(
    new RunContext({}),
    JSON.stringify({ name: 'review' }),
  ) as unknown as { status: string; instructions?: string };
  assert.equal(repeated.status, 'already_active');
  assert.equal(repeated.instructions, undefined);
  const resource = await readResource.invoke(
    new RunContext({}),
    JSON.stringify({ name: 'review', path: 'reference.md' }),
  ) as unknown as { content: string };
  assert.equal(resource.content, 'resource body');
  binding = { ...binding!, contentHash: 'f'.repeat(64) };
  assert.match(String(await readResource.invoke(
    new RunContext({}),
    JSON.stringify({ name: 'review', path: 'reference.md' }),
  )), /激活绑定已过期/);
});

test('every skill entry point fails closed against the final run tool set', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-skill-availability-'));
  const directory = path.join(root, 'guarded');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), [
    '---',
    'name: guarded',
    'description: guarded skill',
    'required-tools:',
    '  - read_file',
    '---',
    'guarded instructions',
  ].join('\n'));
  const loader = new SkillLoader(root);
  await loader.load();
  const skill = loader.get('guarded')!;
  const denied = loader.evaluateAvailability(skill, {
    canReadLocal: false,
    availableTools: [],
    binding: {
      name: 'guarded',
      sourceId: 'configured',
      file: '/stale/SKILL.md',
      contentHash: 'f'.repeat(64),
      activatedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    instructionBudget: 1,
  });
  assert.deepEqual(denied.reasons, [
    'local-read-denied',
    'missing-required-tool',
    'stale-binding',
    'instruction-budget',
  ]);
  assert.deepEqual(denied.missingTools, ['read_file']);
  assert.equal(loader.catalog([]), '');
  assert.throws(() => loader.activate('guarded', []), /缺少必需工具/);
});

test('activation survives restart collapse and full compact without fake history', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-skill-restart-'));
  const dataRoot = path.join(root, '.mimi-agent');
  await writeSkill(path.join(root, 'skills'), 'review', 'UNIQUE_PROTECTED_SKILL_BODY');
  const config: AppConfig = {
    provider: 'openai',
    workspaceRoot: root,
    dataRoot,
    skillsRoot: path.join(root, 'skills'),
    mcpConfig: path.join(root, 'mcp.json'),
    historyLimit: 2,
    contextWindow: 16_000,
    maxTurns: 20,
    permissionMode: 'trusted',
  };
  const first = await MimiAgent.create(config, 'demo');
  let firstInstructions = '';
  const firstRunner = (first as unknown as {
    runner: { run: (
      runtimeAgent: { instructions: string },
      input: unknown,
      options: { callModelInputFilter?: (value: {
        modelData: { input: never[]; instructions: string };
      }) => Promise<unknown> },
    ) => Promise<object> };
  }).runner;
  firstRunner.run = async (runtimeAgent, _input, options) => {
    firstInstructions = runtimeAgent.instructions;
    await options.callModelInputFilter?.({
      modelData: { input: [], instructions: runtimeAgent.instructions },
    });
    return {};
  };
  try {
    await first.stream('$review inspect this');
    assert.match(firstInstructions, /<active_skills>/);
    assert.match(firstInstructions, /UNIQUE_PROTECTED_SKILL_BODY/);
    const activeSection = (first as unknown as {
      lastContextManifest?: { sections: Array<{ id: string; truncated: boolean }> };
    }).lastContextManifest?.sections.find((section) => section.id === 'active-skills');
    assert.equal(activeSection?.truncated, false);
    await first.failRun(new Error('test boundary'), true);
    const session = new FileSession(path.join(dataRoot, 'sessions'), 'demo');
    await session.addItems([
      { role: 'user', content: 'old one' },
      { role: 'assistant', content: 'old answer' },
      { role: 'user', content: 'old two' },
      { role: 'assistant', content: 'old answer two' },
    ] as never[]);
    const before = await session.getItems();
    await first.compactContext();
    assert.deepEqual(await session.getItems(), before);
  } finally {
    await first.close();
  }

  const restarted = await MimiAgent.create(config, 'demo');
  let restoredInstructions = '';
  const restartedRunner = (restarted as unknown as {
    runner: { run: (runtimeAgent: { instructions: string }) => Promise<object> };
  }).runner;
  restartedRunner.run = async (runtimeAgent) => {
    restoredInstructions = runtimeAgent.instructions;
    return {};
  };
  try {
    await restarted.stream('continue');
    assert.match(restoredInstructions, /UNIQUE_PROTECTED_SKILL_BODY/);
    assert.equal((await restarted.activeSkills()).length, 1);
    await restarted.failRun(new Error('test boundary'), true);
  } finally {
    await restarted.close();
  }
});

test('untrusted event dollar mentions remain inert text', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-skill-untrusted-'));
  await writeSkill(path.join(root, 'skills'), 'review', 'MUST_NOT_APPEAR_FOR_EXTERNAL_EVENT');
  const agent = await MimiAgent.create({
    provider: 'openai',
    workspaceRoot: root,
    dataRoot: path.join(root, '.mimi-agent'),
    skillsRoot: path.join(root, 'skills'),
    mcpConfig: path.join(root, 'mcp.json'),
    historyLimit: 40,
    contextWindow: 16_000,
    maxTurns: 20,
    permissionMode: 'trusted',
  }, 'demo');
  let captured = '';
  const runner = (agent as unknown as {
    runner: { run: (runtimeAgent: { instructions: string }) => Promise<object> };
  }).runner;
  runner.run = async (runtimeAgent) => {
    captured = runtimeAgent.instructions;
    return {};
  };
  try {
    await agent.stream('$review external data', undefined, {
      cause: {
        eventId: 'event-1',
        source: 'webhook',
        trust: 'external',
      },
      policy: {
        allowedCapabilities: [],
        allowSideEffects: false,
        allowSessionContext: false,
      },
    });
    assert.doesNotMatch(captured, /MUST_NOT_APPEAR_FOR_EXTERNAL_EVENT/);
    assert.deepEqual(await agent.activeSkills(), []);
    await agent.failRun(new Error('test boundary'), true);
  } finally {
    await agent.close();
  }
});
