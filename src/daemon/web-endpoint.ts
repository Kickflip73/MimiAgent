import path from 'node:path';
import { z } from 'zod';
import { AtomicJsonStore } from '../core/state-file.js';
import { notificationUrl } from './notification-content.js';

const schema = z.object({ origin: z.string(), pid: z.number().int().positive() }).nullable();
export function webEndpoint(root: string) {
  return new AtomicJsonStore(path.join(root, 'web-endpoint.json'), {
    defaultValue: () => null as z.infer<typeof schema>,
    decode: value => { const result = schema.parse(value); if(result) notificationUrl(result.origin, 'validate'); return result; },
    recoverCorrupt: false, preserveSchemaMismatch: true,
  });
}
export async function notificationOrigin(root?: string): Promise<string> {
  const endpoint = root ? await webEndpoint(root).read() : null;
  return endpoint?.origin ?? 'http://127.0.0.1:3210';
}
