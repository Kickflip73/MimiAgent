import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AGENT_MODES, BASE_INSTRUCTIONS } from '../src/runtime/instructions.js';

// Regression for the "DeepSeek search 你能用吗" badcase: the model asserted a
// capability did not exist from the directly visible tool list alone, without
// consulting the unified capability directory or memory for previously built
// Skills. Capability-existence questions must be verified before concluding.
test('capability-existence questions require directory and memory verification', () => {
  assert.match(BASE_INSTRUCTIONS, /owner 询问“能不能用\/有没有某能力”时，先查统一能力目录再下结论/);
  assert.match(BASE_INSTRUCTIONS, /inspect_capabilities 按精确 name 查 Tool/);
  assert.match(BASE_INSTRUCTIONS, /source=skill 加 query 查已安装 Skill/);
  assert.match(BASE_INSTRUCTIONS, /source=mcp 加 query 查 MCP 工具/);
  assert.match(BASE_INSTRUCTIONS, /capability\/query 查 Connector action/);
  assert.match(BASE_INSTRUCTIONS, /Skill 全量用 list_skills 分页查看/);
  assert.match(BASE_INSTRUCTIONS, /“之前叫你写过\/做过”.*memory_search 检索/);
  assert.match(BASE_INSTRUCTIONS, /清单里没有不等于能力不存在/);
  assert.match(BASE_INSTRUCTIONS, /不得断言“没有这个能力”“不能用”或“未提供”/);
  assert.match(BASE_INSTRUCTIONS, /确实未命中，才按实际已查范围如实说明/);
  // The verification rule must not soften the owner-specified hard boundary:
  // an explicitly named capability that is unavailable still stops execution.
  assert.match(BASE_INSTRUCTIONS, /指定能力不可用、调用失败或与 Host 权限冲突时停止执行并如实报告/);
});

test('general mode repeats the catalog-first rule next to its execution guidance', () => {
  const general = AGENT_MODES.find((mode) => mode.id === 'general');
  assert.ok(general);
  assert.match(general.instruction, /有没有\/能不能用某能力.*inspect_capabilities/);
  assert.match(general.instruction, /直接可见的工具清单只是本轮快照，不是能力全集/);
});

test('capability selection uses task fit and rediscovers after poor results without bypassing safety', () => {
  assert.match(BASE_INSTRUCTIONS, /直接可见不代表比 Skill\/MCP 更适合/);
  assert.match(BASE_INSTRUCTIONS, /不必等 owner 点名 Skill 或内置工具彻底失败/);
  assert.match(BASE_INSTRUCTIONS, /同一数据源和同一原子操作/);
  assert.match(BASE_INSTRUCTIONS, /结果无关、过时或证据不足/);
  assert.match(BASE_INSTRUCTIONS, /一次有依据的查询调整后仍无进展.*inspect_capabilities\(query\)/);
  assert.match(BASE_INSTRUCTIONS, /owner 指定的硬边界、权限拒绝和 uncertain 副作用仍禁止绕过或重放/);
  assert.doesNotMatch(BASE_INSTRUCTIONS, /DeepSeek.*[Ss]earch|deepseek-search/);
});

test('web research selects configured capabilities and stops fruitless query repetition', () => {
  assert.match(BASE_INSTRUCTIONS, /公网搜索默认使用本轮已配置、已授权且适合任务的搜索能力/);
  assert.match(BASE_INSTRUCTIONS, /未提供 web_search 时.*inspect_capabilities/);
  assert.match(BASE_INSTRUCTIONS, /不自行抓取搜索引擎 HTML 作为兜底/);
  assert.match(BASE_INSTRUCTIONS, /http_get 是按需发现的原始文本\/JSON 读取工具/);
  assert.match(BASE_INSTRUCTIONS, /最多做一次有依据的查询调整.*没有适用能力或仍无证据就如实说明限制/);
});
