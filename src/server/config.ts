import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Bundled to dist/server/index.js, so the project root is two levels up.
const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = process.env.LMS_ROOT ?? join(here, '..', '..');
const DATA = join(ROOT, 'data');
const FILES = join(DATA, 'files');

export const config = {
  version: '1.0.0',
  host: '127.0.0.1',
  port: Number(process.env.LMS_PORT ?? 8080),
  dbFile: process.env.LMS_DB_FILE ?? join(DATA, 'lms.db'),
  configFile: join(DATA, 'config.json'),
  reportsDir: join(FILES, 'reports'),
  outboxDir: join(FILES, 'outbox'),
  attachmentsDir: join(FILES, 'attachments'),
  brandingDir: join(FILES, 'branding'),
  backupsDir: join(ROOT, 'backups'),
  clientDir: join(ROOT, 'dist', 'client'),
  sessionCookie: 'lms_session',
  sessionIdleMinutes: 30,
  maxBodyBytes: 25 * 1024 * 1024,
};

// Local-only secrets and integration settings. Lives in data/ which is git-ignored.
export interface FileConfig {
  gmail?: { clientId: string; clientSecret: string; refreshToken: string; from: string };
  sms?: {
    url: string;
    method?: 'POST' | 'GET';
    headers?: Record<string, string>;
    // Placeholders: {to} {message}. Body is sent as JSON when it starts with '{'.
    bodyTemplate?: string;
    senderId?: string;
  };
  backup?: { passphrase: string; hour?: number };
  publicBaseUrl?: string;
}

export function loadFileConfig(): FileConfig {
  if (!existsSync(config.configFile)) return {};
  return JSON.parse(readFileSync(config.configFile, 'utf8')) as FileConfig;
}
