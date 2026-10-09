import { readOutputMedia } from './media-output.js';
import { mediaIds, type MediaAttachment } from '../core/media-attachment.js';
import { saveMedia, readMedia } from '../runtime/media-input.js';
import { prepareMedia } from './media.js';
import { imageIds, IMAGE_TOTAL_BYTES, type ImageAttachment } from '../core/image-attachment.js';
import { saveWebImage, readWebImage } from './images.js';
import { memoryEvidence, readMemoryEvidence } from './memory-browser.js';
import { decorateSessionTimeline } from './session-timeline.js';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { defaultWorkspaceRoot } from '../config.js';
import { assertSessionId } from '../core/session-id.js';
import { savedSessionWorkspace } from '../daemon/session-workspace.js';
import { validateWorkspace } from './workspace-picker.js';
import { readFile, mkdir } from 'node:fs/promises';
import { modelTargetSchema } from '../core/model-routing.js';
import { WorkUnitModelResolver } from '../runtime/work-unit-model-resolver.js';
import { ModelConfigStore, legacyModelConfigurationForAppConfig } from '../runtime/model-config.js';
import { webManagement } from './management.js';
import type { ModelTarget } from '../core/model-routing.js';
import type { AppConfig, SecurityProfile } from '../config.js';
import { MimiChatClient } from '../daemon/chat-client.js';
import { mimiPaths } from '../daemon/client-runtime.js';
import { mimiRpc } from '../daemon/ipc.js';
import { DAEMON_PROTOCOL_VERSION, type DaemonStatus, type MimiChatSnapshot, type MimiStreamSnapshot } from '../daemon/types.js';

/** A browser transport over the existing daemon; never owns an Agent or durable state. */
export interface WebBackend {
  manageRead?(area: string, session: string): Promise<unknown>;
  manageWrite?(action: string, session: string, value: unknown): Promise<unknown>;
  status(): Promise<unknown>;
  sessions(): Promise<unknown>;
  session(id: string, draft: boolean): Promise<unknown>;
  history(id: string): Promise<unknown>;
  context(id: string): Promise<unknown>;
  submit(id: string, input: string, requestId: string, security?: SecurityProfile, workspaceRoot?: string, images?: string[], media?: string[]): Promise<unknown>;
  outputMedia?(session:string,file:string):Promise<{data:Buffer;mediaType:string}>;
  uploadMedia?(data:Buffer,type:string):Promise<MediaAttachment>;
  media?(id:string):Promise<{data:Buffer;mediaType:string}>;
  prepareMedia?(id:string):Promise<MediaAttachment>;
  uploadImage?(data: Buffer, mediaType: string): Promise<ImageAttachment>;
  image?(id: string): Promise<{data:Buffer;mediaType:string}>;
  stream(id: string, after: number): Promise<MimiStreamSnapshot>;
  tasks(): Promise<unknown>;
  task(id: string): Promise<unknown>;
  taskAction(id: string, action: 'pause' | 'resume' | 'cancel', context?: string): Promise<unknown>;
  memory(id: string): Promise<unknown>;
  memoryRead(id: string, scope: 'private' | 'workspace', memoryId: string): Promise<unknown>;
  models(id: string): Promise<unknown>;
  model(id: string, target: ModelTarget | null): Promise<unknown>;
  mode(id: string, mode: 'general' | 'plan' | 'ultra'): Promise<unknown>;
}

