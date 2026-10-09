import { enhanceSelects } from './pickers.js';
const github = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 .5a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2.3c-3.3.7-4-1.4-4-1.4-.5-1.4-1.3-1.8-1.3-1.8-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.3 11.3 0 0 1 6 0C17.3 5.1 18.3 5.4 18.3 5.4c.6 1.7.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .5Z"/></svg>';
export const managedViews = ['skills','mcp','models','connectors','schedules','status','runtime','settings','about'];
export const viewTitles = {skills:'Skills',mcp:'MCP',models:'模型接入',connectors:'连接器',schedules:'定时任务',status:'运行状态',runtime:'运行时指令',settings:'设置',about:'关于 MimiAgent'};
export function createManagement({ api, esc, markdown, getSession, openDialog, onSettings, onSessionSettings }) {
  const root = document.querySelector('#manage-content');
  let area, data, version = 0;
  const promptDrafts = new Map();
  let detailVersion = 0, detailState = null;
  const detail = document.querySelector('#detail-content');
  document.querySelector('#detail-dialog').addEventListener('close',()=>{detailVersion++;detailState=null;});
  const write = (action, value) => api('manage', { action, sessionId: getSession(), value });
  const read = (name) => api(`manage?area=${name}&session=${encodeURIComponent(getSession())}`);
  const button = (label, action, extra = '') => `<button type="button" class="secondary-button" data-admin="${action}" ${extra}>${label}</button>`;
  const field = (label, name, value = '', type = 'text', extra = '') => `<label class="admin-field">${label}<input name="${name}" type="${type}" value="${esc(value)}" ${extra}></label>`;
  const select = (label, name, choices, value) => `<label class="admin-field">${label}<select name="${name}">${choices.map(([v,l])=>`<option value="${v}" ${v===value?'selected':''}>${l}</option>`).join('')}</select></label>`;
  const hint = (text) => `<p class="settings-note">${esc(text)}</p>`;
  const card = (title, subtitle, body = '', actions = '') => `<article class="admin-card"><div><h3>${esc(title)}</h3>${subtitle ? hint(subtitle) : ''}</div>${body}${actions ? `<div class="admin-actions">${actions}</div>` : ''}</article>`;
  const table = (obj) => `<dl class="admin-facts">${Object.entries(obj || {}).filter(([,v])=>v!==undefined && v!==null && typeof v!=='object').map(([k,v])=>`<div><dt>${esc(k)}</dt><dd>${esc(String(v))}</dd></div>`).join('')}</dl>`;
  const json = (value) => `<pre class="admin-json">${esc(JSON.stringify(value,null,2))}</pre>`;
  function shell(body, intro = '', actions = '') {
    root.innerHTML = `<div class="page-heading"><div><div class="eyebrow">MIMI WORKSPACE</div><h1>${viewTitles[area]}</h1>${hint(intro)}</div><div class="admin-actions">${actions}${!['about','skills','mcp','models','settings','runtime'].includes(area) ? button('更新列表','refresh') : ''}</div></div><p class="admin-notice" role="status" hidden></p>${body}`;
  }
  function notice(text, error = false) { const el = root.querySelector('.admin-notice'); if (el) { el.hidden = false; el.textContent = text; el.classList.toggle('error',error); } }
  async function show(next) {
    area = next; const token = ++version;
    if (area === 'about') {
      shell(`<div class="about-page"><img src="/cat.svg" alt="MimiAgent 黑猫"/><h2>你的个人 Agent。<br>从一次对话，到持续陪伴。</h2><p>MimiAgent 是一个轻量、本地优先、可持续运行的开源个人 Agent。它将对话、记忆、工具和后台执行连接起来，帮你理解问题、完成工作，并持续跟进交给它的事务。</p><p>会话与记忆保存在本机，模型和扩展由你选择。每一次行动都可查看，每一项任务都可接管。</p><a class="github-link" href="https://github.com/Kickflip73/MimiAgent" target="_blank" rel="noopener noreferrer" aria-label="在 GitHub 查看 MimiAgent">${github}<span>GitHub · Kickflip73 / MimiAgent</span></a></div>`); return;
    }
    shell('<div class="admin-loading"><img src="/cat.svg" alt=""/>正在读取…</div>');
    try { const value = await read(area); if (token !== version) return; data = value; render(); }
    catch (e) { if (token === version) { shell(''); notice(e.message,true); } }
  }
  function configEditor(kind, value) {
    return `<details class="admin-advanced"><summary>高级配置 · JSON</summary>${hint(kind==='mcp'?'保存后点击“重新连接”使连接配置生效。已保存的敏感值以标记代替，保持标记即可保留原值。':'配置包含提供方、模型能力与场景路由。保存时校验所有路由目标；下一次运行重新读取。')}<form data-admin-form="${kind}.save"><textarea class="config-editor" name="config" aria-label="${kind==='mcp'?'MCP 配置':'模型配置'}" spellcheck="false">${esc(JSON.stringify(value,null,2))}</textarea><button class="primary-button" type="submit">保存配置</button></form></details>`;
  }
  function render() {
    if (area === 'skills') {
      shell(`<input class="admin-search" aria-label="搜索 Skill" placeholder="搜索名称、描述或来源"/><div class="admin-grid square-grid">${(data || []).map((s,i)=>`<div data-search="${esc((s.name+' '+s.description+' '+s.source?.scope).toLowerCase())}">${card(s.name,s.description,`<div class="admin-tags"><span>${esc(s.source?.scope || '未知来源')}</span><span>${s.enabled?'已启用':'已停用'}</span></div>`,button('查看内容','skill.detail',`data-index="${i}"`)+button(s.enabled?'停用':'启用','skill.toggle',`data-index="${i}"`))}</div>`).join('') || hint('暂未发现 Skill。将 SKILL.md 放入项目 skills/ 或用户技能目录后重新扫描。')}</div>`, '按来源发现和管理技能。启停默认仅作用于当前项目。',button('同步本地技能','skills.reload'));
    } else if (area === 'mcp') {
      const servers = {...data.config.servers,...data.config.mcpServers};
      shell(`<div class="admin-grid">${Object.entries(servers).map(([name,s])=>{ const status=(data.status||[]).find(item=>item.name===name) || (data.status||[]).find(item=>item.name==='workspace-mcp'); return card(name,s.url || [s.command,...(s.args||[])].join(' '),table({'配置':s.enabled===false?'停用':'启用','连接':({configured:'按需连接',connected:'已连接',failed:'连接失败',disabled:'已停用'})[status?.state]||status?.state||'尚未连接','工具':status?.tools??0})+(status?.error?hint(status.error):''),button('编辑','mcp.edit',`data-name="${esc(name)}"`)+button(s.enabled===false?'启用配置':'停用配置','mcp.toggle',`data-name="${esc(name)}"`)); }).join('') || hint('还没有 MCP Server。添加本地命令或 HTTP 地址。')}</div><details class="admin-advanced"><summary>添加 MCP Server</summary><form data-admin-form="mcp.add" class="admin-form">${field('名称','name','','text','required')}${select('连接方式','type',[['stdio','本地进程'],['http','HTTP']],'stdio')}${field('命令或 HTTP URL','endpoint','','text','required')}${field('命令参数（JSON 数组）','args','[]')}<button class="primary-button">保存 Server</button></form></details>${configEditor('mcp',data.config)}`, '管理本工作区的工具服务。保存配置后重新连接；后台仍按已有工作区信任策略执行。',button('重新连接服务','mcp.reload'));
    } else if (area === 'models') {
      shell(`<div class="admin-grid">${data.config.providers.map(p=>card(p.label,p.id+' · '+p.transport,table({'地址':p.baseUrl||'官方默认','凭证环境变量':p.apiKeyEnv,'凭证':data.providers.find(x=>x.id===p.id)?.configured?'已配置':'未配置'})+`<div class="admin-tags">${p.models.map(m=>`<span>${esc(m.target.modelId)}</span>`).join('')}</div>`,button('编辑','provider.edit',`data-id="${esc(p.id)}"`))).join('')}</div><details class="admin-advanced"><summary>接入模型提供方</summary><form data-admin-form="models.add" class="admin-form">${field('提供方 ID','id','','text','required pattern="[a-zA-Z0-9_-]+"')}${field('显示名称','label','','text','required')}${select('接口协议','transport',[['openai-chat-completions','OpenAI Chat Completions'],['openai-responses','OpenAI Responses'],['anthropic-messages','Anthropic Messages'],['google-generate-content','Google Generate Content']],'openai-chat-completions')}${field('API Base URL','baseUrl','','url')}${field('API Key','apiKey','','password','autocomplete="new-password"')}${field('凭证环境变量（自动创建）','apiKeyEnv','','text','readonly placeholder="保存时生成"')}${probeMarkup()}${field('模型 ID（也可手动填写）','modelId')}${field('上下文窗口','contextWindow','128000','number','min="1024" required')}${hint('密钥保存在本机私有环境文件中，之后只展示变量名与已配置状态。')}<button class="primary-button">保存提供方</button></form></details>${configEditor('models',data.config)}`, '管理模型提供方、能力与路由。对话中的模型选择只影响当前会话。',button('校验配置文件','model.doctor'));
    } else if (area === 'connectors') {
      shell(`<div class="admin-grid">${(data||[]).map(c=>card(c.name||c.id,c.description||c.id,table({'状态':c.online?'在线':'离线','配置':c.enabled?'启用':'停用'})+`<details><summary>能力与连接详情</summary>${json(c)}</details>`,button(c.enabled?'停用':'启用','connector.toggle',`data-id="${esc(c.id)}" data-enabled="${!c.enabled}"`))).join('') || hint('没有发现连接器。')}</div>`, '连接器负责接入外部应用、事件和消息渠道。启用后可能开始监听已配置的来源。',button('重新加载','connectors.reload'));
    } else if (area === 'schedules') {
      shell(`<div class="admin-grid square-grid">${(data.items||[]).map(s=>card(s.name,s.promptPreview,`<div class="schedule-summary"><code>${esc(s.type==='cron'?s.value:s.type==='interval'?`每 ${Number(s.value)/60000} 分钟`:'单次任务')}</code><span>${s.enabled?'下次 '+new Date(s.nextRunAt).toLocaleString():'已停用'}</span></div>`,button('详情与记录','schedule.detail',`data-id="${esc(s.id)}"`)+button('编辑','schedule.edit',`data-id="${esc(s.id)}"`)+button(s.enabled?'停用':'启用','schedule.toggle',`data-id="${esc(s.id)}"`)+button('删除','schedule.remove',`data-id="${esc(s.id)}"`))).join('') || hint('暂无定时任务。')}</div>${data.truncated?hint('当前展示前 2000 条。'):''}<details class="admin-advanced"><summary>新建定时任务</summary><form data-admin-form="schedule.add" class="admin-form">${field('名称','name','','text','required')}${field('Cron 表达式','cron','0 9 * * *','text','required maxlength="200" placeholder="0 9 * * *"')}<div class="admin-wide">${hint('分 时 日 月 周 · '+(data.timezone||'后台本地时区')+' · 例如 0 9 * * 1-5（工作日 09:00），*/30 * * * *（每半小时）')}${button('预览执行时间','schedule.preview')}<div id="cron-preview" aria-live="polite"></div></div><label class="admin-field admin-wide">执行内容<textarea name="prompt" required maxlength="20000" placeholder="到时需要 Mimi 做什么？"></textarea></label>${data.cronAvailable===false?hint('当前后台尚未加载 cron 更新；完成正在执行的任务并更新后台后即可创建。'):''}<button class="primary-button" ${data.cronAvailable===false?'disabled':''}>创建计划</button></form></details>`, '按 cron 自动执行，保留每次运行的记录与对话。');
    } else if (area === 'runtime') {
      shell(`${hint('启动工作区：'+data.workspaceRoot)}<div class="runtime-tabs">${data.documents.map((d,i)=>button(d.title,'document',`data-index="${i}"`)).join('')}</div><div id="prompt-editor"></div>`, '这些文件共同影响 Mimi 的系统指令。保存后下一次运行直接读取，无需重启；当前已经发出的请求保持原样。');
      renderDocument(0);
    } else if (area === 'settings') {
      shell(`<form data-admin-form="settings.save" class="admin-form settings-form">${select('新 Web 对话的默认模式','mode',[['general','通用模式'],['plan','只读规划'],['ultra','协作模式']],data.mode)}${select('执行过程展示等级','outputLevel',[['answer','仅回答'],['thinking','回答与思考'],['tools','回答与工具'],['trace','完整执行记录']],data.outputLevel)}${select('新对话的安全等级','security',[['inherit','跟随后台默认值'],['safe','只读'],['workstation','工作区'],['full-owner','完整权限（受后台限制）']],data.security||'inherit')}${select('发送快捷键','sendWith',[['enter','Enter'],['mod-enter','⌘ / Ctrl + Enter']],data.sendWith||'enter')}<label class="admin-check"><input name="expandExecution" type="checkbox" ${data.expandExecution?'checked':''}>默认展开执行过程</label><div class="admin-actions"><button class="primary-button">保存默认设置</button></div></form>`, '默认模式用于新建 Web 对话；展示偏好保存到本机，当前页面立即使用。');
    } else if (area === 'status') {
      const s=data.status||{},r=data.runtime||{};
      shell(`<div class="admin-grid">${card('Mimi 后台',s.error||'本机常驻运行内核',table({'PID':s.pid,'版本':s.buildVersion,'工作区':s.workspaceRoot,'活动任务':s.activeTaskCount,'启用日程':s.enabledSchedules,'连接器':s.connectorCount}))}${card('当前会话',r.error||r.sessionTitle||'',table({'模型':r.model,'提供方':r.provider,'模式':r.mode?.label,'输出等级':r.outputLevel,'安全等级':r.securityProfile?.label,'Skills':r.skillCount,'记忆':r.memoryCount}))}</div><details class="admin-advanced"><summary>诊断详情</summary>${json(data)}</details>`, '查看真实后台、当前会话及主动关注系统的状态。');
    }
    enhanceSelects(root);
  }
  function detailError(error) { const el=detail.querySelector('.detail-error'); if(el)el.textContent=error.message; }
  async function openSkill(skill) {
    openDialog(skill.name,`${hint(skill.description)}<p class="detail-error" role="status"></p><div class="skill-browser"><aside><h3 class="skill-tree-title">文件目录</h3><div id="skill-tree" class="skill-tree"></div></aside><section><div class="skill-file-heading"><code id="skill-file-path">SKILL.md</code><span id="skill-file-size"></span><button type="button" class="secondary-button" data-skill-edit disabled>修改</button></div><pre id="skill-file-content" class="skill-file-content">正在读取…</pre><textarea id="skill-file-editor" class="config-editor" aria-label="编辑 Skill 文件" spellcheck="false" hidden></textarea><div id="skill-file-more"></div><div id="skill-edit-actions" class="admin-actions" hidden><button type="button" class="primary-button" data-skill-save>确定</button><button type="button" class="secondary-button" data-skill-cancel>取消</button></div></section></div>`,'SKILL');
    const token=++detailVersion; detailState={kind:'skill',name:skill.name,file:'SKILL.md',fileVersion:0};
    await Promise.all([loadSkillFile('SKILL.md'),loadSkillDirectory('',detail.querySelector('#skill-tree'),token)]);
  }
  async function loadSkillDirectory(path,container,token,offset=0) {
    try {
      const value=await write('skills.resource',{name:detailState.name,path,offset});
      if(token!==detailVersion || !container.isConnected)return;
      if(value.kind==='file')return loadSkillFile(path);
      const html=value.entries.map(entry=>entry.directory?`<details class="skill-directory"><summary data-skill-dir="${esc(entry.path)}">▸ ${esc(entry.name)}</summary><div class="skill-tree-children"></div></details>`:`<button class="skill-file-link" data-skill-file="${esc(entry.path)}">${entry.link?'↗':'·'} ${esc(entry.name)}</button>`).join('');
      container.querySelector('[data-directory-more]')?.remove();
      container.insertAdjacentHTML('beforeend',html+(value.nextOffset!==undefined?`<button class="text-button" data-directory-more="${value.nextOffset}" data-path="${esc(path)}">更多文件</button>`:''));
    } catch(error) { if(token===detailVersion)detailError(error); }
  }
  async function loadSkillFile(path,offset=0) {
    const token=detailVersion, view=detailState, fileToken=++view.fileVersion;
    if(view.editing && !confirm('放弃尚未保存的修改？'))return;
    view.editing=false;detail.querySelector('#skill-file-editor').hidden=true;detail.querySelector('#skill-edit-actions').hidden=true;detail.querySelector('#skill-file-content').hidden=false;
    try {
      if(!offset) { view.file=path; detail.querySelector('#skill-file-path').textContent=path; detail.querySelector('#skill-file-content').textContent='正在读取…';detail.querySelector('#skill-file-more').innerHTML=''; }
      const value=await write('skills.resource',{name:view.name,path,offset});
      if(token!==detailVersion || fileToken!==view.fileVersion)return;
      if(value.kind!=='file') { detail.querySelector('#skill-file-content').textContent='这是一个目录'; return; }
      const content=detail.querySelector('#skill-file-content');
      content.textContent=offset?content.textContent+value.content:value.content;
      view.resource=value;detail.querySelector('[data-skill-edit]').disabled=!!offset || value.binary || !value.revision || value.size>200000;
      detail.querySelector('#skill-file-size').textContent=`${new Intl.NumberFormat().format(value.size)} B${value.binary?' · 二进制 / HEX':''}`;
      detail.querySelector('#skill-file-more').innerHTML=value.nextOffset!==undefined?`<button class="text-button" data-file-more="${value.nextOffset}">继续读取文件</button>`:'';
      detail.querySelectorAll('[data-skill-file]').forEach(el=>el.classList.toggle('active',el.dataset.skillFile===path));
      detail.querySelector('.detail-error').textContent='';
    } catch(error) { if(token===detailVersion && fileToken===view.fileVersion)detailError(error); }
  }
  const runLabels={queued:'等待执行',running:'运行中',completed:'已完成',failed:'失败',cancelled:'已取消',interrupted:'已中断',paused:'已暂停',blocked:'等待处理'};
  async function openSchedule(id) {
    openDialog('定时任务','<p class="detail-error" role="status"></p><div id="schedule-description">正在读取…</div><h3 class="skill-tree-title">执行记录</h3><div id="schedule-history"></div>','SCHEDULE');
    const token=++detailVersion;detailState={kind:'schedule',id};
    try {
      const [schedule] = await Promise.all([write('schedule.detail',{id}),loadScheduleHistory(id,0,token)]);
      if(token!==detailVersion)return;
      detail.querySelector('#schedule-description').innerHTML=schedule?`<h3>${esc(schedule.name)}</h3>${table({[schedule.type==='cron'?'Cron':'执行间隔']:schedule.type==='interval'?`每 ${Number(schedule.value)/60000} 分钟`:schedule.value,'时区':data.timezone||'后台本地时区','下次执行':schedule.enabled?new Date(schedule.nextRunAt).toLocaleString():'已停用'})}<div class="schedule-prompt">${esc(schedule.prompt)}</div>`:hint('该计划已删除。');
    } catch(error) {if(token===detailVersion)detailError(error);}
  }
  async function loadScheduleHistory(id,offset,token) {
    const value=await write('schedule.history',{id,offset});
    if(token!==detailVersion)return;
    const list=detail.querySelector('#schedule-history');list.querySelector('[data-history-more]')?.remove();
    list.insertAdjacentHTML('beforeend',value.items.map(run=>`<article class="schedule-run"><div><time>${esc(new Date(run.startedAt||run.createdAt).toLocaleString())}</time><span>${esc(run.outcome==='partial'?'部分完成':runLabels[run.status]||run.status)}${run.attempt?' · 第 '+run.attempt+' 次尝试':''}${run.completedAt&&run.startedAt?' · '+Math.max(0,Math.round((Date.parse(run.completedAt)-Date.parse(run.startedAt))/1000))+'s':''}</span>${run.error?hint(run.error):''}</div>${run.sessionId?`<button class="secondary-button" data-open-session="${esc(run.sessionId)}" data-execution="${esc(run.taskId)}" data-run-id="${esc(run.runId||'')}">查看对话 ↗</button>`:hint('等待会话建立')}</article>`).join('')+(!offset&&!value.items.length?hint('还没有执行记录。'):'')+(value.nextOffset!==undefined?`<button class="text-button" data-history-more="${value.nextOffset}">更早的执行</button>`:''));
  }
  async function editSchedule(id) {
    openDialog('编辑定时任务','<p class="detail-error" role="status">正在读取…</p>','SCHEDULE');const token=++detailVersion;
    try {const schedule=await write('schedule.detail',{id});if(token!==detailVersion)return;
      const next=new Date(schedule.nextRunAt),cron=schedule.type==='cron'?schedule.value:`${next.getMinutes()} ${next.getHours()} * * *`;
      detail.innerHTML=`<p class="detail-error" role="status"></p><form id="schedule-edit-form" class="admin-form">${field('名称','name',schedule.name,'text','required')}${select('执行方式','type',[['cron','Cron 周期计划'],['at','单次计划']],schedule.type==='at'?'at':'cron')}${field('Cron / ISO 时间','value',schedule.type==='at'?schedule.value:cron,'text','required')}<label class="admin-field admin-wide">执行内容<textarea name="prompt" class="config-editor" required maxlength="20000">${esc(schedule.prompt)}</textarea></label><label class="admin-check"><input type="checkbox" name="enabled" ${schedule.enabled?'checked':''}>启用计划</label>${hint('时区：'+(data.timezone||'后台本地时区')+'。修改只影响后续执行，保留已有记录。'+(schedule.type==='interval'?'原间隔计划将在保存后转换为 Cron，请核对时间。':''))}<button type="submit" class="primary-button">保存修改</button></form>`;
      detailState={kind:'schedule-edit',schedule};enhanceSelects(detail);
    }catch(error){if(token===detailVersion)detailError(error);}
  }
  detail.addEventListener('submit',async event=>{
    if(!event.target.matches('form#schedule-edit-form'))return;
    event.preventDefault();const token=detailVersion,schedule=detailState.schedule,values=Object.fromEntries(new FormData(event.target)),submit=event.target.querySelector('[type="submit"]');submit.disabled=true;
    try{await write('schedule.update',{id:schedule.id,updatedAt:schedule.updatedAt,patch:{name:values.name,prompt:values.prompt,type:values.type,value:values.value,enabled:values.enabled==='on'}});if(token===detailVersion){document.querySelector('#detail-dialog').close();await show(area);}}
    catch(error){if(token===detailVersion)detailError(error);}finally{submit.disabled=false;}
  });
  function editMcp(name) {
    const config=structuredClone(data.config),server=config.mcpServers?.[name]||config.servers?.[name];
    openDialog('编辑 '+name,`<p class="detail-error" role="status"></p><form id="mcp-edit-form" class="admin-form">${field('名称','name',name,'text','readonly')}${select('连接方式','type',[['stdio','本地进程'],['http','HTTP'],['sse','SSE']],server.type||'stdio')}${field('命令或 URL','endpoint',server.url||server.command||'','text','required')}${field('命令参数 · JSON','args',JSON.stringify(server.args||[]))}<label class="admin-field admin-wide">环境变量 · JSON<textarea class="config-editor" name="env">${esc(JSON.stringify(server.env||{},null,2))}</textarea></label><label class="admin-field admin-wide">请求头 · JSON<textarea class="config-editor" name="headers">${esc(JSON.stringify(server.headers||{},null,2))}</textarea></label>${hint('敏感值保持原标记即可保留。保存后重新连接服务。')}<button type="submit" class="primary-button">保存修改</button></form>`,'MCP');
    detailVersion++;detailState={kind:'mcp',name,config,revision:data.revision};enhanceSelects(detail);
  }
  detail.addEventListener('submit',async event=>{
    if(!event.target.matches('form#mcp-edit-form'))return;
    event.preventDefault();const view=detailState,token=detailVersion,values=Object.fromEntries(new FormData(event.target)),submit=event.target.querySelector('[type="submit"]');submit.disabled=true;
    try {const owner=view.config.mcpServers?.[view.name]?view.config.mcpServers:view.config.servers;const server=owner[view.name];delete server.command;delete server.url;delete server.args;Object.assign(server,{type:values.type,...(values.type==='stdio'?{command:values.endpoint,args:JSON.parse(values.args)}:{url:values.endpoint}),env:JSON.parse(values.env),headers:JSON.parse(values.headers)});await write('mcp.save',{config:view.config,revision:view.revision});if(token===detailVersion){document.querySelector('#detail-dialog').close();await show(area);}}
    catch(error){if(token===detailVersion)detailError(error);}finally{submit.disabled=false;}
  });
  function probeMarkup() { return `<div class="admin-wide provider-probe"><div class="admin-actions"><button type="button" class="secondary-button" data-provider-probe="discover">扫描模型</button><button type="button" class="secondary-button" data-provider-probe="health">测试连接</button></div><p class="settings-note probe-status" role="status">填写地址与密钥后自动扫描可用模型</p><div class="discovered-models"></div></div>`; }
  let probeSequence=0,probeTimer;
  async function probeProvider(form,kind='discover') {
    const values=Object.fromEntries(new FormData(form));if(!values.id || (!values.apiKey && !values.apiKeyEnv))return;
    const sequence=++probeSequence,status=form.querySelector('.probe-status');status.textContent=kind==='health'?'正在测试连接…':'正在扫描模型…';
    const buttons=form.querySelectorAll('[data-provider-probe]');buttons.forEach(b=>b.disabled=true);
    try {const result=await write('models.'+kind,{id:values.id,transport:values.transport,baseUrl:values.baseUrl,...(values.apiKey?{apiKey:values.apiKey}:{}),...(values.apiKeyEnv?{apiKeyEnv:values.apiKeyEnv}:{})});if(sequence!==probeSequence||!form.isConnected)return;status.textContent=`连接正常 · ${result.latencyMs}ms · ${result.models.length} 个模型。${result.note}`;
      if(kind==='discover'){const registered=new Set(detailState?.kind==='provider'?detailState.provider.models.map(m=>m.target.modelId):[]);form.querySelector('.discovered-models').innerHTML=result.models.map(m=>`<label><input type="checkbox" name="discoveredModel" value="${esc(m.id)}" ${registered.has(m.id)?'checked disabled':''}>${esc(m.id)}</label>`).join('')||'服务未返回模型列表，可手动填写模型 ID。';}
    }catch(error){if(sequence===probeSequence&&form.isConnected)status.textContent=error.message;}finally{buttons.forEach(b=>b.disabled=false);}
  }
  for(const container of [root,detail]) {
    container.addEventListener('click',event=>{const el=event.target.closest('[data-provider-probe]');if(el)void probeProvider(el.closest('form'),el.dataset.providerProbe);});
    container.addEventListener('input',event=>{const form=event.target.closest('form');if(!form?.querySelector('.provider-probe')||!['id','baseUrl','apiKey'].includes(event.target.name))return;clearTimeout(probeTimer);probeSequence++;probeTimer=setTimeout(()=>void probeProvider(form),800);});
  }
  async function credential(form,values) {
    if(!values.apiKey?.trim())return values.apiKeyEnv;
    const result=await write('models.credential',{id:values.id,apiKey:values.apiKey,...(values.apiKeyEnv?{apiKeyEnv:values.apiKeyEnv}:{})});
    form.elements.apiKey.value='';form.elements.apiKey.placeholder='•••••••• · 已保存';form.elements.apiKeyEnv.value=result.apiKeyEnv;return result.apiKeyEnv;
  }
  const registration=(id,modelId,contextWindow)=>({target:{providerId:id,modelId},kind:'agent',capabilities:{imageInput:false,imageOutput:false,toolCalling:true},...(contextWindow?{contextWindow:Number(contextWindow)}:{})});
  function editProvider(id) {
    const config=structuredClone(data.config), provider=config.providers.find(p=>p.id===id);
    openDialog('编辑 '+provider.label,`<p class="detail-error" role="status"></p><form id="provider-edit-form" class="admin-form">${field('提供方 ID','id',provider.id,'text','readonly')}${field('显示名称','label',provider.label,'text','required')}${select('接口协议','transport',[['openai-chat-completions','OpenAI Chat Completions'],['openai-responses','OpenAI Responses'],['anthropic-messages','Anthropic Messages'],['google-generate-content','Google Generate Content']],provider.transport)}${field('API Base URL','baseUrl',provider.baseUrl||'','url')}${field('API Key','apiKey','','password',`autocomplete="new-password" placeholder="${data.providers.find(p=>p.id===id)?.configured?'•••••••• · 留空保留':'填写 API Key'}"`)}${field('凭证环境变量','apiKeyEnv',provider.apiKeyEnv,'text','readonly')}${probeMarkup()}<div class="admin-wide"><h3>模型</h3>${provider.models.map((m,i)=>`<div class="provider-model-row">${field('模型 ID',`model-${i}`,m.target.modelId,'text','required')}${field('上下文窗口',`window-${i}`,m.contextWindow??'','number','min="1"')}</div>`).join('')}</div><div class="admin-actions admin-wide"><button class="primary-button" type="submit">保存修改</button><span class="settings-note">下一次运行生效</span></div></form>`,'MODELS');
    detailVersion++;detailState={kind:'provider',config,provider,revision:data.revision};enhanceSelects(detail);
  }
  detail.addEventListener('click',async event=>{
    const el=event.target.closest('button,summary');if(!el)return;
    const token=detailVersion;
    try {
      if(el.hasAttribute('data-skill-edit')) { detailState.editing=true;detail.querySelector('#skill-file-editor').value=detail.querySelector('#skill-file-content').textContent;detail.querySelector('#skill-file-editor').hidden=false;detail.querySelector('#skill-file-content').hidden=true;detail.querySelector('#skill-edit-actions').hidden=false; }
      if(el.hasAttribute('data-skill-cancel')) { detailState.editing=false;await loadSkillFile(detailState.file); }
      if(el.hasAttribute('data-skill-save')) { el.disabled=true;await write('skills.save',{name:detailState.name,path:detailState.file,content:detail.querySelector('#skill-file-editor').value,revision:detailState.resource.revision});detailState.editing=false;await loadSkillFile(detailState.file); }
      if(el.dataset.skillDir && !el.dataset.loaded) { el.dataset.loaded='1';await loadSkillDirectory(el.dataset.skillDir,el.nextElementSibling,token); }
      if(el.dataset.skillFile)await loadSkillFile(el.dataset.skillFile);
      if(el.dataset.fileMore)await loadSkillFile(detailState.file,Number(el.dataset.fileMore));
      if(el.dataset.directoryMore)await loadSkillDirectory(el.dataset.path,el.parentElement,token,Number(el.dataset.directoryMore));
      if(el.dataset.historyMore) {el.disabled=true;await loadScheduleHistory(detailState.id,Number(el.dataset.historyMore),token);}
    }catch(error){if(token===detailVersion)detailError(error);}finally{el.disabled=false;}
  });
  detail.addEventListener('submit',async event=>{
    if(!event.target.matches('form#provider-edit-form'))return;
    event.preventDefault();const form=event.target,view=detailState,token=detailVersion,values=Object.fromEntries(new FormData(form));
    const submit=form.querySelector('[type="submit"]');submit.disabled=true;
    try {
      const config=structuredClone(view.config),provider=config.providers.find(p=>p.id===view.provider.id);
      const renames=new Map(provider.models.map((m,i)=>[m.target.modelId,values[`model-${i}`]]));
      const apiKeyEnv=await credential(form,values);
      Object.assign(provider,{label:values.label,transport:values.transport,apiKeyEnv});
      if(values.baseUrl)provider.baseUrl=values.baseUrl;else delete provider.baseUrl;
      provider.models.forEach((m,i)=>{m.target.modelId=values[`model-${i}`];if(values[`window-${i}`])m.contextWindow=Number(values[`window-${i}`]);else delete m.contextWindow;});
      for(const id of new FormData(form).getAll('discoveredModel'))if(!provider.models.some(m=>m.target.modelId===id))provider.models.push(registration(provider.id,id));
      const remap=target=>target?.providerId===provider.id && renames.has(target.modelId)?{...target,modelId:renames.get(target.modelId)}:target;
      config.routing.globalDefault=remap(config.routing.globalDefault);
      for(const route of Object.values(config.routing.scenarios)){if(route.target)route.target=remap(route.target);if(route.candidates)route.candidates=route.candidates.map(remap);}
      await write('models.save',{config,revision:view.revision});
      if(token!==detailVersion)return;
      document.querySelector('#detail-dialog').close();if(area==='models')await show(area);
    }catch(error){if(token===detailVersion)detailError(error);}finally{submit.disabled=false;}
  });
  function renderDocument(index) {
    const doc=data.documents[index];
    root.querySelector('#prompt-editor').innerHTML=`<form data-admin-form="runtime.save" data-index="${index}"><h3>${esc(doc.title)}</h3>${hint(doc.file)}<textarea class="config-editor prompt-editor" name="content" maxlength="20000" aria-label="指令内容" spellcheck="false">${esc(promptDrafts.get(doc.file)?.content ?? doc.content)}</textarea><div class="admin-actions"><button class="primary-button">保存并生效</button><span class="settings-note">${doc.content?'已读取当前文件':'尚无用户文件，保存后创建覆盖'}</span></div></form>`;
  }
  root.addEventListener('input', event=>{ if (event.target.matches('.prompt-editor')) { const doc=data.documents[Number(event.target.closest('form').dataset.index)]; const previous=promptDrafts.get(doc.file); promptDrafts.set(doc.file,{content:event.target.value,revision:previous?.revision || doc.revision}); } if (event.target.matches('.admin-search')) { const query=event.target.value.toLowerCase(); root.querySelectorAll('[data-search]').forEach(el=>el.hidden=!el.dataset.search.includes(query)); } });
  root.addEventListener('click', async event=>{
    const el=event.target.closest('[data-admin]'); if(!el)return;
    const action=el.dataset.admin, token=version;
    if(action==='refresh')return show(area);
    if(action==='document')return renderDocument(Number(el.dataset.index));
    if(action==='skill.detail') return openSkill(data[Number(el.dataset.index)]);
    if(action==='schedule.edit')return editSchedule(el.dataset.id);
    if(action==='schedule.detail') return openSchedule(el.dataset.id);
    if(action==='mcp.edit')return editMcp(el.dataset.name);
    if(action==='provider.edit') return editProvider(el.dataset.id);
    if(action==='schedule.remove' && !el.dataset.confirmed) { el.dataset.confirmed='yes'; el.textContent='确认删除计划'; return; }
    el.disabled=true;
    try {
      let result;
      if(action==='schedule.preview') { const value=await write('schedule.preview',{cron:root.querySelector('[name="cron"]').value}); root.querySelector('#cron-preview').innerHTML=hint(value.times.map(t=>new Date(t).toLocaleString()).join(' · ')); return; }
      if(action==='skill.toggle') { const s=data[Number(el.dataset.index)]; result=await write('skills.set',{name:s.name,scope:'project',enabled:!s.enabled}); }
      else if(action==='connector.toggle') result=await write('connectors.setEnabled',{id:el.dataset.id,enabled:el.dataset.enabled==='true'});
      else if(action==='schedule.toggle') {const current=await write('schedule.detail',{id:el.dataset.id});result=await write('schedule.update',{id:current.id,updatedAt:current.updatedAt,patch:{enabled:!current.enabled}});}
      else if(action==='schedule.remove') result=await write(action,{id:el.dataset.id});
      else if(action==='mcp.toggle') { const config=structuredClone(data.config); const owner=config.mcpServers?.[el.dataset.name]?config.mcpServers:config.servers; owner[el.dataset.name].enabled=owner[el.dataset.name].enabled===false; result=await write('mcp.save',{config,revision:data.revision}); }
      else if(action==='settings.apply') { const form=root.querySelector('form'); const value={mode:form.elements.mode.value,outputLevel:form.elements.outputLevel.value,expandExecution:form.elements.expandExecution.checked}; result=await write(action,value); onSessionSettings(value); }
      else result=await write(action,{});
      if(token!==version)return;
      if(action==='model.doctor') {openDialog('模型配置检查',json(result),'MODELS');return;}
      if(action==='settings.apply'){notice('已应用到当前对话');return;}
      await show(area); notice(action==='mcp.toggle'?'配置已保存，点击“重新连接”生效':'已更新');
    }catch(e){if(token===version)notice(e.message,true);}finally{el.disabled=false;}
  });
  root.addEventListener('submit', async event=>{
    const form=event.target.closest('[data-admin-form]'); if(!form)return;
    event.preventDefault(); const token=version, action=form.dataset.adminForm, values=Object.fromEntries(new FormData(form));
    const submit=form.querySelector('[type="submit"],button:not([type])'); if(submit)submit.disabled=true;
    try {
      let result;
      if(action==='runtime.save'){const doc=data.documents[Number(form.dataset.index)]; result=await write(action,{id:doc.id,revision:promptDrafts.get(doc.file)?.revision || doc.revision,content:values.content});doc.content=values.content;doc.revision=result.revision;promptDrafts.delete(doc.file);}
      else if(action==='settings.save'){const value={mode:values.mode,outputLevel:values.outputLevel,expandExecution:values.expandExecution==='on',security:values.security,sendWith:values.sendWith};result=await write(action,value);data=result;onSettings(result);}
      else if(action==='schedule.add'){result=await write(action,{name:values.name,prompt:values.prompt,type:'cron',cron:values.cron});}
      else if(action==='models.add'){
        const config=structuredClone(data.config); if(config.providers.some(p=>p.id===values.id))throw new Error('提供方 ID 已存在，请通过高级配置编辑');
        const modelIds=[...new Set([values.modelId,...new FormData(form).getAll('discoveredModel')].filter(Boolean))];if(!modelIds.length)throw new Error('请选择扫描到的模型或手动填写模型 ID');
        const apiKeyEnv=await credential(form,values);if(!apiKeyEnv)throw new Error('请填写 API Key');
        config.providers.push({id:values.id,label:values.label,transport:values.transport,...(values.baseUrl?{baseUrl:values.baseUrl}:{}),apiKeyEnv,models:modelIds.map(id=>registration(values.id,id,values.contextWindow))});
        result=await write('models.save',{config,revision:data.revision});
      }else if(action==='mcp.add'){
        const config=structuredClone(data.config); config.mcpServers ||= {};
        if(config.mcpServers[values.name]||config.servers?.[values.name])throw new Error('名称已存在');
        config.mcpServers[values.name]=values.type==='http'?{type:'http',url:values.endpoint}:{command:values.endpoint,args:JSON.parse(values.args)};
        result=await write('mcp.save',{config,revision:data.revision});
      }else result=await write(action,{config:JSON.parse(values.config),revision:data.revision});
      if(token!==version)return;
      if(action!=='runtime.save'&&action!=='settings.save') await show(area);
      notice(action==='runtime.save'?'已保存，下一次运行直接读取新指令':action.startsWith('mcp.')?'配置已保存，点击“重新连接”生效':'已保存');
    }catch(e){if(token===version)notice(e.message,true);}finally{if(submit)submit.disabled=false;}
  });
  return { show, leave:()=>{version++;}, loadSettings: async()=> {const value=await read('settings');onSettings(value);return value;} };
}
