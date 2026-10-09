import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { DatabaseSync } from 'node:sqlite';
import { config, loadFileConfig } from '../config.ts';
import { conflict, invalid } from '../http.ts';
import { audit } from '../audit.ts';
import type { AuthUser } from '../security.ts';
import { writeFileAtomic } from './files.ts';

// File format: magic | salt(16) | iv(12) | tag(16) | ciphertext. AES-256-GCM, key from scrypt(passphrase).
// LMSBAK1 holds the bare database; LMSBAK2 holds a gzip archive of the database plus data/files
// (issued report PDFs, result attachments, branding images).
const MAGIC = Buffer.from('LMSBAK2');
const MAGIC_V1 = Buffer.from('LMSBAK1');
const BACKED_UP_DIRS = ['reports', 'attachments', 'branding'];

// Archive entry: pathLen(u16) | path (utf8, forward slashes) | size(u32) | bytes.
// ponytail: built in memory, fine for one lab's files; stream if the folder ever reaches GBs.
export function packArchive(entries: Array<{ path: string; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const p = Buffer.from(e.path, 'utf8');
    const head = Buffer.alloc(2);
    head.writeUInt16BE(p.length);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(e.data.length);
    parts.push(head, p, size, e.data);
  }
  return gzipSync(Buffer.concat(parts));
}

export function unpackArchive(packed: Buffer): Array<{ path: string; data: Buffer }> {
  const buf = gunzipSync(packed);
  const out: Array<{ path: string; data: Buffer }> = [];
  let o = 0;
  while (o < buf.length) {
    const pl = buf.readUInt16BE(o);
    const path = buf.subarray(o + 2, o + 2 + pl).toString('utf8');
    const size = buf.readUInt32BE(o + 2 + pl);
    const start = o + 6 + pl;
    out.push({ path, data: buf.subarray(start, start + size) });
    o = start + size;
  }
  return out;
}

function collectFiles(): Array<{ path: string; data: Buffer }> {
  const out: Array<{ path: string; data: Buffer }> = [];
  const filesRoot = dirname(config.reportsDir);
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else out.push({ path: 'files/' + relative(filesRoot, full).split(sep).join('/'), data: readFileSync(full) });
    }
  };
  for (const d of BACKED_UP_DIRS) walk(join(filesRoot, d));
  return out;
}

// Writes the archive's files under data/files, refusing any path that escapes it. Returns the database bytes.
export function restoreArchive(plain: Buffer, isV1: boolean): { db: Buffer; files: number } {
  if (isV1) return { db: plain, files: 0 };
  const filesRoot = resolve(dirname(config.reportsDir));
  let db: Buffer | null = null;
  let files = 0;
  for (const e of unpackArchive(plain)) {
    if (e.path === 'lms.db') {
      db = e.data;
      continue;
    }
    const target = resolve(filesRoot, e.path.slice('files/'.length));
    if (!target.startsWith(filesRoot + sep)) throw invalid('Backup contains an unsafe file path');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, e.data);
    files++;
  }
  if (!db) throw invalid('Backup does not contain a database');
  return { db, files };
}

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

export const isV1Backup = (data: Buffer): boolean => data.subarray(0, MAGIC_V1.length).equals(MAGIC_V1);

export function decryptBuffer(data: Buffer, passphrase: string): Buffer {
  const head = data.subarray(0, MAGIC.length);
  if (!head.equals(MAGIC) && !head.equals(MAGIC_V1)) throw invalid('Not an Amna Lab backup file');
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
  const dbBytes = readFileSync(tmp);
  unlinkSync(tmp);
  const encrypted = encryptBuffer(packArchive([{ path: 'lms.db', data: dbBytes }, ...collectFiles()]), passphrase);
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
