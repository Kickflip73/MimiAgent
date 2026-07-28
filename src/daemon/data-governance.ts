import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  sanitizeSensitiveData,
  sanitizeSensitiveText,
  scanSensitiveData,
  type SensitiveDataCategory,
} from '../core/data-sanitizer.js';
import { verifyMimiBackup } from './backup.js';

const GOVERNANCE_SCHEMA_VERSION = 1;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FINGERPRINTS = 100;
const DATA_FILES = ['plans.json', 'teams.json', 'execution-ledger.json'] as const;
const DATA_DIRECTORIES = ['traces', 'memory'] as const;

interface DatabaseTarget {
  table: string;
  columns: readonly string[];
}

const DATABASE_TARGETS: readonly DatabaseTarget[] = [
  { table: 'tasks', columns: ['objective_json', 'result_json', 'error'] },
  { table: 'runs', columns: ['answer_json', 'error'] },
  { table: 'memory_observations', columns: ['evidence_snapshot_json'] },
  { table: 'schedules', columns: ['name', 'prompt'] },
];

export interface SensitiveSurfaceCount {
  surface: string;
  category: SensitiveDataCategory;
  count: number;
}

export interface SensitiveHistoryReport {
  schemaVersion: 1;
  mode: 'dry_run' | 'verified';
  scannedAt: string;
  valuesScanned: number;
  findings: number;
  counts: SensitiveSurfaceCount[];
  fingerprints: string[];
  rawValuesIncluded: false;
}

export interface SensitiveHistoryMigrationResult {
  schemaVersion: 1;
  status: 'applied';
  backupFingerprint: string;
  databaseValuesChanged: number;
  filesChanged: number;
  originalsPreservedInBackup: true;
  verification: SensitiveHistoryReport;
}

interface FindingAccumulator {
  valuesScanned: number;
  counts: Map<string, SensitiveSurfaceCount>;
  fingerprints: Set<string>;
}

function accumulator(): FindingAccumulator {
  return { valuesScanned: 0, counts: new Map(), fingerprints: new Set() };
}

function addValue(
  target: FindingAccumulator,
  surface: string,
  value: unknown,
  preserveContacts = false,
): void {
  target.valuesScanned += 1;
  for (const finding of scanSensitiveData(value, { preserveContacts })) {
    const key = `${surface}\u0000${finding.category}`;
    const current = target.counts.get(key);
    if (current) current.count += 1;
    else target.counts.set(key, { surface, category: finding.category, count: 1 });
    if (target.fingerprints.size < MAX_FINGERPRINTS) target.fingerprints.add(finding.fingerprint);
  }
}

function report(target: FindingAccumulator, mode: SensitiveHistoryReport['mode']): SensitiveHistoryReport {
  const counts = [...target.counts.values()].sort((left, right) =>
    left.surface.localeCompare(right.surface) || left.category.localeCompare(right.category));
  return {
    schemaVersion: GOVERNANCE_SCHEMA_VERSION,
    mode,
    scannedAt: new Date().toISOString(),
    valuesScanned: target.valuesScanned,
    findings: counts.reduce((total, item) => total + item.count, 0),
    counts,
    fingerprints: [...target.fingerprints].sort(),
    rawValuesIncluded: false,
  };
}

function tableColumns(database: DatabaseSync, table: string): Set<string> {
  const rows = database.prepare(`PRAGMA table_info("${table.replaceAll('"', '""')}")`).all() as Array<{
    name?: string;
  }>;
  return new Set(rows.flatMap((row) => typeof row.name === 'string' ? [row.name] : []));
}

function scanDatabase(databaseFile: string, target: FindingAccumulator): void {
  if (!existsSync(databaseFile)) return;
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    for (const spec of DATABASE_TARGETS) {
      const available = tableColumns(database, spec.table);
      const columns = spec.columns.filter((column) => available.has(column));
      if (!columns.length) continue;
      const selected = columns.map((column) => `"${column}"`).join(', ');
      const rows = database.prepare(`SELECT ${selected} FROM "${spec.table}"`).all() as Array<Record<string, unknown>>;
      for (const row of rows) {
        for (const column of columns) {
          const value = row[column];
          if (typeof value !== 'string' || !value) continue;
          let parsed: unknown = value;
          if (column.endsWith('_json')) {
            try {
              parsed = JSON.parse(value) as unknown;
            } catch {
              // Corrupt legacy JSON is still scanned as bounded text; migration does not repair its shape.
            }
          }
          addValue(target, `database:${spec.table}.${column}`, parsed);
        }
      }
    }
  } finally {
    database.close();
  }
}

async function dataFiles(dataRoot: string): Promise<string[]> {
  const files = DATA_FILES.map((name) => path.join(dataRoot, name));
  const visit = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile() && ['.json', '.jsonl', '.md'].includes(path.extname(entry.name).toLowerCase())) {
        files.push(candidate);
      }
    }
  };
  for (const directory of DATA_DIRECTORIES) await visit(path.join(dataRoot, directory));
  return files;
}

