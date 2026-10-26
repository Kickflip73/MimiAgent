import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { daemonLaunchEnvironment } from '../src/daemon/launch-agent-config.js';
import type { AppConfig } from '../src/config.js';
test('launchd keeps the selected Node bin and absolute tool paths without exporting credentials',()=>{
 const previous=process.env.PATH;
 try {
  process.env.PATH='/opt/homebrew/bin:.:relative:/usr/bin:/opt/homebrew/bin';
  const value=daemonLaunchEnvironment({workspaceRoot:'/tmp/mimi-test',dataRoot:'/tmp/mimi-test',provider:'deepseek',skillsRoot:'/tmp/skills',mcpConfig:'/tmp/mcp.json',historyLimit:40,maxTurns:null} as AppConfig);
  assert.equal(value.PATH!.split(path.delimiter)[0],path.dirname(process.execPath));
  assert.ok(value.PATH!.split(path.delimiter).includes('/opt/homebrew/bin'));
  assert.ok(value.PATH!.split(path.delimiter).every(path.isAbsolute));
  assert.equal(new Set(value.PATH!.split(path.delimiter)).size,value.PATH!.split(path.delimiter).length);
  assert.equal(value.DEEPSEEK_API_KEY,undefined);
 } finally {if(previous===undefined)delete process.env.PATH;else process.env.PATH=previous;}
});
