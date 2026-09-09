# Telegram Attendance Bot

Telegram attendance bot backed by Google Sheets. It handles daily and weekly attendance, onboarding, reminders, roster administration and recovery after interrupted writes.

## Setup

Requires Node.js 20+ or Docker, a Telegram bot token, a Google Sheet, and a Google service account with access to the sheet.

```bash
cp .env.example .env
```

Set `TELEGRAM_BOT_TOKEN`, `GOOGLE_SHEETS_SPREADSHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_EMAIL` and `GOOGLE_PRIVATE_KEY`. Edit `settings.yaml` for the unit.

Docker:

```bash
docker compose up -d --build
docker compose logs -f
```

Local:

```bash
npm install
npm start
```

The bot uses Telegram long polling; no inbound HTTP port is required.

## Spreadsheet

`ONBOARDING` contains appointments in column A and onboarding codes in column B. Its visible appointment order is canonical.

Monthly sheets use column A for appointments and row 1 for dates. Attendance is resolved by appointment name and date, never by a remembered row number. Content outside the bot-managed area is preserved.

## Runtime state

Runtime files live in `data/` and are not disposable cache files. In particular:

- `attendance-queue.ndjson` holds acknowledged attendance waiting for Sheets
- `appointment-registry.json` holds the local roster, codes and bindings
- `users.json` holds Telegram user and interaction state
- `sheet-cache.json` holds cached sheet state
- `settings.json` holds runtime attendance-option overrides

Attendance is persisted locally before the user is told it was accepted. Queue replay and reconciliation make those writes safe across restarts and temporary Sheets failures.

## Configuration

Unit structure and default attendance options are in `settings.yaml`. Deployment and runtime settings are documented in `.env.example`.

Defaults include a two-minute attendance flush interval, earlier flush at 25 queued entries, reminders at 07:00 and 08:00, `Asia/Singapore` timezone, and a forced reconciliation every five minutes.

## Development

```bash
npm run check
npm test
```

The core invariants are:

1. Persist attendance before acknowledgement.
2. Resolve attendance by appointment identity and date.
3. Do not interpret uncertain roster loss as deletion.
4. Preserve spreadsheet content outside the managed area.
5. Stop on ambiguous roster or binding state rather than guessing.
6. Keep retries and replay idempotent.

See [`docs/SYSTEM_LOGIC.md`](docs/SYSTEM_LOGIC.md) for the complete behavioural specification, state model, failure handling and a language-neutral reimplementation guide.