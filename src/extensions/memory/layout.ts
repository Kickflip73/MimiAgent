import { access, cp, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { stableDirectoryId } from '../../core/memory.js';
import { withExclusiveFileLock } from '../../core/state-file.js';

export interface PrivateMemoryLayout {
  vaultRoot: string;
  wikiRoot: string;
  rawRoot: string;
  schemaFile: string;
  stateRoot: string;
  databaseFile: string;
  legacyRoot: string;
  backupRoot: string;
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function moveIfPresent(source: string, target: string): Promise<void> {
  if (!await exists(source)) return;
  if (await exists(target)) return;
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await rename(source, target);
}

export function privateMemoryLayout(dataRoot: string, profileId: string): PrivateMemoryLayout {
  const memoryRoot = path.join(path.resolve(dataRoot), 'memory');
  const profileKey = stableDirectoryId(profileId);
  const vaultRoot = profileId === 'owner'
    ? path.join(memoryRoot, 'vaults', 'owner')
    : path.join(memoryRoot, 'vaults', 'profiles', profileKey);
  const stateRoot = path.join(memoryRoot, 'state', 'profiles', profileKey);
  return {
    vaultRoot,
    wikiRoot: path.join(vaultRoot, 'wiki'),
    rawRoot: path.join(vaultRoot, 'raw'),
    schemaFile: path.join(vaultRoot, 'WIKI.md'),
    stateRoot,
    databaseFile: path.join(stateRoot, 'memory.db'),
    legacyRoot: path.join(memoryRoot, 'profiles', profileKey),
    backupRoot: path.join(memoryRoot, 'backups', 'layout-v2', profileKey),
  };
}

export async function preparePrivateMemoryLayout(
  dataRoot: string,
  profileId: string,
): Promise<PrivateMemoryLayout> {
  const layout = privateMemoryLayout(dataRoot, profileId);
  const memoryRoot = path.join(path.resolve(dataRoot), 'memory');
  await mkdir(memoryRoot, { recursive: true, mode: 0o700 });
  await withExclusiveFileLock(path.join(memoryRoot, '.layout-v2'), async () => {
    const legacyExists = await exists(layout.legacyRoot);
    if (legacyExists && !await exists(layout.backupRoot)) {
      await mkdir(path.dirname(layout.backupRoot), { recursive: true, mode: 0o700 });
      await cp(layout.legacyRoot, layout.backupRoot, {
        recursive: true,
        errorOnExist: true,
        force: false,
        preserveTimestamps: true,
      });
    }
    if (legacyExists) {
      await moveIfPresent(path.join(layout.legacyRoot, 'wiki'), layout.wikiRoot);
      await moveIfPresent(path.join(layout.wikiRoot, 'WIKI.md'), layout.schemaFile);
      await moveIfPresent(path.join(layout.legacyRoot, '.obsidian'), path.join(layout.vaultRoot, '.obsidian'));
      for (const suffix of ['', '-wal', '-shm']) {
        await moveIfPresent(
          path.join(layout.legacyRoot, `memory.db${suffix}`),
          `${layout.databaseFile}${suffix}`,
        );
      }
    }
    await mkdir(layout.wikiRoot, { recursive: true, mode: 0o700 });
    await mkdir(layout.stateRoot, { recursive: true, mode: 0o700 });
    for (const directory of ['user', 'sessions', 'events', 'tools']) {
      await mkdir(path.join(layout.rawRoot, directory), { recursive: true, mode: 0o700 });
    }
  });
  return layout;
}
