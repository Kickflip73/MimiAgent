/** Unsent browser drafts, scoped to this tab. Accepted work is owned by the daemon. */
export function createMessageQueue({ storage, submit, isRunning, interrupt, accepted, changed, uuid }) {
  let items = [];
  try { const saved = JSON.parse(storage.getItem('mimi-message-queue') || '[]'); if (Array.isArray(saved)) items = saved; } catch { /* Empty cache. */ }
  // A reload during submission has an uncertain receipt. Never allocate a new ID.
  for (const item of items) {
    if (item.state === 'sending') item.state = 'failed';
    if (item.state === 'interrupting') item.state = 'queued';
  }
  const busy = new Set(), probing = new Set();
  const persist = () => { storage.setItem('mimi-message-queue', JSON.stringify(items)); changed(); };
  async function observe(item) {
    try {
      await accepted(item, item.receipt);
      items = items.filter(candidate => candidate.id !== item.id);
    } catch {
      // The daemon already accepted this exact request. Retry only observation.
      item.error = '已发送，正在恢复显示';
    }
    persist();
  }
  return {
    list: (session) => items.filter(item => item.session === session),
    sessions: () => [...new Set(items.map(item => item.session))],
    add(session, input, security) {
      const item = { id: uuid(), session, input, security, state: 'queued', createdAt: new Date().toISOString() };
      items.push(item); persist(); return item;
    },
    edit(id, input) { const item = items.find(i => i.id === id); if (item?.state === 'queued' && input.trim()) { item.input = input.trim(); item.error = undefined; persist(); } },
    cancel(id) { items = items.filter(i => i.id !== id || i.state !== 'queued'); persist(); },
    async drain(session, immediateId) {
      if (busy.has(session) || (!immediateId && probing.has(session))) return;
      const item = immediateId ? items.find(i => i.id === immediateId && i.session === session) : items.find(i => i.session === session);
      if (!item || (item.state === 'failed' && !immediateId)) return;
      let ownsLock = false;
      const retrySubmission = item.state === 'failed';
      try {
        if (item.state === 'accepted') {
          busy.add(session); ownsLock = true; await observe(item); return;
        }
        // A slow background status probe must not prevent an explicit send now.
        if (immediateId) { busy.add(session); ownsLock = true; item.state = 'interrupting'; item.error = undefined; persist(); }
        else probing.add(session);
        const running = retrySubmission ? null : await isRunning(session, { immediate: !!immediateId });
        if (!immediateId) {
          if (running || busy.has(session) || !items.includes(item)) return;
          busy.add(session); ownsLock = true;
        }
        if (running) await interrupt(session, running);
        item.state = 'sending'; item.error = undefined; persist();
        const result = await submit(item);
        if (!result?.eventId) throw new Error('未收到发送回执，请重试确认');
        item.receipt = result; item.state = 'accepted'; item.error = undefined; persist();
        await observe(item);
      } catch (error) {
        if (!items.includes(item)) return;
        // A failed submission can have reached the server: retry with the same ID only.
        item.state = item.state === 'sending' ? 'failed' : item.state === 'accepted' ? 'accepted' : 'queued';
        item.error = error.message; persist();
      } finally {
        if (ownsLock) busy.delete(session);
        if (!immediateId) probing.delete(session);
      }
    },
  };
}
