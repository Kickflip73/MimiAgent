import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunContext } from '@openai/agents';
import { SkillLoader } from '../src/extensions/skills.js';
import { HostCapabilityRegistry } from '../src/runtime/pipeline/capability-registry.js';
import { ToolSetBuilder } from '../src/runtime/pipeline/tool-set-builder.js';
import { tool } from '../src/tool-factory.js';
import { z } from 'zod';

test('task discovery finds installed Skills and direct tools without knowing their source or exact name', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-task-discovery-'));
  try {
    await mkdir(path.join(root, 'cobalt'));
    await writeFile(path.join(root, 'cobalt', 'SKILL.md'), [
      '---', 'name: cobalt',
      'description: Search authoritative web sources with date filters. 搜索网页并抓取正文，支持时间过滤。',
      'required-tools: run_shell', '---', 'PRIVATE_SKILL_BODY',
    ].join('\n'));
    const loader = new SkillLoader(root);
    await loader.load();
    const access = { canReadLocal: true, availableTools: ['run_shell'] };
    const search = tool({ name: 'web_search', description: 'Search the web', parameters: z.object({ query: z.string() }), execute: async () => 'unused' });
    const tools = [...loader.createTools(() => access.availableTools), search];
    const registry = new HostCapabilityRegistry(tools, undefined, filter => loader.inspectCatalog(filter, access));
    const [inspect] = registry.gatewayTools(new ToolSetBuilder().classify(tools).deferred) as Array<ReturnType<typeof tool>>;
    for (const query of ['web search', '搜索网页', '网页 时间过滤']) {
      const found = await inspect!.invoke(new RunContext({}), JSON.stringify({ query })) as any;
      assert.equal(found.skillCatalog.skills[0]?.name, 'cobalt', query);
      assert.equal(found.skillCatalog.skills[0]?.available, true);
      assert.doesNotMatch(JSON.stringify(found), /PRIVATE_SKILL_BODY/);
      if (query === 'web search') {
        assert.equal(found.capabilities.find((entry: any) => entry.name === 'web_search')?.invokeWith, 'web_search');
        assert.equal(found.matchedCount, 2);
      }
    }
    const exact = await inspect!.invoke(new RunContext({}), JSON.stringify({ name: 'cobalt' })) as any;
    assert.equal(exact.resolution.status, 'skill');
    assert.ok(exact.capabilities.some((entry: any) => entry.name === 'use_skill' && entry.invokeWith === 'use_skill'));
    const builtinOnly = await inspect!.invoke(new RunContext({}), '{"source":"builtin","query":"web search"}') as any;
    assert.equal(builtinOnly.skillCatalog, undefined);
    assert.equal(builtinOnly.matchedCount, 1);
    // A cached successful discovery must never conceal later availability changes.
    access.availableTools = [];
    const unavailable = await inspect!.invoke(new RunContext({}), JSON.stringify({ query: 'web search' })) as any;
    assert.equal(unavailable.skillCatalog.skills[0].available, false);
    assert.deepEqual(unavailable.skillCatalog.skills[0].missingTools, ['run_shell']);
    const rejected = await tools.find(candidate => candidate.name === 'use_skill')!.invoke(new RunContext({}), '{"name":"cobalt"}');
    assert.match(String(rejected), /缺少必需工具/);
    const denied = new HostCapabilityRegistry([search], undefined, () => { throw new Error('local Skills must remain hidden'); });
    const deniedInspect = denied.gatewayTools([])[0] as ReturnType<typeof tool>;
    const hidden = await deniedInspect.invoke(new RunContext({}), '{"query":"web search"}') as any;
    assert.equal(hidden.skillCatalog, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('general discovery marks cold MCP services as unsearched and leaves connection lazy', async () => {
  let loads = 0;
  const registry = new HostCapabilityRegistry([], undefined, undefined, {
    statuses: () => [{ name: 'fixture-search', state: 'configured', tools: 0 }],
    load: async () => { loads += 1; return []; },
  });
  const [inspect] = registry.gatewayTools([]) as Array<ReturnType<typeof tool>>;
  const found = await inspect!.invoke(new RunContext({}), '{"query":"web search"}') as any;
  assert.equal(loads, 0);
  assert.equal(found.matchedCount, 0);
  assert.equal(found.mcpCatalog[0].state, 'configured');
  assert.match(found.mcpDiscovery, /source=mcp/);
});

test('Skill queries rank exact phrases first and tokenize names and descriptions consistently', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-skill-query-'));
  try {
    for (const [name, description] of [
      ['alpha', 'Read a web page and search documents'],
      ['beta', 'Web search with authoritative sources'],
      ['gamma', 'Create a presentation'],
    ]) {
      await mkdir(path.join(root, name!));
      await writeFile(path.join(root, name!, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\nBody.`);
    }
    const loader = new SkillLoader(root);
    await loader.load();
    assert.deepEqual(loader.inspectCatalog({ query: 'WEB search' }).skills.map(skill => skill.name), ['beta', 'alpha']);
    assert.equal(loader.inspectCatalog({ query: 'unregistered ability' }).total, 0);
    assert.equal(loader.inspectCatalog({ name: 'bet' }).total, 0);
    assert.equal(loader.inspectCatalog({ query: 'the and' }).total, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Skill index is bounded and exact discovery navigates directly to authorized activation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(),'mimi-skill-index-'));
  try {
    for (let index=0;index<30;index++) {
      const name=`probe-${index}`; await mkdir(path.join(root,name));
      await writeFile(path.join(root,name,'SKILL.md'),`---\nname: ${name}\ndescription: ${'bounded discoverable instruction '.repeat(30)}\n---\nFollow the actual instructions.`);
    }
    const loader=new SkillLoader(root);await loader.load();const tools=loader.createTools();
    const listed=await tools.find(t=>t.name==='list_skills')!.invoke(new RunContext({}),'{}') as any;
    assert.equal(listed.skills.length,25);assert.equal(listed.nextOffset,25);
    assert.ok(JSON.stringify(listed).length<12000);assert.doesNotMatch(JSON.stringify(listed),/contentHash|\/SKILL.md/);
    const registry=new HostCapabilityRegistry(tools,undefined,(filter)=>loader.inspectCatalog(filter,{canReadLocal:true}));
    const gateway=registry.gatewayTools(tools);const inspect=gateway.find(t=>t.name==='inspect_capabilities')! as any;
    const found=await inspect.invoke(new RunContext({}),JSON.stringify({source:'skill',name:'probe-29'}),{});
    assert.equal(found.skillCatalog.skills[0].name,'probe-29');assert.equal(found.resolution.status,'skill');
    const invoke=gateway.find(t=>t.name==='invoke_capability')! as any;
    const activated=await invoke.invoke(new RunContext({}),JSON.stringify({name:'use_skill',argumentsJson:'{"name":"probe-29"}'}),{});
    assert.match(activated.instructions,/actual instructions/);
    const denied=new HostCapabilityRegistry([],undefined,()=>{throw new Error('must not expose denied skills');});
    const deniedInspect=denied.gatewayTools([]).find(t=>t.name==='inspect_capabilities')! as any;
    const hidden=await deniedInspect.invoke(new RunContext({}),JSON.stringify({source:'skill',name:'probe-29'}),{});
    assert.equal(hidden.resolution.status,'unavailable');
  } finally {await rm(root,{recursive:true,force:true});}
});
