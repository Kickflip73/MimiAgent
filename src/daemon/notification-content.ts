/** Outbox remains the source of truth; native banners are only previews. */
export function notificationText(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (payload && typeof payload === 'object') {
    const value = payload as Record<string, unknown>;
    if (typeof value.text === 'string') return value.text;
  }
  return JSON.stringify(payload) ?? '';
}

export function notificationUrl(origin: string, id: string): string {
  const url = new URL(origin);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) {
    throw new Error('通知只能打开本机 Mimi Web');
  }
  url.pathname = '/'; url.search = ''; url.hash = '';
  url.searchParams.set('notification', id);
  return url.href;
}
