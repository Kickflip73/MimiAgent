import { cpSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Copies the web UI static assets next to the compiled server module so that
// src/web/server.ts can resolve them via new URL('./assets/...', import.meta.url).
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(projectRoot, 'src', 'web', 'assets');
const target = path.join(projectRoot, 'dist', 'web', 'assets');

if (!existsSync(source)) {
  console.error(`copy-web-assets: source assets missing at ${source}`);
  process.exit(1);
}

cpSync(source, target, { recursive: true });
console.log(`copy-web-assets: ${source} -> ${target}`);
