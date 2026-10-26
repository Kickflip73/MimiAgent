import { createHash } from 'node:crypto';
import { parse } from 'dotenv';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { resolveEnvironmentFile } from '../config.js';
import { persistEnvironmentValues } from '../provider-config.js';
import { withExclusiveFileLock } from '../core/state-file.js';

export const providerAccessSchema = z.object({
  id:z.string().regex(/^[a-zA-Z0-9_-]+$/).max(100),
  transport:z.enum(['openai-chat-completions','openai-responses','anthropic-messages','google-generate-content']),
  baseUrl:z.string().max(2048).default(''), apiKey:z.string().max(4096).optional(),
  apiKeyEnv:z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
}).strict();
export const providerEnvironmentName = (id:string) => `MIMI_PROVIDER_${id.toUpperCase().replace(/[^A-Z0-9]/g,'_')}_${createHash('sha256').update(id).digest('hex').slice(0,8).toUpperCase()}_API_KEY`;
export async function savedCredential(name:string, file = resolveEnvironmentFile()) {
  const values = await readFile(file,'utf8').then(parse).catch(error=>{if(error.code==='ENOENT')return {} as Record<string,string>;throw error;});
  return values[name] || process.env[name] || '';
}
export async function saveProviderCredential(name:string, key:string, file = resolveEnvironmentFile()) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || !key.trim()) throw new Error('凭证不能为空');
  await withExclusiveFileLock(file,()=>persistEnvironmentValues(file,{[name]:key.trim()}));
  process.env[name]=key.trim();
}
export async function discoverProvider(raw:unknown, fetcher:typeof fetch = fetch) {
  const value=providerAccessSchema.parse(raw);
  const key=value.apiKey?.trim() || await savedCredential(value.apiKeyEnv || providerEnvironmentName(value.id));
  if(!key)throw new Error('请填写 API Key');
  const defaults={ 'openai-chat-completions':'https://api.openai.com/v1', 'openai-responses':'https://api.openai.com/v1', 'anthropic-messages':'https://api.anthropic.com/v1', 'google-generate-content':'https://generativelanguage.googleapis.com/v1beta' };
  const url=new URL((value.baseUrl || defaults[value.transport]).replace(/\/+$/,'')+'/models');
  if(!['http:','https:'].includes(url.protocol) || url.username || url.password)throw new Error('API 地址必须为 HTTP(S)，不能含凭证');
  const headers:Record<string,string>=value.transport==='anthropic-messages'?{'x-api-key':key,'anthropic-version':'2023-06-01'}:value.transport==='google-generate-content'?{'x-goog-api-key':key}:{authorization:`Bearer ${key}`};
  const start=Date.now(); let response:Response;
  try { response=await fetcher(url,{headers,signal:AbortSignal.timeout(12_000),redirect:'error'}); }
  catch { throw new Error('连接失败或超时，请检查 API 地址和网络'); }
  if(!response.ok)throw new Error(`模型目录请求失败（HTTP ${response.status}）${response.status===401||response.status===403?'，请检查 API Key 与权限':''}`);
  const result=await response.json() as {data?:Array<{id:string}>;models?:Array<{name:string;displayName?:string;inputTokenLimit?:number}>};
  const models=(result.data??result.models??[]).map(item=> 'id' in item?{id:item.id}:{id:item.name.replace(/^models\//,''),label:item.displayName,contextWindow:item.inputTokenLimit}).filter(item=>typeof item.id==='string');
  return {reachable:true,latencyMs:Date.now()-start,models:models.slice(0,1000),truncated:models.length>1000, note:'已验证模型目录接口可达及凭证；未发送生成请求。'};
}
