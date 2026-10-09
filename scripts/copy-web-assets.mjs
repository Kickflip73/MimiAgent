import { cp } from 'node:fs/promises';

await cp(new URL('../src/web/assets/', import.meta.url), new URL('../dist/web/assets/', import.meta.url), { recursive: true });
