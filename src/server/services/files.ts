import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { config } from '../config.ts';
import { badRequest, invalid } from '../http.ts';

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export function ensureDirs(): void {
  for (const dir of [
    config.reportsDir,
    config.outboxDir,
    config.attachmentsDir,
    config.brandingDir,
    config.backupsDir,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}

// Decodes a data URL and checks the real file signature, not just the declared type.
export function decodeDataUrl(dataUrl: string, allowed: 'image' | 'any', maxBytes: number): { mime: string; buffer: Buffer } {
  const m = /^data:([a-z0-9.+/-]+);base64,(.+)$/i.exec(dataUrl);
  if (!m) throw badRequest('Expected a base64 data URL');
  const buffer = Buffer.from(m[2]!, 'base64');
  if (buffer.length === 0) throw badRequest('File is empty');
  if (buffer.length > maxBytes) throw invalid(`File is larger than ${Math.round(maxBytes / 1048576)} MB`);
  const mime = m[1]!.toLowerCase();
  const isPng = buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const isPdf = buffer.subarray(0, 4).toString('latin1') === '%PDF';
  if (allowed === 'image') {
    if (!(isPng || isJpeg)) throw invalid('Only PNG or JPEG images are allowed');
    return { mime: isPng ? 'image/png' : 'image/jpeg', buffer };
  }
  if (isPng) return { mime: 'image/png', buffer };
  if (isJpeg) return { mime: 'image/jpeg', buffer };
  if (isPdf) return { mime: 'application/pdf', buffer };
  throw invalid('Only PNG, JPEG or PDF files are allowed');
}

export function saveBrandingImage(branchId: number, kind: 'logo' | 'background' | 'incharge-signature', dataUrl: string): string {
  const { mime, buffer } = decodeDataUrl(dataUrl, 'image', MAX_IMAGE_BYTES);
  const ext = mime === 'image/png' ? 'png' : 'jpg';
  const path = join(config.brandingDir, `branch-${branchId}-${kind}.${ext}`);
  writeFileSync(path, buffer);
  return path;
}

// Scanned signature of a staff member, printed on reports they authorize.
export function saveUserSignature(userId: number, dataUrl: string): string {
  const { mime, buffer } = decodeDataUrl(dataUrl, 'image', MAX_IMAGE_BYTES);
  const path = join(config.brandingDir, `user-${userId}-signature.${mime === 'image/png' ? 'png' : 'jpg'}`);
  writeFileSync(path, buffer);
  return path;
}

export function saveAttachment(orderItemId: number, dataUrl: string, filename: string): { path: string; mime: string; size: number } {
  const { mime, buffer } = decodeDataUrl(dataUrl, 'any', MAX_ATTACHMENT_BYTES);
  const hash = createHash('sha256').update(buffer).digest('hex').slice(0, 16);
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  const path = join(config.attachmentsDir, `item-${orderItemId}-${hash}-${safeName}`);
  writeFileSync(path, buffer);
  return { path, mime, size: buffer.length };
}

// Writes via a temp file and renames, so a crash never leaves a half-written PDF.
export function writeFileAtomic(path: string, data: Buffer): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

export function readIfExists(path: string | null | undefined): Buffer | null {
  if (!path || !existsSync(path)) return null;
  return readFileSync(path);
}

export function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
