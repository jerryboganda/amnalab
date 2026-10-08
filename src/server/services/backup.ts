import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { readFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { config, loadFileConfig } from '../config.ts';
import { conflict, invalid } from '../http.ts';
import { audit } from '../audit.ts';
import type { AuthUser } from '../security.ts';
import { writeFileAtomic } from './files.ts';

// File format: "LMSBAK1" | salt(16) | iv(12) | tag(16) | ciphertext. AES-256-GCM, key from scrypt(passphrase).
const MAGIC = Buffer.from('LMSBAK1');

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
}

export function encryptBuffer(plain: Buffer, passphrase: string): Buffer {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), body]);
}

export function decryptBuffer(data: Buffer, passphrase: string): Buffer {
  if (!data.subarray(0, MAGIC.length).equals(MAGIC)) throw invalid('Not an Amna Lab backup file');
  let offset = MAGIC.length;
  const salt = data.subarray(offset, (offset += 16));
  const iv = data.subarray(offset, (offset += 12));
  const tag = data.subarray(offset, (offset += 16));
  const body = data.subarray(offset);
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw invalid('Backup passphrase is wrong or the file is damaged');
  }
}

export function requirePassphrase(): string {
  const pass = loadFileConfig().backup?.passphrase;
  if (!pass || pass.length < 12) {
    throw conflict('Set backup.passphrase (12+ characters) in data/config.json before creating backups');
  }
  return pass;
}

export function createBackup(db: DatabaseSync, kind: 'auto' | 'manual', actor: AuthUser | null) {
  const passphrase = requirePassphrase();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const tmp = join(config.backupsDir, `tmp-${stamp}.db`);
  // VACUUM INTO gives a consistent snapshot even while the app is writing (WAL mode).
  db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  const plain = readFileSync(tmp);
  unlinkSync(tmp);
  const encrypted = encryptBuffer(plain, passphrase);
  const file = join(config.backupsDir, `lms-${stamp}.lmsbak`);
  writeFileAtomic(file, encrypted);
  const sha256 = createHash('sha256').update(encrypted).digest('hex');
  const row = db
    .prepare('INSERT INTO backups (file, size, sha256, kind, created_by) VALUES (?, ?, ?, ?, ?) RETURNING id, created_at')
    .get(file, encrypted.length, sha256, kind, actor?.id ?? null) as { id: number; created_at: string };
  audit(db, { actor, action: `backup.${kind}`, entity: 'backup', entityId: row.id, after: { file, size: encrypted.length } });
  return { id: row.id, file, size: encrypted.length, sha256, createdAt: row.created_at };
}

export function listBackups(db: DatabaseSync) {
  return db.prepare('SELECT id, file, size, sha256, kind, created_at FROM backups ORDER BY id DESC LIMIT 100').all();
}

// Runs once a day at the configured hour, if no automatic backup exists for today.
export function maybeAutoBackup(db: DatabaseSync): void {
  const hour = loadFileConfig().backup?.hour ?? 2;
  const now = new Date();
  if (now.getHours() !== hour) return;
  const today = now.toISOString().slice(0, 10);
  const done = db
    .prepare("SELECT id FROM backups WHERE kind = 'auto' AND substr(created_at, 1, 10) = ? LIMIT 1")
    .get(today);
  if (done) return;
  try {
    createBackup(db, 'auto', null);
  } catch (err) {
    console.error('Automatic backup failed:', (err as Error).message);
  }
}

export function backupFileSize(file: string): number {
  return statSync(file).size;
}
