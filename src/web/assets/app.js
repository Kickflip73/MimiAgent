import { createRecorder } from './recorder.js';
import { createMediaDrafts, mediaMarkup, mediaTime, bindMediaPlayers, outputMedia } from './media.js';
import { createMessageBody, messageBlocks, observeMessageMotion } from './message-view.js';
import { createImageDrafts, imageUrl } from './images.js';
import { createMessageQueue } from './queue.js';
import { contextBreakdown } from './context.js';
import { createManagement, managedViews, viewTitles } from './manage.js';
import { historyExecution, projectEvent, finishAnswers, runningActivity, elapsedLabel, createTextReveal, presentAnswer, renderStreamText, executionGroups } from './execution.js';
import { setupPickers, createSelectionQueue, enhanceSelects } from './pickers.js';
const $ = (selector) => document.querySelector(selector);
const icons = {
  plus: 'M12 5v14M5 12h14',
  hammer: 'm14 4 6 6-3 3-3-3-8 10-3-3 10-8-3-3 4-4Zm-4 2 3-3 4 1 4 4-1 4',
  chat: 'M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 3V6a2 2 0 0 1 2-2Z M7 9h10M7 13h6',
  stack: 'm12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5',
  spark: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z',
  search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  settings: 'M4 7h16M4 17h16M8 4v6M16 14v6',
  refresh:
    'M20 7v5h-5M4 17v-5h5M19 11a7 7 0 0 0-12-5L4 9m16 6-3 3a7 7 0 0 1-12-5',
  menu: 'M4 6h16M4 12h16M4 18h16',
  sun: 'M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  branch:
    'M6 8v8m0-8a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm0 14a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm12-14a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM18 8v3a6 6 0 0 1-6 6H9',
  file: 'M14 3H5v18h14V8l-5-5Zm0 0v5h5M8 12h8M8 16h6',
  arrow: 'M5 12h14m-6-6 6 6-6 6',
  up: 'M12 19V5m-6 6 6-6 6 6',
  copy: 'M9 9h11v11H9ZM5 15H4V4h11v1',
  edit: 'm16 3 5 5-12 12H4v-5L16 3Zm-2 2 5 5',
  leaf: 'M20 3C9 2 2 8 5 16c8 6 16-1 15-13ZM5 20l10-11',
  close: 'M6 6l12 12M6 18 18 6',
  check: 'm5 12 4 4L19 6',
  clock: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
};
const icon = (name) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${icons[name] || icons.file}"/></svg>`;
document.querySelectorAll('[data-icon]').forEach((el) => {
  el.innerHTML = icon(el.dataset.icon);
});
const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (ch) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        ch
      ],
  );
const state = {
  sessionId:
    sessionStorage.getItem('mimi-session') ||
    `mimi-chat-${crypto.randomUUID()}`,
  draft: !sessionStorage.getItem('mimi-session') || sessionStorage.getItem('mimi-draft') === '1',
  view: 'chat',
  sessions: [],
  tasks: [],
  memory: [],
  filter: 'all',
  snapshot: null,
  status: null,
  online: false,
  initialized: false,
  source: null,
  streamId: null,
  revision: 0,
  refreshing: false,
  pending: null,
  detailRevision: 0,
  models: [],
  changing: false,
  defaults: {mode: 'general', outputLevel: 'tools', expandExecution: false},
  memoryFilter: 'all',
  loading: false,
  recoverRun: null,
  archiveUpdatedAt: 0,
};
let pickers;
const selectionKey = (kind, session = state.sessionId) => JSON.stringify([session, kind]);
const selections = createSelectionQueue(async (key, value) => {
  const [sessionId, kind] = JSON.parse(key);
  await api(kind, { sessionId, ...(kind === 'mode' ? { mode: value } : { target: value }) });
}, (key) => {
  if (JSON.parse(key)[0] === state.sessionId) syncSelections();
});
function syncSelections() {
  const mode = selections.get(selectionKey('mode'));
  const model = selections.get(selectionKey('model'));
  state.changing = !!(mode?.pending || model?.pending);
  $('#mode').dataset.pending = String(!!mode?.pending);
  $('#model').dataset.pending = String(!!model?.pending);
  if (mode && state.snapshot) {
    $('#mode').value = mode.value;
    state.snapshot.mode = mode.value;
  }
  if (model && state.models.length) {
    const index = state.models.findIndex((m) => m.target.providerId === model.value?.providerId && m.target.modelId === model.value?.modelId);
    $('#model').value = index < 0 ? 'auto' : String(index);
    $('#model').title = model.value ? `${model.value.modelId} · ${model.value.providerId}` : '自动选择模型';
  }
  if (!state.loading) $('#selection-status').textContent = mode?.error || model?.error ? '切换失败，请重新选择重试' : '';
  updateComposer();
}
const management = createManagement({ api, esc, markdown, getSession: () => state.sessionId, openDialog, onSessionSettings: (value) => { selections.seed(selectionKey('mode'), value.mode); syncSelections(); state.defaults.outputLevel = value.outputLevel; state.defaults.expandExecution = value.expandExecution; document.querySelectorAll('.execution').forEach(details => { details.open = value.expandExecution; details.update?.(); }); }, onSettings: (value) => {
  state.defaults = value;
  document.querySelectorAll('.execution').forEach(details => { details.open = value.expandExecution; details.update?.(); });
} });
const completedRuns = new Map();
try {
  for (const [id, records] of JSON.parse(sessionStorage.getItem('mimi-executions') || '[]')) completedRuns.set(id, records);
} catch { /* An unavailable browser cache must not prevent connecting. */ }
function saveExecutions() {
  try {
    const entries = [...completedRuns].slice(-10);
    let serialized = JSON.stringify(entries);
    while (serialized.length > 500_000 && entries.length) { entries.shift(); serialized = JSON.stringify(entries); }
    sessionStorage.setItem('mimi-executions', serialized);
  } catch { /* Execution details remain available in this page if storage is full. */ }
}
const drafts = new Map();
const mediaDrafts = createMediaDrafts({storage:sessionStorage,
  upload:async file=>{const response=await fetch('/api/media',{method:'POST',headers:{'content-type':file.type,'x-mimi-web':'1'},body:file,signal:AbortSignal.timeout(60_000)});const result=await response.json();if(!response.ok)throw new Error(result.error||'媒体上传失败');return result;},
  prepare:async id=>{const response=await fetch('/api/media/prepare',{method:'POST',headers:{'content-type':'application/json','x-mimi-web':'1'},body:JSON.stringify({id}),signal:AbortSignal.timeout(180_000)});const result=await response.json();if(!response.ok)throw new Error(result.error||'识别失败');return result;},
  changed:session=>{if(session===state.sessionId){renderMediaDrafts();renderImageDrafts();updateComposer();}},
});
function renderMediaDrafts() {
  const items=mediaDrafts.list(state.sessionId),root=$('#media-drafts');root.hidden=!items.length;
  root.innerHTML=items.map(item=>`<div class="media-draft">${mediaMarkup(item,esc)}<button type="button" class="image-remove" data-remove-media="${esc(item.key||item.id)}" aria-label="移除媒体">×</button>${item.pending?`<p class="media-progress"><span class="mini-spinner"></span>${item.id?(item.kind==='audio'?'正在识别…':'正在准备视频…'):'正在上传…'}</p>`:item.error?`<p class="media-error">${esc(item.error)} ${item.id?`<button type="button" data-retry-media="${esc(item.key||item.id)}">重试</button>`:''}</p>`:!item.ready?`<button type="button" class="media-resume" data-retry-media="${esc(item.key||item.id)}">继续${item.kind==='audio'?'识别':'准备'}</button>`:''}</div>`).join('');
}
async function addMedia(session,file){try{if(mediaDrafts.list(session).length+imageDrafts.list(session).length>=8)throw new Error('每条消息最多 8 个附件');await mediaDrafts.add(session,file);}catch(error){toast(error.message);}}
let recordingDevicesKey;
const recorder = createRecorder({
  changed:({active,requesting,elapsed,devices=[],deviceId,deviceLabel,level=0,noSignal=false})=>{const button=$('#record-voice');button.classList.toggle('is-recording',active);button.disabled=requesting;button.setAttribute('aria-label',active?'结束录音':'录制语音');$('#recording-state').hidden=!active&&!requesting;$('#recording-time').textContent=requesting?'正在请求麦克风…':mediaTime(elapsed/1000);
    const meter=$('.recording-meter'),volume=Math.min(100,Math.round(Math.sqrt(level)*300));meter.style.setProperty('--level',`${volume}%`);meter.setAttribute('aria-valuenow',String(volume));
    $('#recording-signal').textContent=noSignal?'未收到声音，请检查静音或切换麦克风':'录音中';$('#recording-state').classList.toggle('no-signal',noSignal);
    const key=JSON.stringify([devices.map(d=>[d.deviceId,d.label]),deviceId]);
    if(key!==recordingDevicesKey){
      recordingDevicesKey=key;const root=$('#recording-device');
      root.innerHTML=devices.length?`<select aria-label="录音麦克风" title="更换麦克风将重新录音">${devices.map((d,i)=>`<option value="${esc(d.deviceId)}" ${d.deviceId===deviceId?'selected':''}>${esc(d.label||`麦克风 ${i+1}`)}</option>`).join('')}</select>`:esc(deviceLabel||'麦克风');
      const select=root.querySelector('select');if(select){select.onchange=()=>void recorder.selectDevice(select.value);enhanceSelects(root);root.querySelector('.picker-trigger').setAttribute('aria-label','录音麦克风');root.querySelector('.picker-trigger').title='更换麦克风将重新录音';}
    }
    updateComposer();},
  complete:(session,file)=>{void addMedia(session,file);},error:error=>toast(error.message),
});
const imageDrafts = createImageDrafts({storage:sessionStorage,
  upload:async file => {
    const response=await fetch('/api/images',{method:'POST',headers:{'content-type':file.type,'x-mimi-web':'1'},body:file,signal:AbortSignal.timeout(30_000)});
    const result=await response.json(); if(!response.ok)throw new Error(result.error||'图片上传失败'); return result;
  },
  changed:session=>{if(session===state.sessionId){renderImageDrafts();updateComposer();}},
});
function imagesMarkup(images, editable=false) {
  return (images||[]).map(item=>{
    const src=item.src||imageUrl(item.id); if(!src)return '';
    return `<span class="image-thumb${item.pending?' is-uploading':''}"><button type="button" data-image-preview aria-label="放大查看图片"><img src="${esc(src)}" alt="${esc(item.name||'图片附件')}" /></button>${editable?`<button type="button" class="image-remove" data-remove-image="${esc(item.key||item.id)}" aria-label="移除图片">×</button>`:''}${item.pending?'<span class="image-upload-status">上传中</span>':''}</span>`;
  }).join('');
}
function renderImageDrafts() {
  const images=imageDrafts.list(state.sessionId),root=$('#image-drafts');
  root.hidden=!images.length;root.innerHTML=imagesMarkup(images,true);
  // Perception has its own model route; uploading must never switch the conversation model.
  $('#image-model-note').hidden=true;

}
async function addImages(files) {
  if(state.sending){toast('正在发送，请稍后添加图片');return;}
  const session=state.sessionId;
  for(const file of files)try{if(mediaDrafts.list(session).length+imageDrafts.list(session).length>=8)throw new Error('每条消息最多 8 个附件');if(file.type.startsWith('image/'))await imageDrafts.add(session,file);else await mediaDrafts.add(session,file);}catch(error){toast(error.message);}
}
const labels = {
  queued: '等待中',
  running: '进行中',
  completed: '已完成',
  partial: '部分完成',
  uncertain: '结果待核实',
  interrupted: '已中断',
  failed: '失败',
  dead_letter: '需要处理',
  paused: '已暂停',
  blocked: '等待输入',
  cancelled: '已取消',
  active: '有效',
  proposed: '待确认',
  expired: '已过期',
  superseded: '已更新',
  conflicted: '有冲突',
};
const modeId = (value) =>
  ({ 通用: 'general', Plan: 'plan', 'Ultra Team': 'ultra' })[
    value?.id || value
  ] ||
  value?.id ||
  value;
