# Amna Lab LMS

Ultralight laboratory management system for one Windows PC. It runs locally, uses a single SQLite file, and needs no database server, Docker or browser engine.

- **Runtime:** Node.js 22.13+ (Node 24 recommended). Built-in `node:sqlite`, `node:http`, `node:crypto`.
- **UI:** React + Vite, served by the local server at `http://127.0.0.1:8080`.
- **Reports:** [pdfcn](https://github.com/shadcn-labs/pdfcn) components rendered with the Forme engine (WebAssembly, no browser).

## Install on the lab PC (one click)

1. Copy `AmnaLab-LMS-Setup-<version>.exe` to the lab PC (USB stick) and double-click it. Windows 10 or 11, 64-bit. Nothing else is needed: no Node.js, no internet.
2. If Windows shows "Windows protected your PC" (the file is not code-signed), choose **More info**, then **Run anyway**.
3. Setup copies the program to `C:\AmnaLabLMS` (about 115 MB), adds a desktop shortcut and a Start-menu entry, makes the LMS start with Windows, creates a random **backup password** and opens the app. **Write the backup password down**: it is shown once at the end and is needed to restore a backup on another PC.
4. The first screen creates the laboratory, its first branch and the administrator.

**Update:** just run the newer Setup file on top of the old one; there is no need to uninstall first. The program is replaced, the lab data, settings and backups are kept, and a copy of the database is saved under `backups\pre-update-...` first.
**Backup and restore:** both are one click under Admin, Backup & health. **Back up now** saves everything (database, reports, attachments, branding) as one encrypted file; **Download** copies it to a USB stick. **Restore** next to any backup (or **Restore from a file** for a file from another PC) puts that moment back: today's data is saved first, the program restarts by itself in a few seconds, and you sign in again.
**Remove:** Windows Settings, Apps, Amna Lab LMS (or Start menu, Uninstall). The lab data and backups stay in `C:\AmnaLabLMS` unless you tick the box to delete them.
**Unattended:** `Setup.exe /S` with optional `/dir=D:\Lab`, `/nodesktop`, `/nostartup`, `/nolaunch`; `Uninstall.exe /uninstall /S [/purge]`.

Build the installer on a Windows PC with `npm run installer` (needs Node 22+ and internet once; output in `installer\out`). Test an install end to end with `installer\test-installer.ps1`.

## Set up on the PC from source (developers)

```bash
npm install
npm run build
```

Create `data/config.json` (git-ignored) with the integrations you have. Every section is optional until you use it:

```json
{
  "backup": { "passphrase": "at-least-12-characters", "hour": 2 },
  "publicBaseUrl": "http://127.0.0.1:8080",
  "gmail": { "clientId": "", "clientSecret": "", "refreshToken": "", "from": "lab@example.com" },
  "sms": { "url": "https://gateway.example/send?to={to}&msg={message}", "method": "GET" }
}
```

- **Gmail:** create an OAuth client in Google Cloud for the owner's account, then store the refresh token above. Testing-mode tokens expire every 7 days, so sign in again when email stops.
- **SMS:** set the gateway chosen with the client. Until then SMS messages wait in the queue.

Start the app with the desktop shortcut: run `powershell -ExecutionPolicy Bypass -File scripts\install-shortcut.ps1` once. It puts a shortcut on the desktop and one in the Startup folder, so the LMS starts when the user signs in to Windows (delete the Startup copy to turn that off). The launcher keeps a tray icon (Open / Stop) and restarts the server within 15 seconds if it ever stops. The previous run's log is kept as `data/server.prev.log`. Or run `npm start` in a terminal.

**Offline:** after `npm install` and `npm run build` the app needs no internet. Only Gmail and the SMS gateway use the network, and only when configured.

## First run

Open the app. The first-time setup asks for the laboratory name, the first branch code (for example `LHR1`) and the administrator account. It runs once.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server for the screens (proxies `/api` to port 8080). |
| `npm start` | Runs the built server. |
| `npm run build` | Builds the screens and bundles the server into `dist/server`. |
| `npm run typecheck` | TypeScript check. |
| `npm test` | Unit tests (formula, flags, CSV, passwords, encryption, FEFO stock). |
| `npm run smoke` | Starts the server on a temporary database and runs the whole lab workflow. |
| `node dist/server/restore.js backups/<file>.lmsbak` | Restores an encrypted backup. Stop the app first. |

## Data and safety

- All data is in `data/lms.db` (SQLite, WAL). Reports are in `data/files/reports`. Nothing leaves the PC except the messages you send (Gmail, SMS gateway, WhatsApp via your own browser).
- Backups are AES-256-GCM encrypted to `backups/` and hold the database, issued reports, attachments and branding images. A backup runs each day after 02:00 (or at the first check after the PC is switched on, if it was off) and on demand under **Admin → Backup & health**. Without `backup.passphrase` in `data/config.json` no backup is made; the dashboard and the health page say so.
- Copy the `backups/` folder to a second drive or USB stick regularly. A backup on the same disk does not protect against a failed disk.
- The database uses full-durability writes, so a power cut loses at most the request in progress. **Admin → Backup & health** shows a database check and the free disk space.
- The audit log, payments, result revisions and stock ledger are append-only at the database level.
- There are two kinds of user. The **administrator** can do everything: results (enter, review, authorize, amend), reference ranges, catalog, inventory, refunds, voids, closing the cash day, users, template and backups. **Reception** registers patients, takes and receives samples, creates orders, issues invoices, collects payments and sends reports; it cannot enter results, refund, void, close the day or open the admin screens. A discount by reception needs the administrator to type their username and password.
- The administrator creates reception users under **Admin, Users**. Results, refunds and approvals by the administrator are all recorded in the audit log.

## Layout

```
src/server/        API (routes/, services/, migrations.ts, security.ts)
src/client/        React screens (pages/)
src/pdf/           pdfcn Forme components (copied from the registry, imports rewritten)
scripts/           build, smoke test, Windows launcher and shortcut
tests/unit/        unit tests
dist/              built output (git-ignored)
data/              database, files, config.json (git-ignored)
```

## Scope

Requirements baseline: `AMNA LAB LMS_Project_Lifecycle_and_Initial_Documentation_v0.1.docx` (kept out of this repo as client-owned). Phase 2 items (analyzers, FHIR, home collection, portals, insurance, accounting integration) are not in this release.
