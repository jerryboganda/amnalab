// Restore an encrypted backup. Stop the app first (close the LMS tray icon), then run:
//   node dist/server/restore.js backups/lms-<stamp>.lmsbak
// The current database is moved to backups/pre-restore-<stamp>.db, so nothing is lost.
import { copyFileSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config, loadFileConfig } from '../config.ts';
import { decryptBuffer, isV1Backup, restoreArchive } from '../services/backup.ts';

const file = process.argv[2];
if (!file || !existsSync(file)) {
  console.error('Usage: node dist/server/restore.js <backup-file.lmsbak>');
  process.exit(1);
}

const passphrase = loadFileConfig().backup?.passphrase;
if (!passphrase) {
  console.error('backup.passphrase is missing from data/config.json');
  process.exit(1);
}

const raw = readFileSync(file);
let plain: Buffer;
try {
  plain = decryptBuffer(raw, passphrase);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

if (existsSync(config.dbFile)) {
  const keep = join(config.backupsDir, `pre-restore-${stamp}.db`);
  renameSync(config.dbFile, keep);
  for (const side of ['-wal', '-shm']) {
    const path = `${config.dbFile}${side}`;
    if (existsSync(path)) {
      copyFileSync(path, `${keep}${side}`);
      unlinkSync(path);
    }
  }
  console.log(`Current database kept at ${keep}`);
}

let restored: { db: Buffer; files: number };
try {
  restored = restoreArchive(plain, isV1Backup(raw));
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
writeFileSync(config.dbFile, restored.db);

// Stored file paths are absolute; point them at this machine's data/files folder.
const filesDir = dirname(config.reportsDir);
const db = new DatabaseSync(config.dbFile);
const rebase = (table: string, col: string) => {
  const rows = db.prepare(`SELECT rowid AS id, ${col} AS p FROM ${table} WHERE ${col} IS NOT NULL`).all() as Array<{ id: number; p: string }>;
  for (const r of rows) {
    const norm = r.p.split(String.fromCharCode(92)).join('/');
    const at = norm.lastIndexOf('/files/');
    if (at >= 0) db.prepare(`UPDATE ${table} SET ${col} = ? WHERE rowid = ?`).run(join(filesDir, ...norm.slice(at + 7).split('/')), r.id);
  }
};
// Triggers only guard audit tables; none of these tables are append-only.
for (const [t, c] of [['branches', 'logo_path'], ['branches', 'background_path'], ['attachments', 'path'], ['reports', 'pdf_path'], ['outbox', 'attachment_path']] as const) rebase(t, c);
db.close();
console.log(`Restored ${file} (${restored.files} attached/report/branding files). Start the LMS again.`);
