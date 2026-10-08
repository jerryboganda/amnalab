// Restore an encrypted backup. Stop the app first (close the LMS tray icon), then run:
//   node dist/server/restore.js backups/lms-<stamp>.lmsbak
// The current database is moved to backups/pre-restore-<stamp>.db, so nothing is lost.
import { copyFileSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config, loadFileConfig } from '../config.ts';
import { decryptBuffer } from '../services/backup.ts';

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

const plain = decryptBuffer(readFileSync(file), passphrase);
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

writeFileSync(config.dbFile, plain);
console.log(`Restored ${file}. Start the LMS again.`);
