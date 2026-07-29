import { tool, type Tool } from '@openai/agents';
import { z } from 'zod';
import {
  modelTargetSchema,
  type ModelTarget,
  type ScenarioRoute,
} from '../core/model-routing.js';

export interface ModelControlTools {
  list: () => unknown | Promise<unknown>;
  inspect: (target: ModelTarget) => unknown | Promise<unknown>;
  current: () => unknown | Promise<unknown>;
  setSession: (target: ModelTarget) => unknown | Promise<unknown>;
  clearSession: () => unknown | Promise<unknown>;
  routes: () => unknown | Promise<unknown>;
  setRoute: (scenario: string, route?: ScenarioRoute) => unknown | Promise<unknown>;
  doctor: (target?: ModelTarget) => unknown | Promise<unknown>;
  assertOwner: () => void;
}

const scenarioSchema = z.string().regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/).max(100);

export function createModelControlTools(controls: ModelControlTools): Tool[] {
  return [
    tool({
      name: 'model_control',
      description: '结构化查看或配置模型路由；写操作仅限 direct Owner。',
      parameters: z.object({
        action: z.enum(['list', 'inspect', 'current', 'use', 'auto', 'routes', 'route', 'doctor']),
        scenario: scenarioSchema.optional(),
        target: modelTargetSchema.optional(),
        routeAuto: z.boolean().optional(),
        maxTurns: z.number().int().positive().optional(),
        maxOutputTokens: z.number().int().positive().optional(),
      }).strict(),
      execute: async ({ action, scenario, target, routeAuto, maxTurns, maxOutputTokens }) => {
        if (action === 'list') return controls.list();
        if (action === 'inspect') {
          if (!target) throw new Error('inspect 需要 target');
          return controls.inspect(target);
        }
        if (action === 'current') return controls.current();
        if (action === 'use') {
          if (!target) throw new Error('use 需要 target');
          controls.assertOwner();
          return controls.setSession(target);
        }
        if (action === 'auto') {
          controls.assertOwner();
          return controls.clearSession();
        }
        if (action === 'routes') return controls.routes();
        if (action === 'route') {
          if (!scenario) throw new Error('route 需要 scenario');
          if (Boolean(target) === (routeAuto === true)) {
            throw new Error('route 必须二选一提供 target 或 routeAuto=true');
          }
          if (routeAuto && (maxTurns !== undefined || maxOutputTokens !== undefined)) {
            throw new Error('routeAuto=true 不能同时设置预算');
          }
          controls.assertOwner();
          return controls.setRoute(scenario, target ? {
            target,
            ...(maxTurns ? { maxTurns } : {}),
            ...(maxOutputTokens ? { maxOutputTokens } : {}),
          } : undefined);
        }
        return controls.doctor(target);
      },
    }),
  ];
}
