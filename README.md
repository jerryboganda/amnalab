# Amna Lab LMS

Ultralight laboratory management system for one Windows PC. It runs locally, uses a single SQLite file, and needs no database server, Docker or browser engine.

- **Runtime:** Node.js 22.13+ (Node 24 recommended). Built-in `node:sqlite`, `node:http`, `node:crypto`.
- **UI:** React + Vite, served by the local server at `http://127.0.0.1:8080`.
- **Reports:** [pdfcn](https://github.com/shadcn-labs/pdfcn) components rendered with the Forme engine (WebAssembly, no browser).

## Set up on the PC

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

Start the app with the desktop shortcut: run `powershell -ExecutionPolicy Bypass -File scripts\install-shortcut.ps1` once. Or run `npm start` in a terminal.

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
- Backups are AES-256-GCM encrypted to `backups/`. A backup runs each night and on demand under **Admin → Backup & health**.
- The audit log, payments, result revisions and stock ledger are append-only at the database level.
- Results follow four-eyes rules: whoever enters a result cannot review or authorize it. Discounts, refunds, voids and large stock adjustments need a second person's password.

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
