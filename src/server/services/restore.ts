// Putting a backup back. Used by the restore tool (command line) and by the in-app "Restore" button.
// The in-app route cannot swap the database while the server has it open, so it leaves the decrypted backup in
// data/ and restarts the server; applyPendingRestore() then runs first thing at start-up.
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.ts';
import { isV1Backup, restoreArchive } from './backup.ts';

const pendingFile = () => join(dirname(config.dbFile), 'pending-restore.bin');
const pendingKind = () => join(dirname(config.dbFile), 'pending-restore.kind');

// Replaces the database with the one in the backup (keeping the old one in backups/) and unpacks the files.
export function installBackup(plain: Buffer, v1: boolean): { files: number; kept: string | null } {
  // Validates the archive and writes the report/attachment/branding files; throws before the database is touched.
  const restored = restoreArchive(plain, v1);
  mkdirSync(config.backupsDir, { recursive: true });
  let kept: string | null = null;
  if (existsSync(config.dbFile)) {
    kept = join(config.backupsDir, `pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
    renameSync(config.dbFile, kept);
    for (const side of ['-wal', '-shm']) {
      const path = `${config.dbFile}${side}`;
      if (existsSync(path)) {
        copyFileSync(path, `${kept}${side}`);
        unlinkSync(path);
      }
    }
  }
  writeFileSync(config.dbFile, restored.db);

  // Stored file paths are absolute; point them at this machine's data/files folder.
  const filesDir = dirname(config.reportsDir);
  const db = new DatabaseSync(config.dbFile);
  const rebase = (table: string, col: string) => {
    let rows: Array<{ id: number; p: string }>;
    try {
      rows = db.prepare(`SELECT rowid AS id, ${col} AS p FROM ${table} WHERE ${col} IS NOT NULL`).all() as Array<{ id: number; p: string }>;
    } catch {
      return; // an older backup without this column; the app adds it on start
    }
    for (const r of rows) {
      const norm = r.p.split(String.fromCharCode(92)).join('/');
      const at = norm.lastIndexOf('/files/');
      if (at >= 0) db.prepare(`UPDATE ${table} SET ${col} = ? WHERE rowid = ?`).run(join(filesDir, ...norm.slice(at + 7).split('/')), r.id);
    }
  };
  // Triggers only guard audit tables; none of these tables are append-only.
  for (const [t, c] of [['branches', 'logo_path'], ['branches', 'background_path'], ['attachments', 'path'], ['reports', 'pdf_path'], ['reports', 'print_pdf_path'], ['outbox', 'attachment_path'], ['users', 'signature_path'], ['branches', 'incharge_signature_path']] as const) rebase(t, c);
  db.close();
  return { files: restored.files, kept };
}

// In-app restore, step 1 (server running): park the decrypted backup for the next start.
export function schedulePendingRestore(plain: Buffer, v1: boolean): void {
  writeFileSync(pendingFile(), plain);
  writeFileSync(pendingKind(), v1 ? 'v1' : 'v2');
}

// In-app restore, step 2 (start-up, before the database is opened).
export function applyPendingRestore(): void {
  if (!existsSync(pendingFile())) return;
  try {
    const plain = readFileSync(pendingFile());
    const v1 = existsSync(pendingKind()) && readFileSync(pendingKind(), 'utf8').trim() === 'v1';
    const out = installBackup(plain, v1);
    console.log(`Backup restored (${out.files} files). The previous database was kept at ${out.kept ?? '(none)'}`);
  } catch (err) {
    console.error('Restore failed, the current data was left as it was:', (err as Error).message);
  } finally {
    for (const f of [pendingFile(), pendingKind()]) {
      try {
        unlinkSync(f);
      } catch {
        /* already gone */
      }
    }
  }
}

export { isV1Backup };
