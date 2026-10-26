import { chooseWorkspace } from './workspace-picker.js';
import { executionHistory } from './execution-history.js';
import { discoverProvider, providerEnvironmentName, savedCredential, saveProviderCredential } from './provider-access.js';
import { DatabaseSync } from 'node:sqlite';
import { nextCronTime } from '../daemon/cron.js';
import { listScheduleExecutions } from '../daemon/schedule-store.js';
import { mimiPaths } from '../daemon/client-runtime.js';
import { SkillLoader } from '../extensions/skills.js';
import { SkillPreferenceStore } from '../extensions/skill-preferences.js';
import { skillSources } from '../runtime/components.js';
import { skillResource, saveSkillResource } from './skill-files.js';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { AtomicJsonStore, withExclusiveFileLock } from '../core/state-file.js';
import { parseMcpConfig } from '../extensions/mcp.js';
import { ModelConfigStore, parseModelsConfig } from '../runtime/model-config.js';

export const webSettingsSchema = z.object({
  mode: z.enum(['general', 'plan', 'ultra']).default('general'),
  outputLevel: z.enum(['answer', 'thinking', 'tools', 'trace']).default('tools'),
  expandExecution: z.boolean().default(false),
  security: z.enum(['inherit','safe','workstation','full-owner']).default('inherit'),
  sendWith: z.enum(['enter','mod-enter']).default('enter'),
}).strict();
const digest = (source: string) => createHash('sha256').update(source).digest('hex');
const revision = (value: unknown) => digest(JSON.stringify(value));
const MASK = '⟪已保存，留空标记保持原值⟫';
function redact(value: unknown, key = ''): unknown {
  if (typeof value === 'string' && ((/secret|password|token|authorization|api.?key/i.test(key) && !/Env$/.test(key)) || key === 'env-value' || /https?:\/\/[^/]*@|[?&](?:key|token|secret|api_key)=/i.test(value))) return MASK;
  if (Array.isArray(value)) return value.map(item => redact(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, key === 'env' || key === 'headers' ? 'env-value' : k)]));
  return value;
}
function restore(value: unknown, old: unknown): unknown {
  if (value === MASK) { if (old === undefined) throw new Error('新配置不能使用已保存值标记'); return old; }
  if (Array.isArray(value)) return value.map((v, i) => restore(v, Array.isArray(old) ? old[i] : undefined));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, restore(v, old && typeof old === 'object' ? (old as Record<string, unknown>)[k] : undefined)]));
  return value;
}
async function textFile(file: string): Promise<string> {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('仅支持编辑普通配置文件');
    if (stat.size > 256_000) throw new Error('文件超过 Web 编辑上限');
    return await readFile(file, 'utf8');
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
}
/** Markdown uses the same file lock as PreferenceStore; writes are atomic and revision checked. */
export async function savePrompt(file: string, content: string, expectedRevision: string): Promise<void> {
  if (content.length > 20_000) throw new Error('提示词最多 20000 字符');
  await withExclusiveFileLock(file, async () => {
    const previous = await textFile(file);
    if (digest(previous) !== expectedRevision) throw new Error('文件已在其他地方修改，请重新读取后合并');
    await mkdir(path.dirname(file), { recursive: true });
    if (previous) await writeFile(`${file}.web-backup-${Date.now()}-${randomUUID().slice(0, 8)}`, previous, { mode: 0o600 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, content, { mode: 0o600 }); await rename(temporary, file); }
    finally { await rm(temporary, { force: true }); }
  });
}

