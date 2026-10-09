// Keep writes ordered per session/control while the menu remains responsive.
export function createSelectionQueue(write, notify) {
  const entries = new Map();
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const version = (key) => entries.get(key)?.version || 0;
  function seed(key, value, readVersion = version(key)) {
    if (version(key) !== readVersion || entries.get(key)?.pending) return;
    entries.set(key, { value, confirmed: value, pending: false, error: '', version: readVersion });
  }
  async function flush(key, entry) {
    for (;;) {
      const value = entry.value, revision = entry.version;
      try {
        await write(key, value);
        entry.confirmed = value;
        entry.error = '';
      } catch (error) {
        if (entry.version === revision) {
          entry.value = entry.confirmed;
          entry.error = error.message || '切换失败，请重试';
        }
      }
      if (entry.version === revision) {
        entry.pending = false;
        notify(key);
        return;
      }
      // Intermediate selections are superseded; only persist the newest one.
    }
  }
  function set(key, value) {
    const entry = entries.get(key);
    if (!entry || (same(entry.value, value) && !entry.error)) return;
    entry.value = value;
    entry.error = '';
    entry.version++;
    const pending = entry.pending;
    entry.pending = true;
    notify(key);
    if (!pending) void flush(key, entry);
  }
  return { seed, set, get: (key) => entries.get(key), version };
}

/** Accessible custom popovers keep the native selects as canonical form state. */
export function setupPickers(onChange) {
  const entries = ['mode', 'model', 'security'].map((id) => {
    const select = document.getElementById(id);
    select.hidden = true;
    const root = document.createElement('div');
    root.className = `picker picker-${id}`;
    root.innerHTML = `<button class="picker-trigger" type="button" aria-label="${id === 'mode' ? '工作模式' : id === 'security' ? '安全等级' : '选择模型'}" aria-haspopup="listbox" aria-expanded="false"><span></span><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m5 6 3 3 3-3"/></svg></button><div class="picker-popover" hidden><div class="picker-heading">${id === 'mode' ? '工作模式' : id === 'security' ? '本轮安全等级' : '回复使用的模型'}</div>${id === 'model' ? '<input type="search" class="picker-search" placeholder="搜索模型…" aria-label="搜索模型" />' : ''}<div class="picker-list" role="listbox" aria-label="${id === 'mode' ? '工作模式' : id === 'security' ? '安全等级' : '选择模型'}"></div><div class="picker-note">${id === 'mode' ? '按当前任务选择合适的工作方式' : id === 'security' ? '用于下一次运行，不超出后台权限上限' : '仅对当前对话的下一次回复生效'}</div></div>`;
    select.after(root);
    const trigger = root.querySelector('button'), panel = root.querySelector('.picker-popover'), list = root.querySelector('.picker-list'), search = root.querySelector('input');
    function close(focus = false) { panel.hidden = true; trigger.setAttribute('aria-expanded', 'false'); if (focus) trigger.focus(); }
    function render() {
      const query = search?.value.trim().toLowerCase() || '';
      list.replaceChildren();
      for (const option of select.options) {
        if (!option.textContent.toLowerCase().includes(query)) continue;
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'picker-option';
        button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(option.selected));
        button.disabled = option.disabled;
        const title = document.createElement('span'); title.textContent = option.textContent; button.append(title);
        const description = { general: '思考、执行，处理日常事务', plan: '先分析与规划，不修改内容', ultra: '多角色协作，推进复杂任务', safe: '只读，无 Shell 与外部写入', workstation: '工作区写入与沙箱 Shell', 'full-owner': '使用后台已配置的完整权限' }[option.value];
        if (id !== 'model' && description) { const small = document.createElement('small'); small.textContent = description; button.append(small); }
        if (option.selected) { const check = document.createElement('span'); check.className = 'picker-check'; check.textContent = '✓'; button.append(check); }
        button.onclick = () => { select.value = option.value; close(true); sync(); onChange(id); };
        list.append(button);
      }
      if (!list.children.length) { const empty = document.createElement('p'); empty.className = 'picker-note'; empty.textContent = '没有匹配的模型'; list.append(empty); }
    }
    trigger.onclick = () => {
      const opening = panel.hidden;
      entries.forEach((entry) => entry.close());
      if (opening) { render(); panel.hidden = false; panel.style.transform = ''; const bounds = panel.getBoundingClientRect(); const shift = bounds.left < 12 ? 12 - bounds.left : bounds.right > innerWidth - 12 ? innerWidth - 12 - bounds.right : 0; panel.style.transform = `translateX(${shift}px)`; trigger.setAttribute('aria-expanded', 'true'); (search || list.querySelector('[aria-selected="true"]') || list.querySelector('button'))?.focus(); }
    };
    if (search) search.oninput = render;
    root.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.stopPropagation(); close(true); }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      if (panel.hidden) { trigger.click(); return; }
      const options = [...list.querySelectorAll('button:not(:disabled)')];
      const at = options.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (at + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
      options[next]?.focus();
    });
    return { close, root, select, trigger };
  });
  function sync() {
    for (const { select, trigger, close } of entries) {
      trigger.disabled = select.disabled;
      trigger.setAttribute('aria-busy', select.dataset.pending || 'false');
      trigger.querySelector('span').textContent = select.selectedOptions[0]?.textContent || '读取中…';
      trigger.title = select.title;
      if (select.disabled) close();
    }
  }
  document.addEventListener('click', (event) => { for (const entry of entries) if (!entry.root.contains(event.target)) entry.close(); });
  return { sync, close: () => entries.forEach((entry) => entry.close()) };
}

/** Management forms use the same visual and keyboard selection language. */
export function enhanceSelects(container) {
  for(const select of container.querySelectorAll('select:not([data-enhanced])')) {
    select.dataset.enhanced='1';select.hidden=true;
    const root=document.createElement('div');root.className='picker form-picker';
    root.innerHTML='<button type="button" class="picker-trigger" aria-haspopup="listbox" aria-expanded="false"><span></span><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m5 6 3 3 3-3"/></svg></button><div class="picker-popover" hidden><div class="picker-list" role="listbox"></div></div>';
    select.after(root);const trigger=root.querySelector('button'),panel=root.querySelector('.picker-popover'),list=root.querySelector('.picker-list');
    const sync=()=>{trigger.querySelector('span').textContent=select.selectedOptions[0]?.textContent||'选择';trigger.disabled=select.disabled;};sync();
    const close=()=>{panel.hidden=true;trigger.setAttribute('aria-expanded','false');};
    trigger.onclick=()=>{if(!panel.hidden)return close();list.replaceChildren();for(const option of select.options){const button=document.createElement('button');button.type='button';button.className='picker-option';button.textContent=option.textContent;button.setAttribute('role','option');button.setAttribute('aria-selected',String(option.selected));button.disabled=option.disabled;button.onclick=()=>{select.value=option.value;select.dispatchEvent(new Event('change',{bubbles:true}));sync();close();trigger.focus();};list.append(button);}panel.hidden=false;trigger.setAttribute('aria-expanded','true');list.querySelector('[aria-selected="true"]')?.focus();};
    root.addEventListener('focusout',e=>{if(!root.contains(e.relatedTarget))close();});
    root.onkeydown=e=>{if(e.key==='Escape'){close();trigger.focus();e.stopPropagation();}if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();if(panel.hidden)return trigger.click();const options=[...list.querySelectorAll('button:not(:disabled)')],i=options.indexOf(document.activeElement);options[e.key==='Home'?0:e.key==='End'?options.length-1:(i+(e.key==='ArrowDown'?1:-1)+options.length)%options.length]?.focus();}};
  }
}