const active = (s) => ['queued', 'running'].includes(s);
const attention = (s) =>
  ['paused', 'blocked', 'failed', 'dead_letter'].includes(s);
let toastTimer;
function toast(text) {
  $('#toast').textContent = text;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $('#toast').hidden = true;
  }, 4500);
}
function banner(text) {
  $('#banner').textContent = text || '';
  $('#banner').hidden = !text;
}
function date(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}
function badge(status) {
  return `<span class="status-badge ${['failed', 'dead_letter'].includes(status) ? 'danger' : attention(status) ? 'warning' : ['cancelled', 'expired'].includes(status) ? 'neutral' : ''}">${esc(labels[status] || status)}</span>`;
}
function empty(title, description, name = 'leaf') {
  return `<div class="empty-state">${icon(name)}<h3>${esc(title)}</h3><p>${esc(description)}</p></div>`;
}
function connection(online) {
  state.online = online;
  $('#connection').className = `connection ${online ? 'online' : 'offline'}`;
  $('#connection').innerHTML =
    `<i></i>${online ? 'Mimi 已连接' : '正在恢复连接'}`;
  updateComposer();
}
function updateComposer() {
  const running = !!state.streamId;
  const button = $('#send');
  const images=imageDrafts.list(state.sessionId),media=mediaDrafts.list(state.sessionId);
  const hasInput=!!$('#message-input').value.trim()||images.length>0||media.length>0;
  const queueing = running && hasInput;
  button.type = running && !queueing ? 'button' : 'submit';
  button.setAttribute('aria-label', queueing ? '加入待发送队列' : running ? '停止生成' : '发送消息');
  button.title = queueing ? '加入待发送队列' : running ? '停止生成' : '发送消息';
  const stopping = running && state.stopping === state.streamId;
  button.disabled = running && !queueing ? stopping : !state.online || !hasInput || images.some(i=>i.pending) || media.some(i=>!i.ready||i.pending) || recorder.active || !!state.sending || state.loading || state.changing;
  button.classList.toggle('is-stopping', stopping);
  button.setAttribute('aria-busy', String(stopping));
  if (stopping) { button.setAttribute('aria-label', '正在停止'); button.title = '正在停止'; }
  $('#attach-image').disabled=!!state.sending || state.loading;
  button.innerHTML = stopping ? '<span class="stop-spinner" aria-hidden="true"></span>' : running && !queueing ? '<span class="stop-square" aria-hidden="true"></span>' : icon('up');
  $('#composer-cat').classList.toggle('is-running', running || !!state.sending);
  if (!running) { const label = state.sending ? '正在发送' : 'Mimi'; $('#composer-cat').title = label; $('#composer-cat').setAttribute('aria-label', label); }
  $('#run-elapsed').hidden = !running;
  updateContext();
  $('#mode').disabled =
    !state.online || !state.snapshot || state.loading;
  $('#model').disabled =
    !state.online || state.loading || !state.models.length;
  syncSecurity();
  pickers?.sync();
}
function syncSecurity() {
  const levels = ['safe', 'workstation', 'full-owner'];
  const ceiling = state.status?.securityProfile?.id || ({ trusted: 'full-owner', workspace: 'workstation', safe: 'safe', 'read-only': 'safe' }[state.status?.permissionMode]) || 'safe';
  let selected = sessionStorage.getItem(`mimi-security:${state.sessionId}`) || (state.draft && state.defaults.security && state.defaults.security!=='inherit' ? state.defaults.security : ceiling);
  if (!levels.includes(selected) || levels.indexOf(selected) > levels.indexOf(ceiling)) selected = ceiling;
  const select = $('#security');
  for (const option of select.options) option.disabled = levels.indexOf(option.value) > levels.indexOf(ceiling);
  select.value = selected;
  select.disabled = !state.online || state.loading || !!state.sending;
}
const contextCache = new Map();
function contextDetails(info = {}, note = '') {
  const { total, used, percent, sections, actual, remaining } = contextBreakdown(info, state.snapshot || {});
  const number = value => Number.isFinite(value) ? Math.round(value).toLocaleString() : '尚无数据';
  const names = { 'base-instructions':'基础指令', 'session-state':'会话状态', soul:'人格设定', 'behavior-preferences':'行为偏好', 'runtime-context':'运行环境', 'project-guidance':'项目指导', 'goal-plan-team':'目标与计划', recovery:'恢复信息', 'memory-cards':'记忆', 'skill-catalog':'技能目录', 'active-skills':'已启用技能', 'work-snapshot':'工作快照', archive:'压缩归档', 'recent-history':'近期对话', 'current-input':'当前轮消息与工具结果', 'tool-schemas':'工具定义' };
  const colors = ['#242426','#62646b','#9699a0','#434952','#797c85','#b0b1b8','#53545e','#85858c'];
  let offset = 0;
  const slices = (sections.length ? sections : Number.isFinite(used) ? [{id:'total',share:used}] : []).map((s,i) => {
    const share = Math.max(0,Math.min(s.share / total * 100,100-offset));
    const svg = `<circle cx="60" cy="60" r="48" pathLength="100" fill="none" stroke="${colors[i%colors.length]}" stroke-width="10" stroke-dasharray="${share} ${100-share}" stroke-dashoffset="${-offset}"/>`; offset += share; return Number.isFinite(share) ? svg : '';
  }).join('');
  return `<div class="context-totals"><div><span>已用上下文${actual?'':' · 估算'}</span><strong>${number(used)}<small> tokens</small></strong></div><div><span>总窗口</span><strong>${number(total)}</strong></div><div><span>占用</span><strong>${percent === undefined ? '尚无数据' : percent.toFixed(1)+'%'}</strong></div></div>
    <div class="context-chart"><svg viewBox="0 0 120 120" role="img" aria-label="上下文占用环形图"><circle cx="60" cy="60" r="48" fill="none" stroke="#efeff1" stroke-width="10"/><g transform="rotate(-90 60 60)">${slices}</g><text x="60" y="57" text-anchor="middle">${percent===undefined?'—':percent.toFixed(1)+'%'}</text><text class="ring-caption" x="60" y="72" text-anchor="middle">上下文占用</text></svg><div class="context-legend">${sections.map((s,i)=>`<div><svg class="legend-dot" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5" fill="${colors[i%colors.length]}"/></svg><span>${esc(names[s.id]||s.id)}${s.truncated?' · 已裁剪':''}</span><strong>≈ ${number(s.estimatedTokens)}</strong></div>`).join('') || `<p class="settings-note">${note === '正在更新快照…' ? '正在读取分项…' : '尚无已保存的分项快照；下一次模型请求后会更新。'}</p>`}<div><svg class="legend-dot" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5" fill="#efeff1"/></svg><span>剩余窗口</span><strong>${number(remaining)}</strong></div></div></div>
    <p class="settings-note">${actual?'总量来自最近请求的实际输入。':'总量为最近请求或已保存历史的估算。'}${sections.length?'分项为请求组装时的估算；环形面积按其比例分配，可能与实际 token 数存在差异。':''}</p>
    ${Number.isFinite(info.outputReserve)?`<p class="settings-note">输出预留 ${number(info.outputReserve)} · 协议预留 ${number(info.protocolReserveTokens)}（不计入已用）</p>`:''}${note?`<p class="settings-note">${esc(note)}</p>`:''}`;
}
async function showContext() {
  const session = state.sessionId, revision = state.revision;
  openDialog('上下文占用', contextDetails(contextCache.get(session), '正在更新快照…'), 'CONTEXT');
  const request = state.detailRevision;
  try {
    const info = await api(`context?session=${encodeURIComponent(session)}`);
    if (session !== state.sessionId || revision !== state.revision) return;
    contextCache.set(session, info);
    if (contextCache.size > 20) contextCache.delete(contextCache.keys().next().value);
    if (request === state.detailRevision && $('#detail-dialog').open) $('#detail-content').innerHTML = contextDetails(info);
  } catch (error) {
    if (request === state.detailRevision && revision === state.revision && $('#detail-dialog').open) $('#detail-content').innerHTML = contextDetails(contextCache.get(session), '快照暂未更新：' + error.message);
  }
}
function updateContext() {
  const snapshot = state.snapshot;
  const known = Number.isFinite(snapshot?.contextWindow) && snapshot.contextWindow > 0 && Number.isFinite(snapshot?.contextUsed);
  $('#context-indicator').hidden = !known;
  if (!known) return;
  const percent = Math.max(0, Math.min(100, Math.round(snapshot.contextUsed / snapshot.contextWindow * 100)));
  $('#context-label').textContent = `${percent}%`;
  $('#context-ring').style.strokeDasharray = `${percent} 100`;
  const description = `上下文 ${percent}% · ${snapshot.contextUsed.toLocaleString()} / ${snapshot.contextWindow.toLocaleString()} tokens`;
  $('#context-indicator').title = description;
  $('#context-indicator').setAttribute('aria-label', description);
}
function runActivity(text) {
  $('#composer-cat').title = text;
  $('#composer-cat').setAttribute('aria-label', text);
}
function copyButton(text) {
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'icon-button copy-button';
  button.setAttribute('aria-label', '复制回答'); button.title = '复制回答';
  button.innerHTML = icon('copy');
  button.onclick = () => navigator.clipboard.writeText(text).then(() => toast('已复制')).catch(() => toast('复制失败，请手动选择文本'));
  return button;
}
async function api(path, data) {
  let response;
  try { response = await fetch(`/api/${path}`, {
    method: data === undefined ? 'GET' : 'POST',
    headers:
      data === undefined
        ? {}
        : { 'content-type': 'application/json', 'x-mimi-web': '1' },
    body: data === undefined ? undefined : JSON.stringify(data),
    signal: AbortSignal.timeout(data?.action==='workspace.choose'?125_000:40_000),
  }); } catch (cause) {
    const error = new Error(cause.name === 'TimeoutError' ? '请求响应较慢，正在重试' : 'Web 服务连接中断，请确认 mimi web 正在运行');
    error.status = 0; throw error;
  }
  const value = await response.json();
  if (!response.ok) {
    const error = new Error(value.error || '请求失败');
    error.status = response.status;
    throw error;
  }
  return value;
}
function inline(source) {
  const escaped = esc(source);
  return escaped.replace(
    /`([^`]+)`|\[([^\]]+)\]\(((?:https?:\/\/|file:\/\/\/|\/)[^\n)]+)\)|\*\*([^*]+)\*\*/g,
    (match, code, label, url, bold) => {
      if (code !== undefined) return `<code>${code}</code>`;
      if (url !== undefined && !/^https?:/.test(url)) return /\.(png|jpe?g|gif|webp|mp3|wav|m4a|ogg|flac|mp4|webm|mov)$/i.test(url) ? `<span class="media-reference">${label}</span>` : match;
      if (url !== undefined)
        return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
      return `<strong>${bold}</strong>`;
    },
  );
}
function markdown(source) {
  const lines = String(source ?? '').split('\n');
  let html = '',
    i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      const language=line.slice(3).trim().slice(0,30)||'code';
      const code = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```'))
        code.push(lines[i++]);
      i++;
      html += `<section class="code-block"><header><span>${esc(language)}</span><button type="button" data-copy-code aria-label="复制代码" title="复制代码">${icon('copy')}</button></header><pre><code>${esc(code.join('\n'))}</code></pre></section>`;
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    if (
      i + 1 < lines.length &&
      line.includes('|') &&
      /^\s*\|?\s*:?-{3,}/.test(lines[i + 1])
    ) {
      const cells = (s) => s.replace(/^\s*\||\|\s*$/g, '').split('|');
      html +=
        '<div class="table-wrap"><table><thead><tr>' +
        cells(line)
          .map((c) => `<th>${inline(c)}</th>`)
          .join('') +
        '</tr></thead><tbody>';
      i += 2;
      while (i < lines.length && lines[i].includes('|'))
        html +=
          '<tr>' +
          cells(lines[i++])
            .map((c) => `<td>${inline(c)}</td>`)
            .join('') +
          '</tr>';
      html += '</tbody></table></div>';
      continue;
    }
    const heading = line.match(/^#{1,6}\s+(.+)/);
    if (heading) {
      html += `<h3>${inline(heading[1])}</h3>`;
      i++;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      html += '<ul>';
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i]))
        html += `<li>${inline(lines[i++].replace(/^\s*[-*]\s+/, ''))}</li>`;
      html += '</ul>';
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      html += '<ol>';
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i]))
        html += `<li>${inline(lines[i++].replace(/^\s*\d+[.)]\s+/, ''))}</li>`;
      html += '</ol>';
      continue;
    }
    if (line.startsWith('> ')) {
      html += `<blockquote>${inline(line.slice(2))}</blockquote>`;
      i++;
      continue;
    }
    const paragraph = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,6}\s|```|> |\s*[-*]\s|\s*\d+[.)]\s)/.test(lines[i])
    )
      paragraph.push(lines[i++]);
    html += `<p>${paragraph.map(inline).join('<br>')}</p>`;
  }
  return html;
}
function textOf(item) {
  if(item.mediaAttachments?.length && typeof item.displayText==='string')return item.displayText;
  if (typeof item.content === 'string') return item.content;
  return (item.content || [])
    .map((part) => item.imageAttachments?.length && part.text === '[图片附件：本轮已读取，二进制未写入 Session 历史]' ? '' : part.text || (part.type === 'input_image' ? '[图片]' : ''))
    .join('\n');
}
function messageFooter(text, { role = 'assistant', sentAt, timestampSource, duration, copy = true } = {}) {
  if (role === 'assistant') text = presentAnswer(text).text;
  const footer = document.createElement('div');
  footer.className = 'message-footer';
  const time = document.createElement('time');
  time.className = 'message-time';
  const stamp = sentAt ? new Date(sentAt) : null;
  const known = stamp && Number.isFinite(stamp.getTime());
  time.textContent = known ? new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(stamp) : '时间未记录';
  if (known) { time.dateTime = stamp.toISOString(); const label = {'run-start':'本轮开始','run-end':'本轮结束','event':'执行记录时间'}[timestampSource]; time.title = `${label ? label + ' · ' : ''}${stamp.toLocaleString('zh-CN')}`; }
  footer.append(time);
  if (role === 'assistant' && (copy || Number.isFinite(duration))) {
    const actions = document.createElement('div');
    actions.className = 'message-actions';
    if (Number.isFinite(duration)) {
      const elapsed = document.createElement('span');
      elapsed.className = 'answer-duration';
      elapsed.textContent = elapsedLabel(duration);
      elapsed.title = `本次用时 ${elapsedLabel(duration)}`;
      elapsed.setAttribute('aria-label', elapsed.title);
      actions.append(elapsed);
    }
    if (copy) actions.append(copyButton(text));
    footer.append(actions);
  }
  return footer;
}
function setMessageFooter(article, text, metadata) {
  const content = article.querySelector('.message-content');
  content.querySelector(':scope > .message-footer')?.remove();
  content.querySelector('.message-bubble').after(messageFooter(text, metadata));
}
function message(role, text, live = false, sentAt, images = [], media = []) {
  if (role === 'assistant') text = presentAnswer(text).text;
  const el = document.createElement('article');
  el.className = `message ${role}`;
  el.tabIndex = 0;
  el.dataset.messageText = text;
  if (sentAt) el.dataset.sentAt = String(sentAt);
  if (live) el.id = 'live-message';
  el.innerHTML = `<div class="message-avatar">${role === 'user' ? '我' : '<img src="/cat.svg" alt="" />'}</div><div class="message-content"><div class="message-author">${role === 'user' ? '你' : 'Mimi'}</div></div>`;
  el.querySelector('.message-content').append(createMessageBody(messageBlocks(text, images, [...media,...(role==='assistant'?outputMedia(text,state.sessionId):[])]), {markdown, imagesMarkup, mediaMarkup:ref=>mediaMarkup(ref,esc)}));
  if (!live) setMessageFooter(el, text, { role, sentAt });
  return el;
}
function executionMessage(panel) {
  const article = message('assistant', '', true);
  article.removeAttribute('id');
  article.classList.add('execution-message');
  article.querySelector('.message-bubble').before(panel);
  return article;
}
function renderMessages(items) {
  $('#messages').replaceChildren();
  const visible = (items || []).filter(
    (item) => ['user', 'assistant'].includes(item.role) && (textOf(item).trim() || item.imageAttachments?.length || item.mediaAttachments?.length),
  );
  $('#welcome').hidden = visible.length > 0;
  if (visible.length) {
    const older = document.createElement('button');
    older.className = 'text-button history-button';
    older.textContent = '加载完整历史';
    older.onclick = async () => {
      const id = state.sessionId;
      older.disabled = true;
      try {
        const history = await api(`history?id=${encodeURIComponent(id)}`);
        if (id === state.sessionId) {
          const live = $('#live-message');
          const lastUser = history.findLastIndex((item) => item.role === 'user');
          renderMessages(state.streamId && lastUser >= 0 ? history.slice(0, lastUser + 1) : history);
          if (live && state.streamId) $('#messages').append(live);
          $('#messages > button')?.remove();
        }
      } catch (error) {
        toast(error.message);
        older.disabled = false;
      }
    };
    $('#messages').append(older);
  }
  for (const item of visible) {
    const article = message(item.role, textOf(item), false, item.timestamp || item.createdAt, item.imageAttachments, item.mediaAttachments);
    setMessageFooter(article, textOf(item), {role:item.role,sentAt:item.timestamp || item.createdAt,timestampSource:item.timestampSource,duration:item.duration});
    if (item.timelineRunId) article.dataset.timelineRun = item.timelineRunId;
    if (item.role === 'assistant') {
      const display = presentAnswer(textOf(item));
      if (item.execution || display.outcome) article.querySelector('.message-bubble').before(executionDetails({...item.execution, steps:item.execution?.steps || [], ...(display.outcome ? {status:display.outcome} : {}), historical:true}));
    }
    $('#messages').append(article);
    if (item.executionAfter || (item.execution && item.role === 'user')) {
      const process = executionMessage(executionDetails({...item.executionAfter || item.execution,historical:true})); $('#messages').append(process);
    }
  }
  if (state.snapshot?.timeline?.truncated) {
    const note = document.createElement('p'); note.className = 'timeline-note'; note.textContent = '部分较早的执行过程未完整加载'; $('#messages').prepend(note);
  }
  const attached = new Set();
  const articles = [...$('#messages').querySelectorAll('article:not(.execution-message)')];
  for (const record of [...(completedRuns.get(state.sessionId) || [])].reverse()) {
    const index = visible.findLastIndex((item, index) => !attached.has(index) && item.role === 'user' && textOf(item) === record.userText);
    attached.add(index);
    if (index < 0 || visible[index].timelineRunId || visible[index + 1]?.execution) continue;
    setMessageFooter(articles[index], record.userText, { role: 'user', sentAt: record.sentAt || record.startedAt });
    if (!articles[index + 1]?.classList.contains('assistant') && record.status === 'cancelled' && record.answers?.length) {
      let previous = articles[index];
      record.answers.forEach((text, answerIndex) => {
        const partial = message('assistant', text);
        const final = answerIndex === record.answers.length - 1;
        setMessageFooter(partial, text, {sentAt:final ? record.endedAt : record.answerTimes?.[answerIndex], ...(final ? {duration:record.endedAt-record.startedAt} : {})});
        for (const group of executionGroups(record)) {
          const panel = () => executionDetails({...record,steps:group.steps});
          if (group.afterAnswer + 1 === answerIndex) partial.querySelector('.message-bubble').before(panel());
        }
        previous.after(partial); previous = partial;
      });
      for (const group of executionGroups(record)) if(group.afterAnswer + 1 >= record.answers.length) {
        const tail=executionMessage(executionDetails({...record,steps:group.steps}));previous.after(tail);previous=tail;
      }
    }
    if (articles[index + 1]?.classList.contains('assistant')) {
      // Replace the legacy-envelope fallback with the cached detailed execution.
      articles[index + 1].querySelector('.execution')?.remove();
      const replies = [];
      for (let at = index + 1; at < articles.length && articles[at].classList.contains('assistant'); at++) replies.push(articles[at]);
      for (const group of executionGroups(record)) {
        const target = replies[group.afterAnswer + 1];
        const panel = executionDetails({...record,steps:group.steps});
        if (target) target.querySelector('.message-bubble').before(panel);
        else { const tail=executionMessage(panel);replies.at(-1)?.after(tail); }
      }
      let end = index + 1;
      while (end + 1 < visible.length && visible[end + 1].role === 'assistant') end++;
      for (let at = index + 1; at <= end; at++) {
        const final = at === end;
        setMessageFooter(articles[at], textOf(visible[at]), { sentAt: final ? record.endedAt : record.answerTimes?.[at - index - 1], ...(final ? { duration: record.endedAt - record.startedAt } : {}) });
      }
    }
  }
}
function scrollEnd() {
  const el = $('#chat-scroll');
  el.scrollTop = el.scrollHeight;
}
function renderSessions() {
  const query = $('#session-search').value.trim().toLowerCase();
  const list = state.sessions
    .filter(
      (s) =>
        (query ||
          !/^mimi-(task-|connector-|routine-|system|briefing)/.test(s.id)) &&
        (s.title + ' ' + s.preview).toLowerCase().includes(query),
    )
    .slice(0, 100);
  $('#sessions').innerHTML = list.length
    ? list
        .map(
          (s) =>
            `<button class="session-row ${s.id === state.sessionId ? 'selected' : ''}" data-session="${esc(s.id)}" title="${esc(s.title)}">${esc(s.title || '新的对话')}</button>`,
        )
        .join('')
    : '<p class="sidebar-hint">' +
      (query ? '没有匹配的对话' : state.archivePending ? '正在读取最近对话…' : '还没有对话，从一句话开始。') +
      '</p>';
}
function renderPlan(steps) {
  $('#plan').hidden = !steps?.length;
  $('#plan').innerHTML = steps?.length
    ? `<details><summary>当前计划 · ${steps.filter((s) => s.status === 'completed').length}/${steps.length} 已完成</summary><ol>${steps.map((s) => `<li>${esc(s.description)} · ${esc(labels[s.status] || s.status)}</li>`).join('')}</ol></details>`
    : '';
}
async function selectSession(id, draft = false, preserveInput = false) {
  drafts.set(state.sessionId, $('#message-input').value);
  pickers?.close();
  state.revision++;
  const revision = state.revision;
  const modeVersion = selections.version(selectionKey('mode', id));
  state.disposeRun?.();
  state.source?.close();
  state.source = null;
  state.recoverRun = null;
  state.finishRun = null;
  state.streamId = null;
  state.loading = true;
  showSessionLoading();
  state.changing = false;
  state.sending = false;
  state.models = [];
  $('#model').innerHTML = '<option>读取模型…</option>';
  $('#retry-models').hidden = true;
  $('#selection-status').textContent = '正在读取会话…';
  if(recorder.active)recorder.stop();
  state.sessionId = id;
  state.draft = draft;
  state.snapshot = null;
  sessionStorage.setItem('mimi-session', id);
  sessionStorage.setItem('mimi-draft', draft ? '1' : '0');
  renderPlan([]);
  renderSessions();
  renderMessages([]);
  renderQueue();
  renderImageDrafts(); renderMediaDrafts();
  if (!preserveInput) $('#message-input').value = drafts.get(id) || '';
  resizeInput();
  updateComposer();
  setView('chat');
  closeMenu();
  try {
    const snapshot = await api(
      `session?id=${encodeURIComponent(id)}${draft ? '&draft=1' : ''}`,
    );
    if (revision !== state.revision) return;
    snapshot.mode = modeId(snapshot.mode);
    if (snapshot.draft && !sessionStorage.getItem(`mimi-defaults:${id}`)) {
      if (state.defaults.mode !== 'general' || state.defaults.outputLevel !== 'tools') {
        void api('manage', { action: 'settings.apply', sessionId: id, value: state.defaults }).catch(error => { if(revision === state.revision) toast(error.message); });
        snapshot.mode = state.defaults.mode;
      }
      sessionStorage.setItem(`mimi-defaults:${id}`, '1');
    }
    selections.seed(selectionKey('mode', id), snapshot.mode, modeVersion);
    state.snapshot = snapshot;
    if(!snapshot.draft || !sessionStorage.getItem(`mimi-workspace:${id}`))sessionStorage.setItem(`mimi-workspace:${id}`,snapshot.workspaceRoot);
    renderWorkspace();
    state.draft = !!snapshot.draft;
    const discovered = state.tasks.find(t => t.sessionId === id && active(t.status));
    const runningId = sessionStorage.getItem(`mimi-run:${id}`) || discovered?.taskId;
    if (runningId) {
      sessionStorage.setItem(`mimi-run:${id}`, runningId);
      const started = Date.parse(discovered?.workUnit?.result?.startedAt || discovered?.createdAt || '');
      if (Number.isFinite(started) && !sessionStorage.getItem(`mimi-start:${runningId}`)) sessionStorage.setItem(`mimi-start:${runningId}`,String(started));
    }
    const items = snapshot.items || [];
    const lastUser = items.findLastIndex((item) => item.role === 'user');
    renderMessages(runningId && lastUser >= 0 ? items.slice(0, lastUser + 1) : items);
    renderPlan(snapshot.plan);
    $('#mode').value = snapshot.mode;
    $('#model').innerHTML =
      `<option value="">${esc(snapshot.model || '读取模型…')}</option>`;
    void loadModels(id, revision);
    syncSelections();
    updateContext();
    scrollEnd();
    if (runningId) startStream(runningId);
    if(sessionStorage.getItem(`mimi-execution:${id}`)) {const saved=JSON.parse(sessionStorage.getItem(`mimi-execution:${id}`));void openExecutionSession(id,saved.execution,saved.runId,true);}
    else if(id.startsWith('mimi-task-'))void openExecutionSession(id,id.slice('mimi-task-'.length),undefined,true);
  } catch (error) {
    if (revision === state.revision) {
      showSessionLoading(error.message);
    }
  } finally {
    if (revision === state.revision) {
      state.loading = false;
      if (state.snapshot) { $('#session-loading').hidden = true; $('#chat-scroll').hidden = false; $('.composer-dock').hidden = false; resizeInput(); scrollEnd(); }
      $('#selection-status').textContent = state.snapshot
        ? ''
        : '会话读取失败，请点击右上角刷新重试';
      if (state.snapshot) syncSelections();
      else updateComposer();
    }
  }
}
function showSessionLoading(error) {
  $('#session-loading').hidden = false;
  $('#session-loading').classList.toggle('load-failed', !!error);
  $('#loading-title').textContent = error ? '暂时无法打开对话' : '正在打开对话';
  $('#loading-description').textContent = error || 'Mimi 正在整理这段对话…';
  $('#retry-session').hidden = !error;
  $('#chat-scroll').hidden = true;
  $('.composer-dock').hidden = true;
}
$('#retry-session').onclick = () => void selectSession(state.sessionId, state.draft, true);
function setView(view) {
  state.view = view;
  document.querySelectorAll('.view').forEach((el) => {
    el.hidden = el.id !== (managedViews.includes(view) ? 'manage-view' : `${view}-view`);
  });
  document.querySelectorAll('[data-view]').forEach((el) => {
    el.classList.toggle('active', el.dataset.view === view);
  });
  $('#view-title').textContent = {
    chat: '对话',
    tasks: '后台任务',
    memory: '记忆',
    ...viewTitles,
  }[view];
  closeMenu();
  if (view === 'chat') { void state.recoverRun?.(); resizeInput(); renderQueue(); }
  if (view === 'tasks') renderTasks();
  if (view === 'memory') void loadMemory();
  if (managedViews.includes(view)) void management.show(view);
  else management.leave();
}
function closeMenu() {
  $('#sidebar').classList.remove('open');
  $('#scrim').hidden = true;
  $('#mobile-menu').setAttribute('aria-expanded', 'false');
}
async function refresh(forceArchive = false) {
  if (state.refreshing) return;
  state.refreshing = true;
  try {
    state.status = await api('status');
    connection(true);
    // Archive enumeration is independent of opening/reconnecting the active conversation.
    if ((forceArchive || Date.now() - state.archiveUpdatedAt > 60_000) && !state.archivePending) {
      state.archivePending = true;
      void api('sessions').then(value => { state.sessions=value; state.archiveUpdatedAt=Date.now(); renderSessions(); })
        .catch(error => banner(error.message)).finally(() => { state.archivePending=false; });
    }
    state.tasks = await api('tasks');
    banner('');
    renderSessions();
    if (state.initialized && state.snapshot && !state.streamId && state.view === 'chat') {
      const running = state.tasks.find(t => t.sessionId === state.sessionId && active(t.status));
      if (running) startStream(running.taskId);
    }
    $('#task-count').textContent = String(
      state.tasks.filter((t) => active(t.status)).length,
    );
    if (state.view === 'tasks') renderTasks();

  } catch (error) {
    if (state.online && /IPC 超时|请求响应较慢/.test(error.message)) {
      $('#connection').className = 'connection';
      $('#connection').innerHTML = '<i></i>等待后台响应';
      banner('后台响应较慢，正在自动重试。');
    } else {
      connection(false);
      $('#connection').innerHTML = `<i></i>${error.status === 0 ? 'Web 服务未连接' : '后台暂不可用'}`;
      banner(error.message);
    }

  } finally {
    state.refreshing = false;
    if (
      state.initialized &&
      state.online &&
      !state.snapshot &&
      !state.loading
    ) {
      void selectSession(
        state.sessionId,
        state.draft,
        true,
      );
    }
  }
}
function executionDetails(run) {
  const details = document.createElement('details');
  details.className = 'execution';
  if (run.id) details.dataset.execution = run.id;
  if (run.historical) details.dataset.historical = 'true';
  details.open = state.defaults.expandExecution;
  const summary = document.createElement('summary');
  summary.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4"/></svg><span class="execution-label"></span><span class="execution-activity"></span>';
  const body = document.createElement('div'); body.className = 'execution-body'; body.tabIndex = 0;
  details.append(summary, body);
  let rendered;
  details.addEventListener('toggle', () => { if(details.open) details.update(); });
  details.update = () => {
    const steps = run.steps.filter(step => run.historical || state.defaults.outputLevel === 'trace' || (state.defaults.outputLevel === 'thinking' ? step.kind === 'reasoning' : step.kind !== 'reasoning'));
    details.hidden = state.defaults.outputLevel === 'answer' || (!run.running && !steps.length && !['partial','blocked','failed','uncertain','interrupted'].includes(run.status));
    details.classList.toggle('is-running', !!run.running);
    summary.querySelector('.execution-label').textContent = `${run.status ? (labels[run.status] || run.status) + ' · ' : ''}执行过程${steps.length ? ` · ${steps.length} 项` : ''}`;
    // The activity preview belongs only to the closed summary. Never project it
    // into the expanded evidence or replace the full tool/thinking content.
    summary.querySelector('.execution-activity').textContent = run.running ? runningActivity(run.steps, run.activity) : '';
    if (!details.open) return;
    const version = JSON.stringify(steps);
    if (version === rendered) return;
    rendered = version;
    const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 50;
    body.innerHTML = steps.length ? steps.map((step) => {
      const title = step.kind === 'reasoning' ? '思考' : step.kind === 'plan' ? '执行计划' : step.title;
      const content = step.kind === 'reasoning' ? step.text : step.kind === 'plan' ? step.steps.map((s) => `${s.description} · ${labels[s.status] || s.status}`).join('\n') : step.fullDetail || step.detail || step.next || '';
      const symbol = step.kind === 'reasoning' || step.tone === 'thinking' ? '<span class="thinking-star">✦</span>' : icon(step.tone === 'tool' ? 'hammer' : step.tone === 'success' ? 'check' : step.kind === 'plan' ? 'stack' : step.tone === 'failure' ? 'close' : 'spark');
      return `<section class="execution-step"><strong><span class="event-symbol" aria-hidden="true">${symbol}</span>${esc(title)}${step.timestamp?`<time class="event-time">${esc(new Date(step.timestamp).toLocaleTimeString())}</time>`:''}</strong><pre>${esc(content)}</pre></section>`;
    }).join('') : `<p class="execution-empty">${run.historical ? '没有保存的执行过程' : '正在等待执行进展…'}</p>`;
    if (run.truncated) { const note=document.createElement('p'); note.className='timeline-note'; note.textContent='部分执行过程未完整加载'; body.append(note); }
    if (nearBottom) body.scrollTop = body.scrollHeight;
  };
  details.update(); return details;
}
const liveRuns = new Map();
function startStream(id) {
  state.disposeRun?.();
  state.streamId = id;
  const session = state.sessionId, revision = state.revision;
  sessionStorage.setItem(`mimi-run:${session}`, id);
  const startKey = `mimi-start:${id}`, cacheKey = `mimi-progress:${session}`, timesKey = `mimi-times:${id}`;
  let cached = liveRuns.get(id), times = {};
  try { cached ||= JSON.parse(sessionStorage.getItem(cacheKey) || 'null'); times = JSON.parse(sessionStorage.getItem(timesKey) || '{}'); } catch { /* Replay from daemon on cache failure. */ }
  // Older tabs cached one flat process list. Replay its ordered events once so
  // an already-running conversation adopts reply groups immediately after upgrade.
  if (cached?.id === id && cached.steps?.some(step => !Number.isInteger(step.afterAnswer))) {
    cached = {...cached,sequence:0,answers:[],steps:[],boundary:true};
  }
  const run = cached?.id === id ? cached : { id, sequence: 0, answers: [], steps: [], boundary: true,
    startedAt: Number(sessionStorage.getItem(startKey)) || Date.now(), answerTimes: times.answerTimes || [],
    sentAt: times.sentAt || [...document.querySelectorAll('#messages .message.user')].at(-1)?.dataset.sentAt,
    userText: [...document.querySelectorAll('#messages .message.user')].at(-1)?.dataset.messageText || '' };
  liveRuns.set(id,run);
  const ownerMessage = [...document.querySelectorAll('#messages .message.user')].at(-1);
  if (ownerMessage && run.sentAt) setMessageFooter(ownerMessage,run.userText,{role:'user',sentAt:run.sentAt});
  sessionStorage.setItem(startKey, String(run.startedAt));
  $('#welcome').hidden = true;
  $('#live-message')?.remove();
  const live = document.createElement('div'); live.id = 'live-message'; live.className = 'message-run';
  const content = document.createElement('div'); content.className = 'live-content'; live.append(content);
  const answerNodes = [], processNodes = new Map();
  $('#messages').append(live);
  let source, settled = false, detached = false, recovering = false, finishing = false, paintTimer, frame;
  const reveal = createTextReveal(run.answers);
  let shown = [...run.answers], replayPaint = run.answers.length > 0;
  const current = () => !detached && revision === state.revision && state.streamId === id && !settled;
  function save() {
    try { const encoded = JSON.stringify(run); if (encoded.length < 1_500_000) sessionStorage.setItem(cacheKey,encoded); } catch { /* Daemon replay remains authoritative. */ }
  }
  function syncExecution() {
    const groups = executionGroups(run);
    if (!groups.length && !run.endedAt) groups.push({afterAnswer:-1,steps:[]});
    for (const [key, entry] of processNodes) if (!groups.some(group=>group.afterAnswer===key)) {
      entry.node.remove(); if(entry.article.classList.contains('execution-message'))entry.article.remove(); processNodes.delete(key);
    }
    for (const group of groups) {
      let entry = processNodes.get(group.afterAnswer);
      if (!entry) {
        const projection = {...run, steps:group.steps};
        const node = executionDetails(projection);
        entry = {projection, node, article:executionMessage(node)};
        processNodes.set(group.afterAnswer,entry);
      }
      Object.assign(entry.projection, {steps:group.steps, status:group === groups.at(-1) ? run.status : undefined, running:group === groups.at(-1) && !run.endedAt && (!run.status || active(run.status))});
      entry.node.update();
    }
  }
  function renderAnswers(texts = shown) {
    while (answerNodes.length > texts.length) answerNodes.pop().remove();
    texts.forEach((text,index) => {
      let part = answerNodes[index];
      if (!part) {
        part = processNodes.get(index - 1)?.article || message('assistant', '', true); part.removeAttribute('id'); part.classList.remove('execution-message'); part.classList.add('answer-part'); answerNodes.push(part);
      }
      const final = !!run.endedAt && index === texts.length-1;
      const key = `${final}:${text}`;
      if (part._rendered === key) return;
      part._rendered = key;
      renderStreamText(part.querySelector('.markdown'), markdown(presentAnswer(text).text), performance.now(), replayPaint || document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches);
      part.querySelector('.message-footer')?.remove();
      part.querySelector('.message-content').append(messageFooter(text, {sentAt: final ? run.endedAt : run.answerTimes[index], copy: !!text, ...(final ? {duration:run.endedAt-run.startedAt} : {})}));
    });
    const nodes = [];
    answerNodes.forEach((node,index) => {
      const process = processNodes.get(index - 1)?.node;
      if (process && process.parentElement !== node.querySelector('.message-content')) node.querySelector('.message-bubble').before(process);
      nodes.push(node);
    });
    for (const [after, entry] of processNodes) if (after + 1 >= answerNodes.length) {
      entry.node.classList.add('pending-execution'); nodes.push(entry.article);
    } else entry.node.classList.remove('pending-execution');
    // Move only newly inserted nodes; preserve expanded panels, scroll and text animation.
    nodes.forEach((node,index) => { if(content.children[index]!==node) content.insertBefore(node,content.children[index]||null); });
    replayPaint = false;
  }
  function animate() {
    frame = null;
    if (!current()) return;
    const nearBottom = $('#chat-scroll').scrollHeight - $('#chat-scroll').scrollTop - $('#chat-scroll').clientHeight < 160;
    shown = reveal.update(run.answers, performance.now(), document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches);
    renderAnswers();
    if (nearBottom) scrollEnd();
    if (reveal.pending) frame = requestAnimationFrame(animate);
  }
  function paint() {
    clearTimeout(paintTimer); paintTimer = null;
    if (!current()) return;
    const nearBottom = $('#chat-scroll').scrollHeight - $('#chat-scroll').scrollTop - $('#chat-scroll').clientHeight < 160;
    syncExecution(); save();
    if (!frame) frame = requestAnimationFrame(animate);
    if (nearBottom) scrollEnd();
  }
  function ingest(data, replay = false) {
    if (!current() || !projectEvent(run,data)) return;
    if (data.kind === 'answer' && !run.answerTimes[run.answers.length-1]) run.answerTimes[run.answers.length-1] = Date.now();
    if (data.kind === 'status') runActivity(data.next || data.title);
    if (replay) { shown = reveal.update(run.answers, performance.now(), true); replayPaint = true; }
    // A replay can contain thousands of deltas. Render once per batch, not once per token.
    if (!paintTimer) paintTimer = setTimeout(paint,80);
  }
  function tick() { $('#run-elapsed').textContent = elapsedLabel(Date.now()-run.startedAt); }
  const timer = setInterval(() => { if (current()) tick(); },1000);
  let lastPush = Date.now();
  const poll = setInterval(() => {
    if (!source || source.readyState !== EventSource.OPEN || Date.now() - lastPush > 20_000) void recover();
  },2500);
  function dispose() { save(); detached = true; clearInterval(timer); clearInterval(poll); clearTimeout(paintTimer); cancelAnimationFrame(frame); source?.close(); }
  state.disposeRun = dispose;
  async function finish(task, missing = false) {
    if (!current() || finishing) return;
    finishing = true;
    const followEnd = $('#chat-scroll').scrollHeight - $('#chat-scroll').scrollTop - $('#chat-scroll').clientHeight < 160;
    paint(); settled = true; clearInterval(timer); clearInterval(poll); clearTimeout(paintTimer); cancelAnimationFrame(frame); source?.close();
    state.source = null; state.streamId = null; state.recoverRun = null; state.finishRun = null; state.disposeRun = null;
    if (state.stopping === id) state.stopping = null;
    sessionStorage.removeItem(`mimi-run:${session}`); sessionStorage.removeItem(startKey); sessionStorage.removeItem(timesKey); sessionStorage.removeItem(cacheKey); liveRuns.delete(id);
    run.status = task?.status || 'completed'; run.endedAt = Date.now();
    const heading=$('#messages .execution-history-heading');
    if(heading?.dataset.execution===id && heading.dataset.running==='true'){
      const started=Number(heading.dataset.startedAt);
      heading.textContent=`${new Date(started).toLocaleString()} → ${new Date(run.endedAt).toLocaleString()} · ${elapsedLabel(run.endedAt-started)}`;
      heading.dataset.running='false';
    }
    const cancelled = task?.status === 'cancelled';
    if (task?.error && !cancelled) run.steps.push({kind:'status',tone:'failure',title:'执行未完成',fullDetail:task.error,afterAnswer:run.answers.length-1});
    const result = task?.result, rawFinal = cancelled ? undefined : typeof result === 'string' ? result : result?.answer;
    const presentation = presentAnswer(rawFinal);
    const finalText = rawFinal == null ? undefined : presentation.text;
    if (presentation.outcome) run.status = presentation.outcome;
    run.answers = finishAnswers(run.answers, finalText, run.boundary);
    if (!run.answers.length && !cancelled) run.answers.push(task?.error || (missing ? '运行记录已不可用，请刷新读取保存的对话。' : `任务${labels[task.status] || task.status}`));
    shown = reveal.update(run.answers, performance.now(), true);
    syncExecution(); renderAnswers();
    for(const part of answerNodes){const text=part.querySelector('.markdown').textContent;const refs=outputMedia(run.answers[answerNodes.indexOf(part)]||text,session);if(refs.length){const body=part.querySelector('.message-bubble');for(const ref of refs){const block=createMessageBody(messageBlocks('',[],[ref]),{markdown,imagesMarkup,mediaMarkup:item=>mediaMarkup(item,esc)});body.append(...block.children);}}}
    live.removeAttribute('id');
    if (followEnd) scrollEnd();
    const records = completedRuns.get(session) || []; records.push(run); completedRuns.set(session,records.slice(-20)); saveExecutions(); updateComposer();
    const changed = Array.isArray(result?.effects) ? result.effects.findLast(e => e.type === 'session_changed') : null;
    if (changed?.sessionId) { await selectSession(changed.sessionId); return; }
    void api(`session?id=${encodeURIComponent(session)}`).then(snapshot => {
      if (revision !== state.revision || state.streamId || state.sending || state.changing) return;
      snapshot.mode = modeId(snapshot.mode); state.snapshot = snapshot; state.draft = false; sessionStorage.setItem('mimi-draft','0');
      // A refresh can precede SDK persistence of the new user item. Reconcile
      // the terminal snapshot so the answer cannot remain attached to an old turn.
      const latest = snapshot.items?.findLast(item => item.role === 'user');
      const visible = [...$('#messages').querySelectorAll('.message.user')].at(-1)?.dataset.messageText;
      if (latest && textOf(latest) !== visible) renderMessages(snapshot.items);
      updateContext(); renderPlan(snapshot.plan); updateComposer();
    }).catch(() => {});
    void refresh(true); void drainQueues();
  }
  async function recover() {
    if (!current() || recovering) return;
    recovering = true;
    try {
      let page;
      do {
        page = await api(`progress?id=${encodeURIComponent(id)}&after=${run.sequence}`);
        if (!current()) return;
        for (const event of page.events || []) ingest(event, true);
        paint();
      } while (page.hasMore && current());
      if (!active(page.task.status)) await finish(page.task);
      else if (!source || source.readyState === EventSource.CLOSED) connect();
    } catch (error) {
      if (!current()) return;
      if (error.status === 404) await finish(null,true);
      else runActivity('正在同步最新进展');
    } finally { recovering = false; }
  }
  function connect() {
    if (!current()) return;
    source?.close();
    source = new EventSource(`/api/events?id=${encodeURIComponent(id)}&after=${run.sequence}`); state.source = source;
    source.addEventListener('heartbeat',() => { lastPush = Date.now(); });
    source.addEventListener('ready',() => { lastPush = Date.now(); if(current()) {runActivity('Mimi 正在处理'); connection(true);} });
    source.addEventListener('update',event => { lastPush = Date.now(); if(current()) ingest(JSON.parse(event.data)); });
    source.addEventListener('done',event => { if(current()) void finish(JSON.parse(event.data)); });
    source.addEventListener('unavailable',() => { if(current()) {source.close(); void recover();} });
    source.onerror = () => { if(current()) void recover(); };
  }
  state.finishRun = finish; state.recoverRun = recover;
  tick(); paint(); connect(); void recover(); updateComposer();
}
async function loadModels(
  session = state.sessionId,
  revision = state.revision,
) {
  $('#retry-models').hidden = true;
  const modelVersion = selections.version(selectionKey('model', session));
  try {
    const value = await api(`models?session=${encodeURIComponent(session)}`);
    if (revision !== state.revision) return;
    state.defaultModel=value.current?.next?.target;
    state.models = (value.choices || []).filter(
      (m) => m.kind === 'agent' && m.capabilities?.toolCalling,
    );
    const selected = value.current?.sessionTarget || null;
    selections.seed(selectionKey('model', session), selected, modelVersion);
    const key = (target) =>
      JSON.stringify(
        target && { providerId: target.providerId, modelId: target.modelId },
      );
    $('#model').innerHTML =
      '<option value="auto">自动选择模型</option>' +
      state.models
        .map(
          (m, i) =>
            `<option value="${i}" ${m.configured === false ? 'disabled' : ''}>${esc(m.target.modelId)}${m.capabilities?.imageInput?' · 可看图':''} · ${esc(m.provider?.label || m.target.providerId)}${m.configured === false ? '（未配置）' : ''}</option>`,
        )
        .join('');
    const index = state.models.findIndex(
      (m) => key(m.target) === key(selected),
    );
    $('#model').value = index < 0 ? 'auto' : String(index);
    $('#model').title =
      `当前模型：${value.current?.next?.target?.modelId || state.snapshot?.model || '自动选择'}。切换后用于下一次回复。`;
    syncSelections(); renderImageDrafts();
  } catch (error) {
    if (revision === state.revision) {
      $('#retry-models').hidden = false;
      $('#model').innerHTML = '<option>模型读取失败</option>';
      toast(`模型列表读取失败：${error.message}`);
    }
  }
}
async function send(event) {
  event.preventDefault();
  const input = $('#message-input').value.trim();
  const images = imageDrafts.list(state.sessionId).map(i=>({...i}));
  const media = mediaDrafts.list(state.sessionId).map(i=>({...i}));
  if (
    (!input && !images.length && !media.length) || images.some(i=>i.pending) || media.some(i=>i.pending||!i.ready) || recorder.active ||
    state.sending ||
    !state.online ||
    state.changing ||
    state.loading
  )
    return;
  const session = state.sessionId;
  if (state.streamId || queue.list(session).length) {
    queue.add(session, input, $('#security').value, images, media); imageDrafts.clear(session); mediaDrafts.clear(session); $('#message-input').value = ''; resizeInput(); updateComposer(); void drainQueues(); return;
  }
  const revision = state.revision;
  state.sending = true;
  updateComposer();
  let pending;
  try {
    pending = JSON.parse(
      sessionStorage.getItem(`mimi-pending:${session}`) || 'null',
    );
  } catch {
    pending = null;
  }
  if (!pending || pending.input !== input || JSON.stringify(pending.images||[]) !== JSON.stringify(images.map(i=>i.id)) || JSON.stringify(pending.media||[]) !== JSON.stringify(media.map(i=>i.id)))
    pending = { input, media:media.map(i=>i.id), images:images.map(i=>i.id), requestId: crypto.randomUUID(), sentAt: new Date().toISOString(), security: $('#security').value };
  sessionStorage.setItem(`mimi-pending:${session}`, JSON.stringify(pending));
  const pendingArticle = message('user', input, false, pending.sentAt, images, media);
  pendingArticle.dataset.requestId = pending.requestId;
  pendingArticle.setAttribute('aria-busy','true');
  const preparing = executionMessage(executionDetails({steps:[],running:true,activity:'正在发送'}));
  $('#welcome').hidden = true; $('#messages').append(pendingArticle, preparing); scrollEnd();
  try {
    const accepted = await api('messages', {
      sessionId: session,
      input,
      requestId: pending.requestId,
      images:pending.images, media:pending.media,
      security: pending.security || $('#security').value,
      workspaceRoot:sessionStorage.getItem(`mimi-workspace:${session}`)||undefined,
    });
    sessionStorage.removeItem(`mimi-pending:${session}`);
    sessionStorage.setItem(`mimi-run:${session}`, accepted.eventId);
    if (!sessionStorage.getItem(`mimi-start:${accepted.eventId}`)) sessionStorage.setItem(`mimi-start:${accepted.eventId}`, String(Date.now()));
    sessionStorage.setItem(`mimi-times:${accepted.eventId}`, JSON.stringify({ sentAt: pending.sentAt }));
    drafts.delete(session);
    imageDrafts.clear(session,pending.images); mediaDrafts.clear(session,pending.media);
    if (revision !== state.revision) return;
    state.draft = false; sessionStorage.setItem('mimi-draft','0');
    $('#welcome').hidden = true;
    pendingArticle.removeAttribute('aria-busy');
    $('#message-input').value = '';
    resizeInput();
    preparing.remove();
    startStream(accepted.eventId);
    scrollEnd();
    void refresh(true);
  } catch (error) {
    preparing.remove();
    pendingArticle.remove();
    if (revision === state.revision)
      toast(`${error.message}。原文已保留，重试相同消息不会重复提交。`);
  } finally {
    if (revision === state.revision) {
      state.sending = false;
      updateComposer();
    }
  }
}
function renderTasks() {
  const tasks = state.tasks;
  $('#task-metrics').innerHTML = [
    ['进行中', tasks.filter((t) => active(t.status)).length],
    ['需要关注', tasks.filter((t) => attention(t.status)).length],
    ['已完成', tasks.filter((t) => t.status === 'completed').length],
  ]
    .map(
      ([label, n]) =>
        `<div class="metric"><div class="metric-label">${label}</div><div class="metric-value">${n.toString().padStart(2, '0')}</div></div>`,
    )
    .join('');
  const list = tasks.filter(
    (t) =>
      state.filter === 'all' ||
      (state.filter === 'active' && active(t.status)) ||
      (state.filter === 'attention' && attention(t.status)) ||
      (state.filter === 'completed' && t.status === 'completed'),
  );
  $('#task-list').innerHTML = list.length
    ? list
        .map(
          (t) =>
            `<button class="task-row" data-task="${esc(t.taskId)}"><span class="task-icon">${icon(t.status === 'completed' ? 'check' : 'clock')}</span><span class="task-info"><strong>${esc(t.objective || '未命名任务')}</strong><small>${esc(t.checkpoint?.nextAction || t.codex?.latestActivity || t.error || date(t.updatedAt || t.createdAt))}</small></span>${badge(t.status)}${icon('arrow')}</button>`,
        )
        .join('')
    : empty(
        state.online ? '这里还很安静' : '暂时无法读取任务',
        state.online
          ? '交代一件事后，可以在这里查看进展、结果，或暂停处理。'
          : '请连接后台服务后刷新。',
        'stack',
      );
}
function openDialog(title, html, eyebrow = '详情') {
  state.detailRevision++;
  $('#detail-title').textContent = title;
  $('#detail-content').innerHTML = html;
  $('#detail-eyebrow').textContent = eyebrow;
  if (!$('#detail-dialog').open) $('#detail-dialog').showModal();
}
async function openExecutionSession(session, execution, runId, alreadySelected=false) {
  if(runId)sessionStorage.setItem(`mimi-execution:${session}`,JSON.stringify({execution,runId}));
  if(!alreadySelected) {await selectSession(session);if(runId)return;}
  if (!execution || state.sessionId !== session) return;
  const canonical = [...$('#messages').querySelectorAll('.execution[data-historical]')].find(panel => !runId || panel.dataset.execution === runId);
  if (canonical) { canonical.open = true; canonical.update?.(); if (!alreadySelected) canonical.scrollIntoView({block:'start'}); return; }
  const revision=state.revision;
  const run={sequence:0,answers:[],steps:[],boundary:true,historical:true};
  try {
    if(runId || session.startsWith('mimi-task-')) {
      const saved=await api('manage',{action:'execution.history',sessionId:session,value:{runId}});
      if(revision!==state.revision || !saved)return;
      run.steps=saved.steps;run.status=saved.status;run.truncated=saved.truncated;
      const heading=document.createElement('div');heading.className='execution-history-heading';heading.textContent=`${new Date(saved.startedAt).toLocaleString()}${saved.completedAt?' → '+new Date(saved.completedAt).toLocaleString()+' · '+elapsedLabel(Date.parse(saved.completedAt)-Date.parse(saved.startedAt)):' · 运行中'}${saved.truncated?' · 部分过程未完整加载':''}`;
      heading.dataset.execution=String(saved.taskId);heading.dataset.startedAt=String(Date.parse(saved.startedAt));heading.dataset.running=String(!saved.completedAt);
      $('#messages .execution-history-heading')?.remove();
      $('#messages').prepend(heading);
      const user=[...$('#messages').querySelectorAll('article.user')].at(-1);
      if(user)setMessageFooter(user,user.querySelector('.markdown')?.textContent || '',{role:'user',sentAt:saved.startedAt});
      if(!saved.completedAt && state.streamId===execution)return;
      if(run.steps.length){const panel=executionDetails(run);panel.open=true;panel.hidden=false;panel.classList.add('historical-execution');heading.after(executionMessage(panel));return;}
    }
    let page;
    do {
      page=await api(`progress?id=${encodeURIComponent(execution)}&after=${run.sequence}`);
      if(revision!==state.revision)return;
      for(const event of page.events||[])projectEvent(run,event);
    }while(page.hasMore);
    run.status=page.task.status;
    if (!active(run.status) && !run.steps.length) {
      const history=await api(`history?id=${encodeURIComponent(session)}`);
      if(revision!==state.revision)return;
      run.steps=historyExecution(history);
      if(history.length)renderMessages(history);
      if(!run.steps.length)run.steps.push({kind:'status',tone:'agent',title:'历史记录',fullDetail:'这次运行未保留可恢复的工具或思考步骤，已展示保存的对话正文。',next:''});
    }
    const panel=executionDetails(run);panel.open=true;panel.hidden=false;panel.classList.add('historical-execution');
    $('#messages').prepend(executionMessage(panel));panel.scrollIntoView({block:'start'});
  }catch(error){if(revision===state.revision)toast(error.message);}
}
function resultText(result) {
  if (typeof result === 'string') return result;
  if (!result) return '';
  return result.answer || result.summary || JSON.stringify(result, null, 2);
}
async function showTask(id) {
  try {
    const task = await api(`task?id=${encodeURIComponent(id)}`);
    const progress =
      task.checkpoint?.nextAction ||
      task.codex?.latestActivity ||
      task.checkpoint?.lastEvent;
    const steps = task.plan || [];
    const result = resultText(task.result);
    let html = `<div class="detail-meta">${badge(task.status)}<span>更新于 ${esc(date(task.updatedAt))}</span></div>`;
    if (progress)
      html += `<div class="detail-section"><h4>最近进展</h4><div class="markdown">${markdown(progress)}</div></div>`;
    if (steps.length)
      html += `<div class="detail-section"><h4>执行计划</h4>${steps.map((s) => `<p>${esc(s.description)} ${badge(s.status)}</p>`).join('')}</div>`;
    if (task.error)
      html += `<div class="detail-section"><h4>需要关注</h4><p class="error-text">${esc(task.error)}</p></div>`;
    if (result)
      html += `<div class="detail-section"><h4>结果</h4><div class="markdown">${markdown(presentAnswer(result).text)}</div></div>`;
    if (!progress && !result && !task.error)
      html +=
        '<p class="settings-note">尚未提供实质进展记录。运行状态和心跳不代表任务已完成。</p>';
    if (['paused', 'blocked'].includes(task.status))
      html +=
        '<label class="settings-note" for="resume-context">补充信息（可选）</label><textarea class="resume-context" id="resume-context" placeholder="继续前，告诉 Mimi 需要调整什么…"></textarea>';
    html += '<div class="detail-actions">';
    if (active(task.status))
      html += `<button class="secondary-button" data-action="pause" data-id="${esc(id)}">暂停</button>`;
    if (['paused', 'blocked'].includes(task.status))
      html += `<button class="secondary-button" data-action="resume" data-id="${esc(id)}">继续处理</button>`;
    if (active(task.status) || ['paused', 'blocked'].includes(task.status))
      html += `<button class="secondary-button danger-button" data-action="cancel" data-id="${esc(id)}">取消任务</button>`;
    if (task.originSessionId || task.sessionId)
      html += `<button class="secondary-button" data-open-session="${esc(task.originSessionId || task.sessionId)}">打开关联对话</button>`;
    html += '</div>';
    openDialog(task.objective || '任务详情', html, '任务详情');
  } catch (error) {
    toast(error.message);
  }
}
async function taskAction(button) {
  const { action, id } = button.dataset;
  if (action === 'cancel' && button.dataset.confirmed !== 'true') {
    button.dataset.confirmed = 'true';
    button.textContent = '确认取消任务';
    const note = document.createElement('p'); note.className = 'settings-note';
    note.textContent = '取消后将停止后续执行，已完成的操作会保留。再次点击确认。';
    button.parentElement.before(note); return;
  }
  button.disabled = true;
  try {
    const result = await api('tasks/action', {
      id,
      action,
      context: $('#resume-context')?.value || undefined,
    });
    const accepted = {
      pause: ['paused'],
      resume: ['resumed', 'queued'],
      cancel: ['cancelled'],
    };
    if (result?.state && !(accepted[action] || []).includes(result.state))
      toast(
        `后台返回：${result.message || labels[result.state] || result.state}`,
      );
    else
      toast(
        { pause: '任务已暂停', resume: '已请求继续处理', cancel: '任务已取消' }[
          action
        ],
      );
    await refresh();
    await showTask(id);
  } catch (error) {
    toast(error.message);
    button.disabled = false;
  }
}
async function loadMemory() {
  const session = state.sessionId;
  $('#memory-list').innerHTML = empty('正在读取记忆', '');
  try {
    const value = await api(`memory?session=${encodeURIComponent(session)}`);
    if (session !== state.sessionId) return;
    state.memory = Array.isArray(value) ? value : [];
    renderMemory();
  } catch (error) {
    $('#memory-list').innerHTML = empty(
      '暂时无法读取记忆',
      error.message,
      'spark',
    );
  }
}
function renderMemory() {
  const query = $('#memory-search').value.toLowerCase();
  const list = state.memory.filter((m) =>
    (m.title + ' ' + m.summary).toLowerCase().includes(query) && (state.memoryFilter === 'all' || m.ref?.scope === state.memoryFilter || m.layer === state.memoryFilter || (state.memoryFilter === 'L0' && ['source', 'episode'].includes(m.documentType))),
  );
  $('#memory-list').innerHTML = list.length
    ? list
        .map(
          (m) =>
            `<button class="memory-card" data-memory="${esc(m.ref?.id)}" data-scope="${esc(m.ref?.scope)}"><span class="status-badge neutral">${m.ref?.scope === 'private' ? '个人记忆' : '工作区记忆'}</span><span class="memory-layer">${esc(m.layer || (['source','episode'].includes(m.documentType) ? 'L0' : '未分层'))}</span><h3>${esc(m.title)}</h3><p>${esc(m.summary)}</p></button>`,
        )
        .join('')
    : empty(
        '还没有相关记忆',
        query ? '换个关键词试试。' : '在对话中告诉 Mimi 需要记住的背景或偏好。',
        'spark',
      );
}
function memoryRelations(value, scope) {
  const meta = value.metadata || {};
  const refs = [...(meta.derivedFrom || []).map(ref => ({ kind: '来源记忆', ref })), ...(meta.facets?.relations || []).map(relation => ({kind: relation.kind, ref: relation.target})), ...(meta.supersedes || []).map(id => ({ kind: '替代记录', ref: { id, scope } }))];
  const layer = meta.layer || '未分层';
  return `<div class="detail-section"><h3>分层与关联</h3><p class="settings-note">${esc([layer,meta.kind,meta.confidence].filter(Boolean).join(' · '))}</p>${refs.map(({kind,ref})=>`<button class="memory-relation" data-memory="${esc(ref.id)}" data-scope="${esc(ref.scope)}">${esc(kind)} → ${esc(state.memory.find(m=>m.ref?.id===ref.id&&m.ref?.scope===ref.scope)?.title || ref.id)}</button>`).join('') || '<p class="settings-note">这条记忆尚无已记录的关联。</p>'}${(meta.sourceRefs || []).length ? `<h4>证据来源</h4>${meta.sourceRefs.map(ref=>`<p class="settings-note">${esc(ref.type)} · ${esc(ref.id)}</p>`).join('')}` : ''}</div>`;
}
$('#memory-filters').onclick = event => {
  const button = event.target.closest('[data-memory-filter]'); if (!button) return;
  state.memoryFilter = button.dataset.memoryFilter;
  $('#memory-filters').querySelectorAll('button').forEach(el=>el.classList.toggle('active',el===button));
  renderMemory();
};
async function showMemory(button) {
  const session = state.sessionId;
  openDialog(
    button.querySelector('h3')?.textContent || '记忆详情',
    '<p class="settings-note">正在读取记忆…</p>',
    '关于你的记忆',
  );
  const request = state.detailRevision;
  try {
    const value = await api(
      `memory/read?session=${encodeURIComponent(state.sessionId)}&scope=${encodeURIComponent(button.dataset.scope)}&id=${encodeURIComponent(button.dataset.memory)}`,
    );
    if (
      request !== state.detailRevision ||
      session !== state.sessionId ||
      !$('#detail-dialog').open
    )
      return;
    if (!value) {
      $('#detail-content').textContent = '这条记忆已不存在';
      return;
    }
    openDialog(
      value.metadata?.title || '记忆详情',
      `<div class="detail-meta">${badge(value.metadata?.status || 'active')}<span>${esc(date(value.metadata?.updatedAt))}</span></div><div class="markdown">${markdown(value.body || '')}</div>${memoryRelations(value, button.dataset.scope)}<div class="detail-section settings-note">需要纠正或忘记这条记忆时，请在对话中明确告诉 Mimi。</div>`,
      '关于你的记忆',
    );
  } catch (error) {
    if (request === state.detailRevision && $('#detail-dialog').open)
      $('#detail-content').textContent = `读取失败：${error.message}`;
  }
}
async function archiveDetachedRun(session,id,task) {
  if (state.streamId === id) return;
  let run = liveRuns.get(id);
  try { run ||= JSON.parse(sessionStorage.getItem(`mimi-progress:${session}`) || 'null'); } catch { return; }
  if (run?.id !== id) return;
  let page;
  do {page=await api(`progress?id=${encodeURIComponent(id)}&after=${run.sequence}`);for(const event of page.events||[])projectEvent(run,event);} while(page.hasMore);
  run.status = task.status; run.endedAt = Date.now();
  if(task.status !== 'cancelled') run.answers = finishAnswers(run.answers,typeof task.result==='string'?task.result:task.result?.answer,run.boundary);
  const records = completedRuns.get(session) || [];
  if (!records.some(record=>record.id===id)) {records.push(run);completedRuns.set(session,records.slice(-20));saveExecutions();}
  liveRuns.delete(id);sessionStorage.removeItem(`mimi-progress:${session}`);
}
const queue = createMessageQueue({
  storage: sessionStorage, uuid: () => crypto.randomUUID(), changed: () => renderQueue(),
  isRunning: async (session, { immediate } = {}) => {
    if (session === state.sessionId && (state.sending || state.loading || state.changing)) throw new Error('等待会话设置完成');
    const id = sessionStorage.getItem(`mimi-run:${session}`) || state.tasks.find(t => t.sessionId === session && active(t.status))?.taskId;
    if (!id) return null;
    if (immediate) return id;
    const task = await api(`run?id=${encodeURIComponent(id)}`);
    if (!active(task.status)) {
      if (sessionStorage.getItem(`mimi-run:${session}`) === id) sessionStorage.removeItem(`mimi-run:${session}`);
      void archiveDetachedRun(session,id,task).catch(() => {});
    }
    return active(task.status) ? id : null;
  },
  interrupt: async (session,id) => {
    const result = await api('tasks/action',{id,action:'cancel'});
    if (!['cancelled','already_terminal'].includes(result.state)) throw new Error('停止未确认，消息继续排队');
    // Cancellation acknowledgement is sufficient. Progress replay is observation, not a send prerequisite.
    if (session === state.sessionId && state.streamId === id) void state.finishRun?.({ id, status: 'cancelled' }).catch(() => {});
  },
  submit: item => api('messages',{sessionId:item.session,input:item.input,images:(item.images||[]).map(i=>i.id),media:(item.media||[]).map(i=>i.id),requestId:item.id,security:item.security,workspaceRoot:sessionStorage.getItem(`mimi-workspace:${item.session}`)||undefined}),
  accepted: async (item,result) => {
    const session = item.session;
    sessionStorage.setItem(`mimi-run:${session}`,result.eventId);
    if (!sessionStorage.getItem(`mimi-start:${result.eventId}`)) sessionStorage.setItem(`mimi-start:${result.eventId}`,String(Date.now()));
    if (!sessionStorage.getItem(`mimi-times:${result.eventId}`)) sessionStorage.setItem(`mimi-times:${result.eventId}`,JSON.stringify({sentAt:new Date().toISOString()}));
    if (session !== state.sessionId) return;
    if (state.streamId === result.eventId) return;
    state.draft = false; sessionStorage.setItem('mimi-draft','0'); $('#welcome').hidden = true;
    if (![...$('#messages').querySelectorAll('[data-request-id]')].some(el => el.dataset.requestId === item.id)) {
      const article = message('user',item.input,false,new Date().toISOString(),item.images,item.media); article.dataset.requestId = item.id; $('#messages').append(article);
    }
    startStream(result.eventId); scrollEnd(); void refresh(true);
  },
});
let editingQueued;
function renderQueue() {
  const items = queue.list(state.sessionId), root = $('#message-queue');
  // Polling and other session changes must not discard an in-progress edit or its caret.
  const candidate = root.querySelector('textarea:focus');
  const focused = candidate?.closest('[data-queue-id]')?.dataset.queueId === editingQueued ? candidate : null;
  const editValue = focused?.value, caret = focused?.selectionStart;
  root.hidden = !items.length;
  root.innerHTML = `<div class="queue-heading">待发送 <span>${items.length}</span></div>${items.map(item => {
    const editing = editingQueued === item.id;
    const waiting = ['interrupting','sending','accepted'].includes(item.state);
    const status = item.state === 'interrupting' ? '正在停止当前执行' : item.state === 'accepted' ? '已发送，正在同步' : '正在发送';
    return `<div class="queued-message${editing?' is-editing':''}" data-queue-id="${esc(item.id)}">
      ${editing ? `<textarea aria-label="编辑待发送消息" maxlength="60000" rows="2">${esc(editValue ?? item.input)}</textarea>` : `<div class="queued-content">${item.images?.length?`<div class="message-images">${imagesMarkup(item.images)}</div>`:''}${item.media?.length?`<div class="queued-media">${item.media.map(i=>mediaMarkup(i,esc)).join('')}</div>`:''}<p title="${esc(item.input)}">${esc(item.input)}</p></div>`}
      <div class="queue-actions">${waiting ? `<span class="queue-pending"><span class="queue-pulse"></span>${status}</span>` : editing ? `<button type="button" class="queue-icon" data-queue-action="discard" aria-label="取消编辑" title="取消编辑">${icon('close')}</button><button type="button" class="queue-icon queue-save" data-queue-action="save" aria-label="保存修改" title="保存修改">${icon('check')}</button>` : `<button type="button" class="queue-send" data-queue-action="now" title="停止当前执行并发送此消息">${item.state==='failed'?'确认发送':'立即发送'}${icon('up')}</button>${item.state==='queued'?`<button type="button" class="queue-icon" data-queue-action="edit" aria-label="编辑待发送消息" title="编辑">${icon('edit')}</button><button type="button" class="queue-icon" data-queue-action="cancel" aria-label="移除待发送消息" title="移除">${icon('close')}</button>`:''}`}</div>
      ${item.error?`<span class="queue-error" role="status">${esc(item.state==='failed'?'发送回执未确认，原文已保留；确认发送不会重复提交。':item.error)}</span>`:''}</div>`;
  }).join('')}`;
  if (focused) { const input=root.querySelector('textarea'); input?.focus(); input?.setSelectionRange(caret,caret); }
}
function saveQueuedEdit(row) {
  const input = row.querySelector('textarea').value.trim();
  editingQueued = null; queue.edit(row.dataset.queueId,input);
}
$('#message-queue').addEventListener('click',event => {
  const button = event.target.closest('[data-queue-action]'); if(!button)return;
  const row = button.closest('[data-queue-id]'), id = row.dataset.queueId;
  if(button.dataset.queueAction==='now') { editingQueued=null; void queue.drain(state.sessionId,id); }
  if(button.dataset.queueAction==='cancel') queue.cancel(id);
  if(button.dataset.queueAction==='edit') { editingQueued=id;renderQueue();const input=$('#message-queue textarea');input?.focus();input?.setSelectionRange(input.value.length,input.value.length); }
  if(button.dataset.queueAction==='discard') {editingQueued=null;renderQueue();}
  if(button.dataset.queueAction==='save') saveQueuedEdit(row);
});
$('#message-queue').addEventListener('keydown',event => {
  if (!event.target.matches('textarea')) return;
  if (event.key === 'Escape') { event.preventDefault();editingQueued=null;renderQueue(); }
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault();saveQueuedEdit(event.target.closest('[data-queue-id]')); }
});
async function drainQueues() {
  if (!state.online) return;
  await Promise.all(queue.sessions().filter(session => !queue.list(session).some(item=>item.id===editingQueued)).map(session=>queue.drain(session)));
}
setInterval(() => void drainQueues(),3000);
$('#composer').addEventListener('submit', send);
$('#message-input').addEventListener('paste',event=>{
  const files=[...(event.clipboardData?.items||[])].filter(item=>item.kind==='file'&&item.type.startsWith('image/')).map(item=>item.getAsFile()).filter(Boolean);
  if(!files.length)return;
  event.preventDefault(); void addImages(files);
});
$('#record-voice').onclick=()=>recorder.active?recorder.stop():recorder.start(state.sessionId);
$('#cancel-recording').onclick=()=>recorder.cancel();
$('#media-drafts').onclick=event=>{const remove=event.target.closest('[data-remove-media]'),retry=event.target.closest('[data-retry-media]');if(remove)mediaDrafts.remove(state.sessionId,remove.dataset.removeMedia);if(retry)void mediaDrafts.retry(state.sessionId,retry.dataset.retryMedia);};
window.addEventListener('pagehide',()=>recorder.cancel());
bindMediaPlayers(document);
$('#attach-image').onclick=()=>$('#image-input').click();
$('#image-input').onchange=event=>{void addImages([...event.target.files]);event.target.value='';};
$('#image-drafts').onclick=event=>{const button=event.target.closest('[data-remove-image]');if(button)imageDrafts.remove(state.sessionId,button.dataset.removeImage);};
document.addEventListener('click',event=>{
  const button=event.target.closest('[data-image-preview]');if(!button)return;
  const dialog=$('#image-preview');dialog.querySelector('img').src=button.querySelector('img').src;dialog.showModal();
});
$('#image-preview button').onclick=()=>$('#image-preview').close();
$('#image-preview').onclick=event=>{if(event.target===$('#image-preview'))event.target.close();};
function resizeInput() {
  const el = $('#message-input');
  el.style.height = 'auto';
  if (!el.getClientRects().length) return;
  el.style.height = `${el.scrollHeight}px`;
  el.style.overflowY = el.scrollHeight > el.clientHeight ? 'auto' : 'hidden';
}
new ResizeObserver(resizeInput).observe($('#composer'));
$('#message-input').addEventListener('input', () => {
  resizeInput();
  updateComposer();
});
$('#message-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && (state.defaults.sendWith!=='mod-enter' || event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    $('#composer').requestSubmit();
  }
});
function renderWorkspace() {
  const workspace=sessionStorage.getItem(`mimi-workspace:${state.sessionId}`)||state.snapshot?.workspaceRoot||'';
  $('#chat-workspace').textContent=workspace;$('#chat-workspace').title=workspace;
  $('#workspace-choose span:last-child').textContent=workspace===state.snapshot?.workspaceRoot?'选择工作区':workspace.split('/').filter(Boolean).at(-1)||'选择工作区';
  $('#workspace-reset').hidden=workspace===state.snapshot?.workspaceRoot;
}
$('#workspace-choose').onclick=async()=>{const id=state.sessionId,button=$('#workspace-choose');button.disabled=true;try{const value=await api('manage',{action:'workspace.choose',sessionId:id,value:{}});if(value.path&&state.sessionId===id){sessionStorage.setItem(`mimi-workspace:${id}`,value.path);renderWorkspace();}}catch(error){toast(error.message);}finally{button.disabled=false;}};
$('#workspace-reset').onclick=()=>{sessionStorage.setItem(`mimi-workspace:${state.sessionId}`,state.snapshot.workspaceRoot);renderWorkspace();};
$('#session-search').addEventListener('keydown',event=>{if(event.key==='Escape'){$('#session-search').value='';renderSessions();$('#search-toggle').click();$('#search-toggle').focus();}});
$('#new-chat').onclick = () => {
  void selectSession(`mimi-chat-${crypto.randomUUID()}`, true);
};
$('#refresh').onclick = async () => {
  await refresh(true);
  if (state.online && state.view === 'chat')
    await selectSession(state.sessionId, state.draft, true);
};
$('#refresh-tasks').onclick = () => {
  void refresh();
};
$('#session-search').oninput = renderSessions;
$('#memory-search').oninput = renderMemory;
$('#search-toggle').onclick = () => {
  $('#session-search-wrap').hidden = !$('#session-search-wrap').hidden;
  $('.session-heading').classList.toggle('searching',!$('#session-search-wrap').hidden);
  $('#search-toggle').setAttribute('aria-expanded',String(!$('#session-search-wrap').hidden));
  if (!$('#session-search-wrap').hidden) $('#session-search').focus();
};
$('#mobile-menu').onclick = () => {
  $('#sidebar').classList.add('open');
  $('#scrim').hidden = false;
  $('#mobile-menu').setAttribute('aria-expanded', 'true');
};
$('#scrim').onclick = closeMenu;
$('#close-dialog').onclick = () => $('#detail-dialog').close();
$('#send').addEventListener('click', async (event) => {
  if (!state.streamId || $('#message-input').value.trim()) return;
  event.preventDefault();
  const id = state.streamId;
  if (state.stopping === id) return;
  state.stopping = id; updateComposer(); runActivity('正在停止');
  try {
    const result = await api('tasks/action', { id, action: 'cancel' });
    if (state.streamId !== id) return;
    if (result.state === 'cancelled') void state.recoverRun?.();
    else if (result.state === 'already_terminal') void state.recoverRun?.();
    else throw new Error('未能停止，请重试');
  } catch (error) {
    if (state.streamId === id) toast(error.message);
    if (state.stopping === id) state.stopping = null;
  } finally {
    updateComposer();
  }
});
$('#context-indicator').onclick = showContext;
function changeSelection(kind) {
  if (kind === 'security') { sessionStorage.setItem(`mimi-security:${state.sessionId}`, $('#security').value); updateComposer(); return; }
  const value = kind === 'mode' ? $('#mode').value : $('#model').value === 'auto' ? null : state.models[Number($('#model').value)]?.target;
  if (value === undefined) return;
  selections.set(selectionKey(kind), value);
  if(kind==='model')renderImageDrafts();
}
$('#security').onchange = () => changeSelection('security');
$('#mode').onchange = () => {
  void changeSelection('mode');
};
$('#retry-models').onclick = () => {
  void loadModels();
};
$('#model').onchange = () => {
  void changeSelection('model');
};
// Delegated controls survive list refreshes; all model/user text is escaped before rendering.
document.addEventListener('click', (event) => {
  const el = event.target.closest('button');
  if (!el) return;
  if (el.dataset.view) setView(el.dataset.view);
  if (el.dataset.session) void selectSession(el.dataset.session);
  if (el.dataset.prompt) {
    $('#message-input').value = el.dataset.prompt;
    $('#message-input').focus();
    updateComposer();
  }
  if (el.dataset.filter) {
    state.filter = el.dataset.filter;
    document
      .querySelectorAll('[data-filter]')
      .forEach((b) => b.classList.toggle('active', b === el));
    renderTasks();
  }
  if (el.dataset.task) void showTask(el.dataset.task);
  if (el.dataset.action) void taskAction(el);
  if (el.dataset.memory) void showMemory(el);
  if (el.dataset.openSession) {
    $('#detail-dialog').close();
    void openExecutionSession(el.dataset.openSession, el.dataset.execution, el.dataset.runId);
  }
});
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
    event.preventDefault();
    $('#new-chat').click();
  }
  if (event.key === 'Escape') closeMenu();
});
pickers = setupPickers((kind) => void changeSelection(kind));
pickers.sync();
async function init() {
  try {
    showSessionLoading();
    // Old bookmarks remain usable; direct localhost access needs no handshake.
    if (new URLSearchParams(location.hash.slice(1)).has('connect')) history.replaceState(null, '', location.pathname);
    const settingsReady = management.loadSettings().catch(() => {});
    // Open the saved session immediately; neither archives nor queued model reads gate it.
    const opening = state.draft ? settingsReady.then(() => selectSession(state.sessionId,true)) : selectSession(state.sessionId,false);
    await refresh();
    await opening;
    if (state.snapshot && !state.streamId) {
      const running = state.tasks.find(t => t.sessionId === state.sessionId && active(t.status));
      if (running) startStream(running.taskId);
    }
  } catch (error) {
    connection(false);
    banner(error.message);
    showSessionLoading(error.message);
  }
  state.initialized = true;
  setInterval(() => {
    if (!document.hidden) {
      void refresh();
      void state.recoverRun?.();
    }
  }, 10000);
}
function resumePage() {
  if (state.initialized && !document.hidden) {
    void state.recoverRun?.();
    void drainQueues();
    void refresh();
  }
}
document.addEventListener('visibilitychange', resumePage);
window.addEventListener('pageshow', resumePage);
window.addEventListener('online', resumePage);
void init();

observeMessageMotion($('#messages'), $('#chat-scroll'));

document.addEventListener('click',async event=>{const button=event.target.closest('[data-copy-code]');if(!button)return;try{await navigator.clipboard.writeText(button.closest('.code-block').querySelector('code').textContent);button.title='已复制';}catch{toast('复制失败，请手动选择代码');}});
