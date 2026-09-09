# Telegram Attendance Bot

Telegram attendance bot backed by Google Sheets. It supports daily and weekly attendance, onboarding, reminders, roster administration and recovery after restarts or interrupted Sheets writes.

## Run it

Requirements: Node.js 20+ or Docker, a Telegram bot token, a Google Sheet, and a Google service account with access to that sheet.

```bash
cp .env.example .env
```

Set:

```text
TELEGRAM_BOT_TOKEN
GOOGLE_SHEETS_SPREADSHEET_ID
GOOGLE_SERVICE_ACCOUNT_EMAIL
GOOGLE_PRIVATE_KEY
```

Edit `settings.yaml` for the unit, then start:

```bash
docker compose up -d --build
```

Logs and shutdown:

```bash
docker compose logs -f
docker compose down
```

Without Docker:

```bash
npm install
npm start
```

The bot uses Telegram long polling; no inbound HTTP port is required.

## Main commands

Users: `/start`, `/attendance`, `/week`, `/summary`, `/me`, `/help`, `/deregister`.

Admins: `/admin`, `/promptall`, `/pending`, `/invite`, `/syncroster`, `/admins`, `/addadmin`, `/removeadmin`, `/addappointment`, `/removeappointment`, `/lastupdate`.

Most admin actions are also available from the inline admin menu.

## Spreadsheet layout

`ONBOARDING` contains the active appointments and onboarding codes:

- column A: appointment
- column B: secret code
- visible row order is the canonical roster order

Each month has its own sheet (for example `Sep 26`):

- column A: appointment
- row 1: dates
- attendance is matched by appointment name, not a stored row number

The bot preserves sheet content outside its managed area and refuses to guess when the managed roster is ambiguous.

## Runtime state

Local state lives in `data/` and must not be committed. Important files include:

- `appointment-registry.json` — roster, codes and bindings
- `users.json` — Telegram users and interaction state
- `attendance-queue.ndjson` — durable attendance queue
- `sheet-cache.json` — cached sheet state
- `settings.json` — runtime attendance-option overrides

Attendance is written locally before the bot acknowledges it, then flushed to Sheets in the background. This is a deliberate durability guarantee.

## Configuration

Unit structure and default attendance options live in `settings.yaml`. Runtime tuning is in `.env.example`.

Defaults include:

- attendance queue flush: 2 minutes, or earlier at 25 queued entries
- reminders: 07:00 to all bound users, 08:00 to users still blank
- timezone: `Asia/Singapore`
- forced reconciliation: every 5 minutes

Singapore public holidays are skipped for reminders and are filled as `PH` in the weekly flow.

## Development

```bash
npm run check
npm test
find src -type f -name '*.js' -print0 | xargs -0 -n 1 node --check
```

Do not let tests contact live Telegram, Google Sheets or GitHub unless an integration test is explicitly intended.

The important implementation rules are:

- persist attendance before acknowledgement
- keep queue replay idempotent
- reconcile roster membership conservatively
- resolve attendance by appointment identity
- preserve human-owned spreadsheet content
- fail closed on ambiguous roster or binding state

For the full system design, data flows, recovery behaviour and module responsibilities, see [`docs/SYSTEM_LOGIC.md`](docs/SYSTEM_LOGIC.md).

Repository-specific instructions for coding agents are in [`AGENTS.md`](AGENTS.md).
