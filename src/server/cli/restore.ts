// Restore an encrypted backup from the command line. Stop the app first (close the LMS tray icon), then run:
//   node dist/server/restore.js backups/lms-<stamp>.lmsbak
// The current database is moved to backups/pre-restore-<stamp>.db, so nothing is lost.
// (The same thing is one click inside the program: Admin, Backup & health, Restore.)
import { existsSync, readFileSync } from 'node:fs';
import { loadFileConfig } from '../config.ts';
import { decryptBuffer, isV1Backup } from '../services/backup.ts';
import { installBackup } from '../services/restore.ts';

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

try {
  const raw = readFileSync(file);
  const out = installBackup(decryptBuffer(raw, passphrase), isV1Backup(raw));
  if (out.kept) console.log(`Current database kept at ${out.kept}`);
  console.log(`Restored ${file} (${out.files} attached/report/branding files). Start the LMS again.`);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
