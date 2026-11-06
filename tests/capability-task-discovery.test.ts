import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunContext, type Tool } from '@openai/agents';
import { MimiAgent } from '../src/agent.js';
import { renderSkillIndex } from '../src/runtime/pipeline/run-pipeline.js';

test('Skill purpose index bounds metadata and keeps all names without advertising unavailable procedures', () => {
  const skills = Array.from({ length: 200 }, (_, index) => ({
    name: `fixture-${index}`, description: 'Search authoritative sources. '.repeat(30), available: true,
  }));
  const index = renderSkillIndex(skills);
  assert.match(index, /fixture-199: Search authoritative sources/);
  assert.match(index, /…/);
  assert.ok(index.length < 16_000);
  assert.equal(renderSkillIndex([{ name: 'disabled', description: 'HIDDEN_PURPOSE', available: false }]), '- disabled（本轮不可用）');
});

// Exercise the actual Run pipeline and tools with a deterministic model stub.
// This verifies disclosure and activation, not a live model's routing quality.
for (const provider of ['openai', 'deepseek'] as const) {
  test(`${provider} fresh sessions discover and activate a relevant opaque-named Skill without memory`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-task-skill-'));
    t.mock.method(os, 'homedir', () => path.join(root, 'home'));
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('Network is forbidden in this fixture'); });
    const previousKey = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = 'test-only-placeholder';
    const skillsRoot = path.join(root, 'skills');
    await mkdir(path.join(skillsRoot, 'cobalt'), { recursive: true });
    await writeFile(path.join(skillsRoot, 'cobalt', 'SKILL.md'), [
      '---', 'name: cobalt', 'description: Search authoritative web sources with date filters.',
      '---', 'PRIVATE_PROCEDURE_MARKER',
    ].join('\n'));
    try {
      for (const session of ['first', 'second']) {
        const agent = await MimiAgent.create({
          provider, workspaceRoot: root, dataRoot: path.join(root, session), skillsRoot,
          mcpConfig: path.join(root, 'mcp.json'), historyLimit: 40, contextWindow: 128_000, maxTurns: 10,
        });
        try {
          const runner = (agent as unknown as { runner: { run: (runtimeAgent: unknown) => Promise<unknown> } }).runner;
          runner.run = async (runtimeAgent) => {
            const { instructions, tools } = runtimeAgent as { instructions: string; tools: Tool[] };
            assert.match(instructions, /cobalt: Search authoritative web sources/);
            assert.doesNotMatch(instructions, /PRIVATE_PROCEDURE_MARKER/);
            assert.equal(tools.some(tool => tool.name === 'http_get'), false);
            const search = tools.find(tool => tool.name === 'web_search');
            if (provider === 'deepseek') assert.equal(search, undefined);
            else {
              assert.ok(search);
              assert.notEqual(search.type, 'function');
            }
            const invoke = async (name: string, input: object) => {
              const candidate = tools.find(candidate => candidate.name === name);
              assert.ok(candidate?.type === 'function');
              return candidate.invoke(new RunContext({}), JSON.stringify(input));
            };
            const found = await invoke('inspect_capabilities', { query: 'web search' }) as {
              skillCatalog: { skills: Array<{ name: string; available: boolean }> };
            };
            assert.ok(found.skillCatalog.skills.some(skill => skill.name === 'cobalt' && skill.available));
            const rawRead = await invoke('inspect_capabilities', { name: 'http_get' }) as {
              resolution: { status: string };
            };
            assert.equal(rawRead.resolution.status, 'deferred');
            const activated = await invoke('use_skill', { name: 'cobalt' }) as { instructions: string };
            assert.match(activated.instructions, /PRIVATE_PROCEDURE_MARKER/);
            return {};
          };
          await agent.stream('查证最近的产品公告，给出可靠来源');
          await agent.completeRun('fixture complete');
        } finally {
          await agent.close();
        }
      }
    } finally {
      if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = previousKey;
      await rm(root, { recursive: true, force: true });
    }
  });
}