async function scanFiles(dataRoot: string, target: FindingAccumulator): Promise<void> {
  for (const file of await dataFiles(dataRoot)) {
    let info;
    try {
      info = await lstat(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) continue;
    const source = await readFile(file, 'utf8');
    let value: unknown = source;
    if (path.extname(file).toLowerCase() === '.json') {
      try {
        value = JSON.parse(source) as unknown;
      } catch {
        // Preserve corrupt historical JSON and scan it as text.
      }
    }
    const relative = path.relative(dataRoot, file).split(path.sep).join('/');
    addValue(target, `file:${relative}`, value, relative.startsWith('memory/owner/'));
  }
}

export async function scanSensitiveHistory(options: {
  dataRoot: string;
  databaseFile: string;
  mode?: SensitiveHistoryReport['mode'];
}): Promise<SensitiveHistoryReport> {
  const target = accumulator();
  scanDatabase(path.resolve(options.databaseFile), target);
  await scanFiles(path.resolve(options.dataRoot), target);
  return report(target, options.mode ?? 'dry_run');
}

function sanitizeStoredValue(column: string, value: string): string {
  if (column.endsWith('_json')) {
    try {
      return JSON.stringify(sanitizeSensitiveData(JSON.parse(value) as unknown));
    } catch {
      return sanitizeSensitiveText(value) ?? '';
    }
  }
  return sanitizeSensitiveText(value) ?? '';
}

function migrateDatabase(databaseFile: string): number {
  if (!existsSync(databaseFile)) return 0;
  const database = new DatabaseSync(databaseFile);
  let changed = 0;
  try {
    database.exec('BEGIN IMMEDIATE');
    for (const spec of DATABASE_TARGETS) {
      const available = tableColumns(database, spec.table);
      const columns = spec.columns.filter((column) => available.has(column));
      if (!columns.length) continue;
      const selected = columns.map((column) => `"${column}"`).join(', ');
      const rows = database.prepare(`SELECT rowid AS "_rowid", ${selected} FROM "${spec.table}"`).all() as Array<
        Record<string, unknown>
      >;
      for (const row of rows) {
        const rowid = row._rowid;
        if (typeof rowid !== 'number' && typeof rowid !== 'bigint') continue;
        const updates: Array<{ column: string; value: string }> = [];
        for (const column of columns) {
          const value = row[column];
          if (typeof value !== 'string' || !value) continue;
          const sanitized = sanitizeStoredValue(column, value);
          if (sanitized !== value) updates.push({ column, value: sanitized });
        }
        if (!updates.length) continue;
        const assignment = updates.map((item) => `"${item.column}" = ?`).join(', ');
        database.prepare(`UPDATE "${spec.table}" SET ${assignment} WHERE rowid = ?`).run(
          ...updates.map((item) => item.value),
          rowid,
        );
        changed += updates.length;
      }
    }
    database.exec('COMMIT');
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // The original failure remains authoritative.
    }
    throw error;
  } finally {
    database.close();
  }
  return changed;
}

async function migrateFiles(dataRoot: string): Promise<number> {
  let changed = 0;
  for (const file of await dataFiles(dataRoot)) {
    let info;
    try {
      info = await lstat(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) continue;
    const source = await readFile(file, 'utf8');
    const relative = path.relative(dataRoot, file).split(path.sep).join('/');
    const sanitization = { preserveContacts: relative.startsWith('memory/owner/') };
    let sanitized: string;
    if (path.extname(file).toLowerCase() === '.json') {
      try {
        sanitized = `${JSON.stringify(sanitizeSensitiveData(JSON.parse(source) as unknown, sanitization), null, 2)}\n`;
      } catch {
        sanitized = sanitizeSensitiveText(source, sanitization) ?? '';
      }
    } else {
      sanitized = sanitizeSensitiveText(source, sanitization) ?? '';
    }
    if (sanitized === source) continue;
    const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(temporary, sanitized, { encoding: 'utf8', mode: info.mode & 0o777 });
    await rename(temporary, file);
    changed += 1;
  }
  return changed;
}

export async function migrateSensitiveHistory(options: {
  dataRoot: string;
  databaseFile: string;
  daemonSocket: string;
  backupDirectory: string;
}): Promise<SensitiveHistoryMigrationResult> {
  if (existsSync(options.daemonSocket)) {
    throw new Error('历史净化 apply 要求 Daemon 已停止；先完成可恢复备份和 dry-run');
  }
  const backup = await verifyMimiBackup(options.backupDirectory);
  const backupFingerprint = createHash('sha256')
    .update(JSON.stringify(backup.manifest))
    .digest('hex');
  const databaseValuesChanged = migrateDatabase(path.resolve(options.databaseFile));
  const filesChanged = await migrateFiles(path.resolve(options.dataRoot));
  const verification = await scanSensitiveHistory({
    dataRoot: options.dataRoot,
    databaseFile: options.databaseFile,
    mode: 'verified',
  });
  if (verification.findings !== 0) {
    throw new Error(`历史净化后仍有 ${verification.findings} 个未处置命中；使用已验证备份恢复`);
  }
  return {
    schemaVersion: GOVERNANCE_SCHEMA_VERSION,
    status: 'applied',
    backupFingerprint,
    databaseValuesChanged,
    filesChanged,
    originalsPreservedInBackup: true,
    verification,
  };
}
