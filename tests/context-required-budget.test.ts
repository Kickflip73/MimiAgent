import assert from 'node:assert/strict';
import test from 'node:test';
import { ContextManager } from '../src/core/context.js';

test('required instructions may use request headroom without expanding optional context', () => {
  const manager = new ContextManager(40, 8_000);
  const activeSkills = `<active_skills>${'complete procedure '.repeat(80)}</active_skills>`;
  const parts = {
    baseInstructions: 'base',
    runtimeContext: 'runtime facts',
    activeSkills,
    projectGuidance: 'optional project guidance '.repeat(200),
    historySummary: '',
    skillCatalog: '',
    memories: [],
    plan: [],
  };

  assert.throws(
    () => manager.buildInstructionsResult(parts, 100),
    /完整正文超出 instruction budget/,
  );
  const built = manager.buildInstructionsResult(parts, 100, 1_000);
  assert.match(built.text, /complete procedure/);
  assert.doesNotMatch(built.text, /optional project guidance/);
  assert.equal(
    built.sections.find((section) => section.id === 'active-skills')?.truncated,
    false,
  );
});
