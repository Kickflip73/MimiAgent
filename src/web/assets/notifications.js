/** Inbox is a projection of durable Outbox messages, never another task queue. */
export function createNotifications({ api, esc, icon, markdown, openSession }) {
  const bell = document.querySelector('#notifications');
  const dialog = document.createElement('dialog');
  dialog.className = 'notification-dialog';
  dialog.setAttribute('aria-labelledby', 'notification-title');
  dialog.innerHTML = `<header><div><span class="eyebrow">MIMI</span><h2 id="notification-title">通知</h2></div><button class="icon-button" data-notice-close aria-label="关闭通知">${icon('close')}</button></header><div class="notification-content"></div>`;
  document.body.append(dialog);
  const content = dialog.querySelector('.notification-content');
  const alert = document.createElement('aside');
  alert.className = 'notification-alert'; alert.hidden = true;
  alert.setAttribute('aria-live', 'polite'); document.body.append(alert);
  let latest = null, snapshot = null, pending = null, revision = 0, showingList = false, timer;
  const time = value => new Date(value).toLocaleString([], {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
  const rows = items => items.map(item => `<button class="notification-row ${item.read?'':'unread'}" data-notice-id="${esc(item.id)}"><span class="notice-dot"></span><span><span class="notification-row-meta"><strong>Mimi</strong><time>${esc(time(item.createdAt))}</time></span><span class="notification-preview">${esc(item.preview)}</span>${item.status==='dead_letter'?'<small>外部通知未确认送达 · 内容已保存</small>':''}</span>${icon('arrow')}</button>`).join('');
  const show = () => { if(!dialog.open)dialog.showModal(); };
  function renderList(data) {
    showingList = true;
    content.innerHTML = `<div class="notification-toolbar"><span>${data.unreadCount?`${data.unreadCount} 条未读`:'已读完所有通知'}</span><button class="text-button" data-notice-read-all ${data.unreadCount?'':'disabled'}>全部已读</button></div><div class="notification-list">${data.items.length?rows(data.items):'<div class="notification-empty"><img src="/cat.svg" alt=""/><p>有新进展时，Mimi 会在这里找你。</p></div>'}</div>${data.nextBefore?`<button class="text-button notification-more" data-notice-before="${data.nextBefore}">更早的通知</button>`:''}`;
  }
  function updateBadge(data) {
    bell.dataset.count = data.unreadCount ? (data.unreadCount > 99 ? '99+' : String(data.unreadCount)) : '';
    bell.setAttribute('aria-label', data.unreadCount ? `通知，${data.unreadCount} 条未读` : '通知');
    bell.title = bell.getAttribute('aria-label');
  }
  function announce(item) {
    alert.innerHTML = `<img src="/cat.svg" alt=""/><button data-notice-id="${esc(item.id)}"><strong>Mimi 有新消息</strong><span>${esc(item.preview)}</span></button><button class="icon-button" data-alert-close aria-label="收起通知">${icon('close')}</button>`;
    alert.hidden = false; clearTimeout(timer); timer=setTimeout(()=>{alert.hidden=true;},10000);
  }
  async function refresh() {
    if(pending)return pending;
    pending = (async()=>{
      const data=await api('notifications'); snapshot=data; updateBadge(data);
      if(showingList && dialog.open && latest!==null && data.latest>latest)renderList(data);
      // First load/backlog never produces a storm of historical banners.
      if(latest!==null && data.latest>latest && !document.hidden && document.hasFocus() && !dialog.open) {
        const item=data.items.find(item=>item.sequence>latest && !item.read);
        if(item)announce(item);
      }
      latest=Math.max(latest??0,data.latest);
      return data;
    })().finally(()=>{pending=null;});
    return pending;
  }
  function error(message) { content.innerHTML=`<div class="notification-empty"><p>${esc(message)}</p><button class="text-button" data-notice-back>重试</button></div>`; }
  async function list() {
    const current=++revision; showingList=true; show();
    content.innerHTML='<div class="notification-empty" role="status">正在读取通知…</div>';
    try { const data=await refresh();if(current===revision)renderList(data); }
    catch(e){if(current===revision)error(e.message);}
  }
  async function detail(id) {
    const current=++revision; showingList=false; show();alert.hidden=true;
    content.innerHTML='<div class="notification-empty" role="status">正在打开消息…</div>';
    try {
      const item=await api(`notifications?id=${encodeURIComponent(id)}`);
      if(current!==revision)return;
      const status=item.status==='dead_letter'?'外部通知未确认送达':item.status==='pending'||item.status==='sending'?'正在投递外部通知':'';
      content.innerHTML=`<button class="text-button" data-notice-back>← 所有通知</button><div class="notification-heading"><img src="/cat.svg" alt=""/><div><strong>Mimi</strong><time>${esc(time(item.createdAt))}</time></div></div><div class="markdown notification-body">${markdown(item.text || '')}</div><footer>${status?`<small>${esc(status)} · 此处保留完整消息</small>`:''}${item.sessionId?`<button class="primary-button" data-notice-session="${esc(item.sessionId)}" data-notice-task="${esc(item.taskId)}" data-notice-run="${esc(item.runId || '')}">进入对话 ${icon('arrow')}</button>`:'<small>这是一条独立提醒，没有关联执行对话。</small>'}</footer>`;
      await api('notifications/read',{id:item.id});await refresh();
    } catch(e){if(current===revision)error(e.message);}
  }
  dialog.addEventListener('click',async event=>{
    const target=event.target.closest('button');if(!target)return;
    try {
      if(target.hasAttribute('data-notice-close'))dialog.close();
      else if(target.hasAttribute('data-notice-back'))await list();
      else if(target.dataset.noticeId)await detail(target.dataset.noticeId);
      else if(target.dataset.noticeSession){dialog.close();await openSession(target.dataset.noticeSession,target.dataset.noticeTask,target.dataset.noticeRun || undefined);}
      else if(target.hasAttribute('data-notice-read-all')){
        target.disabled=true; await api('notifications/read',{through:snapshot.latest}); renderList(await refresh());
      } else if(target.dataset.noticeBefore){
        const current=revision;target.disabled=true;
        const page=await api(`notifications?before=${target.dataset.noticeBefore}`);
        if(current!==revision || !showingList)return;
        content.querySelector('.notification-list').insertAdjacentHTML('beforeend',rows(page.items));
        if(page.nextBefore){target.dataset.noticeBefore=page.nextBefore;target.disabled=false;}else target.remove();
      }
    }catch(e){error(e.message);}
  });
  dialog.addEventListener('close',()=>{revision++;showingList=false; const url=new URL(location.href);if(url.searchParams.has('notification')){url.searchParams.delete('notification');history.replaceState(null,'',url);}});
  alert.addEventListener('click',event=>{const target=event.target.closest('button');if(target?.dataset.noticeId)void detail(target.dataset.noticeId);if(target?.hasAttribute('data-alert-close'))alert.hidden=true;});
  bell.addEventListener('click',()=>void list());
  const id = new URL(location.href).searchParams.get('notification');
  if(id)void detail(id); else void refresh().catch(()=>{});
  setInterval(()=>{if(!document.hidden)void refresh().catch(()=>{});},5000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)void refresh().catch(()=>{});});
  return {refresh,detail};
}