type Invoke = (operation: string, value: unknown, session: string) => Promise<unknown>;
type Rpc = (method: string, params?: unknown) => Promise<unknown>;
export function webManagement(config: AppConfig, invoke: Invoke, rpc: Rpc) {
  const settings = new AtomicJsonStore(path.join(config.dataRoot, 'web-settings.json'), { defaultValue: () => webSettingsSchema.parse({}), decode: value => webSettingsSchema.parse(value), preserveSchemaMismatch: true, recoverCorrupt: false });
  const modelFile = config.modelsConfig;
  const mcp = new AtomicJsonStore<Record<string, unknown>>(config.mcpConfig || path.join(config.workspaceRoot, 'mcp.json'), { defaultValue: () => ({ mcpServers: {} }), decode: value => { parseMcpConfig(value); return value as Record<string, unknown>; }, preserveSchemaMismatch: true, recoverCorrupt: false });
  async function skills() {
    const loader = new SkillLoader(skillSources(config), new SkillPreferenceStore(path.join(config.dataRoot,'skill-preferences.json'),path.join(os.homedir(),'.mimi-agent','skill-preferences.json')));
    await loader.load(); return loader;
  }
  async function documents() {
    const files = [
      { id: 'soul', title: '身份与系统人格', file: path.join(os.homedir(), '.mimi-agent', 'MIMI.md') },
      { id: 'preferences', title: '行为准则与偏好', file: path.join(os.homedir(), '.mimi-agent', 'PREFERENCES.md') },
      { id: 'agents', title: '项目开发准则 · AGENTS.md', file: path.join(config.workspaceRoot, 'AGENTS.md') },
      { id: 'claude', title: '项目补充指令 · CLAUDE.md', file: path.join(config.workspaceRoot, 'CLAUDE.md') },
    ];
    return await Promise.all(files.map(async item => { const content = await textFile(item.file); return { ...item, content, revision: digest(content) }; }));
  }
  return {
    async read(area: string, session: string): Promise<unknown> {
      if (area === 'settings') return settings.read();
      if (area === 'skills') {
        const loader = await skills();
        return loader.list().map(s => ({ ...s, enabled: !loader.preference(s.name).disabled }));
      }
      if (area === 'runtime') return { workspaceRoot: config.workspaceRoot, documents: await documents() };
      if (area === 'mcp') {
        const value = await mcp.read();
        const status = await invoke('mcp', undefined, session);
        return { config: redact(value), revision: revision(value), status, workspaceRoot: config.workspaceRoot };
      }
      if (area === 'models') {
        if (!modelFile) throw new Error('后台未使用 models.json，请先迁移到模型注册表');
        const value = await new ModelConfigStore(modelFile).read();
        return { config: value, revision: revision(value), providers: await Promise.all(value.providers.map(async p => ({ id: p.id, configured: !!(await savedCredential(p.apiKeyEnv)).trim() }))) };
      }
      if (area === 'connectors') return rpc('connectors.list');
      if (area === 'schedules') {
        const items: unknown[] = []; let offset: number | undefined = 0; let version: string | undefined;
        do { const page = await rpc('schedules.page', { offset, revision: version, limit: 200 }) as { items: unknown[]; nextOffset?: number; revision: string }; items.push(...page.items); offset = page.nextOffset; version = page.revision; } while (offset !== undefined && items.length < 2000);
        const capabilities = await rpc('schedules.capabilities').catch(error => { if (/未知.*RPC/.test(String(error))) return {cron:false}; throw error; }) as {cron:boolean;timezone?:string};
        return { items, truncated: offset !== undefined, cronAvailable: capabilities.cron, timezone: capabilities.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone };
      }
      if (area === 'status') {
        const [status, attention, runtime] = await Promise.allSettled([rpc('status'), rpc('attention.status'), invoke('runtime', undefined, session)]);
        return Object.fromEntries([['status', status], ['attention', attention], ['runtime', runtime]].map(([key, result]) => [key, (result as PromiseSettledResult<unknown>).status === 'fulfilled' ? (result as PromiseFulfilledResult<unknown>).value : { error: (result as PromiseRejectedResult).reason.message }]));
      }
      throw new Error('未知管理页面');
    },
    async write(action: string, session: string, raw: unknown): Promise<unknown> {
      if (action === 'workspace.choose') return chooseWorkspace();
      if (action === 'models.discover' || action === 'models.health') return discoverProvider(raw);
      if (action === 'models.credential') {
        const value=z.object({id:z.string().regex(/^[a-zA-Z0-9_-]+$/).max(100),apiKey:z.string().min(1).max(4096),apiKeyEnv:z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional()}).strict().parse(raw);
        const apiKeyEnv=value.apiKeyEnv || providerEnvironmentName(value.id);
        await saveProviderCredential(apiKeyEnv,value.apiKey);
        return {apiKeyEnv,configured:true};
      }
      if (action === 'execution.history') {
        const value=z.object({runId:z.string().uuid().optional()}).strict().parse(raw);
        const database=new DatabaseSync(mimiPaths(config).database,{readOnly:true});
        try { return await executionHistory(database,config.dataRoot,value.runId,session); } finally { database.close(); }
      }
      if (action === 'skills.save') {
        const value=z.object({name:z.string().min(1).max(200),path:z.string().min(1).max(4096),content:z.string().max(200_000),revision:z.string().length(64)}).strict().parse(raw);
        const skill=(await skills()).get(value.name); if(!skill)throw new Error('Skill 不存在');
        return saveSkillResource(skill,value.path,value.content,value.revision);
      }
      if (action === 'settings.save') { const value = webSettingsSchema.parse(raw); await settings.replace(value); return value; }
      if (action === 'settings.apply') { const value = webSettingsSchema.parse(raw); await invoke('mode.set', value.mode, session); return invoke('output.set', value.outputLevel, session); }
      if (action === 'skills.set') { const value = z.object({ name: z.string().min(1).max(200), scope: z.enum(['project', 'user']), enabled: z.boolean() }).strict().parse(raw); return invoke(action, value, session); }
      if (action === 'skills.reload' || action === 'mcp.reload') return invoke(action, undefined, session);
      if (action === 'model.doctor') return invoke('model.control', { action: 'doctor' }, session);
      if (action === 'connectors.reload') return rpc(action);
      if (action === 'connectors.setEnabled') return rpc(action, z.object({ id: z.string().min(1).max(200), enabled: z.boolean() }).strict().parse(raw));
      if (action === 'skills.resource') {
        const value = z.object({ name: z.string().min(1).max(200), path: z.string().max(4096).default(''), offset: z.number().int().min(0).default(0) }).strict().parse(raw);
        const skill = (await skills()).get(value.name);
        if (!skill) throw new Error('Skill 不存在，请重新扫描');
        return skillResource(skill, value.path, value.offset);
      }
      if (action === 'schedule.detail' || action === 'schedule.history') {
        const value = z.object({ id: z.string().min(1).max(200), offset: z.number().int().min(0).default(0) }).strict().parse(raw);
        if (action === 'schedule.detail') return rpc('schedule.get', { id: value.id });
        try { return await rpc('schedules.history', { ...value, limit: 50 }); }
        catch (error) {
          if (!/未知.*RPC/.test(String(error))) throw error;
          // Older compatible daemons already persist the same run ledger. Read only.
          const database = new DatabaseSync(mimiPaths(config).database, { readOnly: true });
          try { return listScheduleExecutions(database,value.id,value.offset); } finally { database.close(); }
        }
      }
      if (action === 'schedule.preview') {
        const value = z.object({ cron: z.string().min(1).max(200) }).strict().parse(raw);
        let at = new Date(); const times = [];
        for(let i=0;i<3;i++) { at=nextCronTime(value.cron,at); times.push(at.toISOString()); }
        return { times, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
      }
      if (action === 'schedule.add') {
        if (raw && typeof raw === 'object' && 'type' in raw && raw.type === 'cron') {
          const value = z.object({name:z.string().min(1).max(200),prompt:z.string().min(1).max(20_000),type:z.literal('cron'),cron:z.string().min(1).max(200)}).strict().parse(raw);
          const nextRunAt = nextCronTime(value.cron).toISOString();
          return rpc('schedules.add',{name:value.name,prompt:value.prompt,type:'cron',value:value.cron.trim(),nextRunAt,profileId:'owner',trust:'owner',sessionKey:session});
        }
        const value = z.object({ name: z.string().min(1).max(200), prompt: z.string().min(1).max(20_000), type: z.enum(['at','interval']), minutes: z.number().int().min(1).max(525600).optional(), at: z.string().optional() }).strict().parse(raw);
        const nextRunAt = value.type === 'interval' && value.minutes ? new Date(Date.now() + value.minutes * 60_000).toISOString() : value.at;
        if (!nextRunAt || !Number.isFinite(Date.parse(nextRunAt)) || Date.parse(nextRunAt) <= Date.now()) throw new Error('请选择未来时间或有效的间隔');
        return rpc('schedules.add', { name: value.name, prompt: value.prompt, type: value.type, value: value.type === 'interval' ? String(value.minutes! * 60_000) : nextRunAt, nextRunAt, profileId: 'owner', trust: 'owner', sessionKey: session });
      }
      if (action === 'schedule.update') {
        const value=z.object({id:z.string().min(1).max(200),updatedAt:z.string().datetime(),patch:z.object({name:z.string().min(1).max(200).optional(),prompt:z.string().min(1).max(20000).optional(),type:z.enum(['cron','interval','at']).optional(),value:z.string().min(1).max(200).optional(),enabled:z.boolean().optional()}).strict()}).strict().parse(raw);
        return rpc('schedules.update',value);
      }
      if (action === 'schedule.remove') return rpc('schedules.remove', z.object({ id: z.string().min(1).max(200) }).strict().parse(raw));
      if (action === 'runtime.save') {
        const value = z.object({ id: z.string(), revision: z.string().length(64), content: z.string().max(20_000) }).strict().parse(raw);
        if (!['soul','preferences','agents','claude'].includes(value.id)) throw new Error('未知提示词文件');
        const doc = (await documents()).find(item => item.id === value.id);
        if (!doc) throw new Error('未知提示词文件');
        await savePrompt(doc.file, value.content, value.revision);
        return { saved: true, revision: digest(value.content), effective: 'next_run' };
      }
      if (action === 'models.save' || action === 'mcp.save') {
        const request = z.object({ config: z.record(z.string(), z.unknown()), revision: z.string().length(64) }).strict().parse(raw);
        if (action === 'models.save') {
          if (!modelFile) throw new Error('未配置模型注册表');
          await new ModelConfigStore(modelFile).update(current => {
            if (revision(current) !== request.revision) throw new Error('配置已变化，请重新读取后合并');
            const next = parseModelsConfig(request.config); next.routeVersion = current.routeVersion + 1; return next;
          });
          await rpc('models.credentials.reload').catch(error=>{if(!/未知.*RPC/.test(String(error)))throw error;});
        } else await mcp.update(current => {
          if (revision(current) !== request.revision) throw new Error('配置已变化，请重新读取后合并');
          const next = restore(request.config, current) as Record<string, unknown>;
          parseMcpConfig(next);
          for (const key of Object.keys(current)) delete current[key]; Object.assign(current, next);
        });
        return { saved: true };
      }
      throw new Error('未知管理操作');
    },
  };
}