export function daemonWebBackend(config: AppConfig, options: { homeDirectory?: string } = {}): WebBackend {
  // Web startup must not restart, upgrade, or silently launch an existing daemon.
  const client = new MimiChatClient(config, async (_config, status) => status, {
    submitRetryDeadlineMs: 5_000,
    startDaemon: async () => { throw new Error('后台服务未连接，请先运行 mimi daemon start。'); },
  });
  const daemonPaths = mimiPaths(config);
  const socket = daemonPaths.socket;
  const workspaceCache = new Map<string,string>();
  const rememberWorkspace = (id:string, root:string) => {
    workspaceCache.set(id,root);
    if(workspaceCache.size>500) workspaceCache.delete(workspaceCache.keys().next().value!);
  };
  const sessionWorkspace = (id: string): string => {
    assertSessionId(id);
    const cached = workspaceCache.get(id);
    if (cached) return cached;
    const fallback = existsSync(path.join(config.dataRoot, 'sessions', `${id}.json`)) ? config.workspaceRoot : defaultWorkspaceRoot(options.homeDirectory);
    if (!existsSync(daemonPaths.database)) return fallback;
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(daemonPaths.database, { readOnly: true, timeout: 500 });
      const root = savedSessionWorkspace(database, id) ?? fallback;
      rememberWorkspace(id, root);
      return root;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
      throw error;
    } finally { database?.close(); }
  };
  const timeline = async (id: string, items: readonly unknown[]) => {
    let database: DatabaseSync | undefined;
    try {
      if (existsSync(daemonPaths.database)) database = new DatabaseSync(daemonPaths.database, { readOnly: true, timeout: 500 });
      return await decorateSessionTimeline({ dataRoot: config.dataRoot, sessionId: id, items, database });
    } finally { database?.close(); }
  };
  // Coalesce archive scans from multiple tabs; reading a large archive blocks daemon work.
  let sessionsPending: Promise<unknown> | undefined;
  let sessionsCache: unknown;
  let sessionsCachedAt = 0;
  const management = webManagement(config, (operation, value, session) => client.invoke(operation, value, session), (method, params) => mimiRpc(socket, method, params, 30_000));
  const modelConfig = () => config.modelsConfig ? new ModelConfigStore(config.modelsConfig).read() : Promise.resolve(legacyModelConfigurationForAppConfig(config));
  const availableModels = async (id: string, imageInput = false) => {
      const [models, preferences] = await Promise.all([modelConfig(), readFile(path.join(config.dataRoot,'sessions',`${id}.json`),'utf8').then(source => {
        // A Web-only build can be older than the daemon. Never run migration/recovery while inspecting its files.
        const preferences = JSON.parse(source)?.preferences;
        const target = modelTargetSchema.safeParse(preferences?.modelTarget);
        return { modelTarget: target.success ? target.data : undefined };
      }).catch((error: NodeJS.ErrnoException) => { if(error.code === 'ENOENT') return {modelTarget: undefined}; throw error; })]);
      const next = imageInput ? new WorkUnitModelResolver({
        providers: models.providers, routing: models.routing,
        isConfigured: provider => Boolean(process.env[provider.apiKeyEnv]?.trim()),
      }).resolve({scenario:'media-understanding.default',
        profile:{requirements:{imageInput:true,toolCalling:false}},routeVersion:models.routeVersion}).target
        : preferences.modelTarget ?? models.routing.scenarios['conversation.default']?.target ?? models.routing.globalDefault;
      return { choices: models.providers.flatMap(provider => provider.models.map(registration => ({ ...registration,
        provider: { id: provider.id, label: provider.label, transport: provider.transport }, configured: Boolean(process.env[provider.apiKeyEnv]?.trim()) }))),
        current: { sessionTarget: preferences.modelTarget, next: { target: next } } };
    };
  return {
    manageRead: management.read, manageWrite: management.write,
    status: async () => {
      const status = await mimiRpc<DaemonStatus>(socket, 'status', undefined, 8_000);
      // A UI-only build must not force an upgrade of a protocol-compatible daemon.
      if (status.protocolVersion !== DAEMON_PROTOCOL_VERSION) {
        throw new Error('后台协议与 Web 版本不兼容，请使用同一版本的 mimi daemon start 和 mimi web。');
      }
      return status;
    },
    // A large personal archive can exceed the CLI's default five-second timeout.
    sessions: () => {
      if (Date.now() - sessionsCachedAt < 10_000) return Promise.resolve(sessionsCache);
      sessionsPending ??= mimiRpc(socket, 'chat.sessions', undefined, 30_000).then((value) => {
        sessionsCache = value; sessionsCachedAt = Date.now(); return value;
      }).finally(() => { sessionsPending = undefined; });
      return sessionsPending;
    },
    session: async (id, draft) => {
      if (!draft) {
        const snapshot=await mimiRpc<MimiChatSnapshot>(socket, 'chat.snapshot', { profileId: 'owner', sessionKey: id, limit: 50 }, 15_000);
        if(snapshot.workspaceRoot)rememberWorkspace(id,snapshot.workspaceRoot);
        return { ...snapshot, ...await timeline(id, snapshot.items) };
      }
      const workspaceRoot=defaultWorkspaceRoot(options.homeDirectory);
      await mkdir(workspaceRoot,{recursive:true,mode:0o700});
      rememberWorkspace(id,workspaceRoot);
      const models = await modelConfig();
      const target = models.routing.scenarios['conversation.default']?.target ?? models.routing.globalDefault;
      const registration = models.providers.flatMap(p => p.models).find(m => m.target.providerId === target.providerId && m.target.modelId === target.modelId);
      return { sessionId: id, draft: true, workspaceRoot, provider: target.providerId, model: target.modelId,
        mode: 'general', outputLevel: 'tools', permissionMode: config.permissionMode ?? 'trusted',
        contextUsed: 0, contextWindow: registration?.contextWindow ?? 128_000, items: [], plan: [] };
    },
    history: async (id) => {
      const items = await client.history(id);
      return (await timeline(id, items)).items;
    },
    outputMedia:(session,file)=>readOutputMedia(config.dataRoot,sessionWorkspace(session),session,file),
    uploadMedia:(data,type)=>saveMedia(path.join(daemonPaths.root,'web-media'),data,type),
    media:id=>readMedia(path.join(daemonPaths.root,'web-media'),id),
    prepareMedia:id=>prepareMedia(path.join(daemonPaths.root,'web-media'),id),
    uploadImage: (data,mediaType) => saveWebImage(path.join(daemonPaths.root,'web-images'),data,mediaType),
    image: id => readWebImage([path.join(daemonPaths.root,'web-images'),path.join(daemonPaths.root,'attachments')],id),
    submit: async (id, input, requestId, security, workspaceRoot, images, media) => {
      const mediaRefs=mediaIds(media),prepared:MediaAttachment[]=[];
      if(mediaRefs.length) {
        const daemon=await mimiRpc<{supportsWebMedia?:boolean}>(socket,'status',undefined,8000);
        if(!daemon.supportsWebMedia)throw new Error('需要在当前任务结束后重启后台以启用音视频消息');
        for(const ref of mediaRefs)prepared.push(await prepareMedia(path.join(daemonPaths.root,'web-media'),ref));
      }
      const ids = imageIds(images);
      if(ids.length || prepared.some(ref=>ref.kind==='video')) {
        const daemon=await mimiRpc<{supportsWebImages?:boolean}>(socket,'status',undefined,8_000);
        if(!daemon.supportsWebImages)throw new Error('后台仍运行旧版本，请在当前任务完成后重启 Mimi 后台以启用图片发送');
        const catalog=await availableModels(id,true);
        const target=catalog.current.next.target;
        const selected=catalog.choices.find(choice=>choice.target.providerId===target.providerId&&choice.target.modelId===target.modelId);
        if(!selected?.capabilities.imageInput)throw new Error('未配置可用的视觉模型，请在模型接入中配置支持图像理解的模型');
      }
      let total = 0;
      for (const image of ids) total += (await readWebImage([path.join(daemonPaths.root,'web-images')],image)).data.length;
      if(total > IMAGE_TOTAL_BYTES) throw new Error('图片合计不能超过 20MB');
      const root = workspaceRoot ? await validateWorkspace(workspaceRoot) : sessionWorkspace(id);
      if (root === defaultWorkspaceRoot(options.homeDirectory)) await mkdir(root, { recursive: true, mode: 0o700 });
      const submission=await client.submit(input, id, { requestId, requestedSecurityProfile: security, workspaceRoot: root, ...(ids.length ? {webImages:ids} : {}), ...(mediaRefs.length ? {webMedia:mediaRefs} : {}) });
      if(root)rememberWorkspace(id,root);
      return submission;
    },
    context: async (id) => {
      // Inspection snapshots bypass the mutable Session lane while a run is active.
      const snapshot = await mimiRpc<MimiChatSnapshot>(socket, 'chat.snapshot', { profileId: 'owner', sessionKey: id, limit: 1 }, 8_000);
      const m = snapshot.contextManifest;
      return { contextWindow: snapshot.contextWindow, estimatedTokens: m?.estimatedInputTokens ?? snapshot.contextUsed,
        lastRequestInputTokens: m?.actual?.inputTokens, source: snapshot.contextStatus?.source,
        inputBudget: m?.availableInputBudget, outputReserve: m?.outputReserve,
        sections: m?.sections, requestId: m?.requestId, observedAt: m?.createdAt,
        protocolReserveTokens: m?.sections.find(s => s.id === 'protocol-reserve')?.estimatedTokens,
        detailAvailable: !!m, estimateScope: m ? 'last_request' : 'snapshot',
      };
    },
    stream: (id, after) => mimiRpc<MimiStreamSnapshot>(socket, 'event.stream', { id, after }, 8_000),
    tasks: () => mimiRpc(socket, 'tasks.list', { limit: 100, projection: 'list' }, 30_000),
    task: (id) => mimiRpc(socket, 'tasks.get', { id }, 30_000),
    taskAction: (id, action, context) => {
      if (action === 'pause') return client.pauseBackgroundTask(id, '用户从 Web 暂停');
      if (action === 'cancel') return client.cancelBackgroundTask(id, '用户从 Web 取消');
      return client.resumeBackgroundTask(id, context);
    },
    memory: async (id) => memoryEvidence(config.dataRoot, sessionWorkspace(id)),
    memoryRead: async (id, scope, memoryId) => readMemoryEvidence(config.dataRoot, sessionWorkspace(id), scope, memoryId),
    models: availableModels,
    model: (id, target) => client.invoke('model.control', target ? { action: 'use', target } : { action: 'auto' }, id),
    mode: (id, mode) => client.invoke('mode.set', mode, id),
  };
}
