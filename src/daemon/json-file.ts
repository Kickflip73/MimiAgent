import { randomUUID } from 'node:crypto';
import { access, chmod, link, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

export async function pathExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function writeTemporaryJson(file: string, value: unknown): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(file), 0o700);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  return temporary;
}

export async function writeExclusiveJson(file: string, value: unknown): Promise<boolean> {
  const temporary = await writeTemporaryJson(file, value);
  try {
    await link(temporary, file);
    await chmod(file, 0o600);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function writeAtomicJson(file: string, value: unknown): Promise<void> {
  const temporary = await writeTemporaryJson(file, value);
  try {
    await rename(temporary, file);
    await chmod(file, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}
