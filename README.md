# Telegram Attendance Bot

Telegram front end for unit attendance, backed by Google Sheets.

The bot handles daily and weekly attendance, onboarding, reminders, roster administration and basic sheet repair. Local files under `data/` are used for queued writes, bindings and caches so a restart does not lose an attendance submission that has already been acknowledged.

## Setup

Requirements:

- Node.js 20+ or Docker
- a Telegram bot token
- a Google Sheet
- a Google service account with access to that sheet

Copy the environment template and edit the required values:

```bash
cp .env.example .env
```

Required variables:

```text
TELEGRAM_BOT_TOKEN
GOOGLE_SHEETS_SPREADSHEET_ID
GOOGLE_SERVICE_ACCOUNT_EMAIL
GOOGLE_PRIVATE_KEY
```

Edit `settings.yaml` for the unit before first start. It contains the unit hierarchy, appointments, default admins and attendance options.

Start with Docker Compose:

```bash
docker compose up -d --build
```

Logs:

```bash
docker compose logs -f
```

Stop:

```bash
docker compose down
```

The bot uses Telegram long polling. No inbound HTTP port is required.

To run without Docker:

```bash
npm install
npm start
```

A different settings file can be supplied with `SETTINGS_FILE_PATH`.

## Commands

User commands:

- `/start` — open the bot or begin onboarding
- `/attendance` — submit today's attendance
- `/week` — submit the current workweek
- `/summary` — view attendance for a selected day
- `/me` — show the bound appointment
- `/myid` — show the Telegram chat ID
- `/help` or `/manual` — open the in-bot manual
- `/deregister` — remove the current binding and rotate its code
- `/cancel` — leave the current interactive flow

Admin commands:

- `/admin` — open admin controls
- `/promptall` — send today's prompt to bound users
- `/pending` — show active appointments that have not onboarded
- `/invite <appointment>` — generate an invite and onboarding code
- `/syncroster` — reconcile roster, month sheets, registry and cache
- `/admins` — list admins
- `/addadmin <appointment>` / `/removeadmin <appointment>`
- `/addappointment <appointment>` / `/removeappointment <appointment>`
- `/lastupdate` — show queue/cache/reconciliation timing

Most admin functions are also available through the inline menu.

## Spreadsheet layout

### `ONBOARDING`

`ONBOARDING` and `data/appointment-registry.json` are the two roster records.

- Column A: appointment name
- Column B: onboarding code
- Visible appointment order in `ONBOARDING` is the canonical roster order.
- An appointment present on only one side is normally restored to the other during reconciliation.
- Automatic deletion requires an explicit bot removal record; a one-sided disappearance is treated as an interrupted write.

The bot should not be assumed to own cells outside its managed `ONBOARDING` columns.

### Monthly sheets

Each month uses its own worksheet, for example `Mar 26`.

- Column A contains appointments.
- Row 1 contains date headings such as `1 Mar`, `2 Mar`, etc.
- Attendance writes are resolved by appointment name rather than a stored row number.
- Human-managed rows or columns outside the bot's managed area are preserved.

If a blank spreadsheet is used, the bot creates `ONBOARDING`, the current month and the next month. It will reuse roster data found in existing month sheets before falling back to placeholder users.

## Onboarding

Each active appointment has a secret code. A user enters that code after `/start` or `/onboard` to bind their Telegram account to the appointment.

An appointment cannot be claimed by a second Telegram account while it is already bound. Deregistration removes the binding and rotates the code.

## Attendance

Daily submissions are written to the local attendance queue before the bot confirms them to the user. The queue is then flushed to Google Sheets in batches.

The default flush interval is two minutes, with an earlier flush when 25 eligible entries are queued. These values can be changed with:

```text
ATTENDANCE_QUEUE_FLUSH_INTERVAL_MS
ATTENDANCE_QUEUE_FLUSH_THRESHOLD
```

The weekly flow covers the current Monday-to-Friday workweek. Singapore public holidays are filled as `PH`, including weeks that cross month or year boundaries.

Attendance groups and options come from `attendance.groups` in `settings.yaml`. Admin changes are stored in `data/settings.json`; resetting the options restores the YAML defaults.

## Reminders

Defaults:

- 07:00 — all bound users
- 08:00 — users still blank for the day

Reminders run on weekdays and are skipped on Singapore public holidays.

Times are controlled by:

```text
FIRST_REMINDER_TIME
SECOND_REMINDER_TIME
```

Users must have opened the bot in a private chat and must not have blocked it for reminders to arrive.

## Sync and recovery

The bot keeps local queue, roster and sheet-cache data so normal operation does not depend on a live Sheets read for every Telegram action.

A background sync runs regularly, and a forced reconciliation runs every five minutes. Reconciliation is deliberately conservative:

- `ONBOARDING` controls visible roster order.
- Active membership is recovered from `ONBOARDING` and the local registry rather than deleting a one-sided record.
- Bindings are repaired from the surviving copy where possible.
- Month-sheet writes are matched by appointment name.
- Direct sheet changes can supersede stale cached assumptions.
- Duplicate, missing or otherwise ambiguous managed rows stop automatic repair rather than being guessed at.

Structural maintenance also keeps month sheets aligned with the canonical roster and compacts resolved queue entries.

## Local files

Runtime state lives in `./data`:

- `users.json` — Telegram users and interaction state
- `appointment-registry.json` — appointments, codes, bindings and admin appointments
- `settings.json` — runtime attendance-option overrides
- `sheet-cache.json` — cached roster/month data and sync metadata
- `attendance-queue.ndjson` — queued attendance events
- `attendance-button-cleanup.json` — pending expiry jobs for confirmation buttons
- `logs/attendance-bot.log` — optional text log when `LOG_FILE_PATH` is set

Do not commit runtime data from this directory.

## Configuration

Common optional environment variables:

```text
BOT_TIMEZONE
FIRST_REMINDER_TIME
SECOND_REMINDER_TIME
TELEGRAM_BROADCAST_INTERVAL_MS
TELEGRAM_BROADCAST_CONCURRENCY
INTERACTIVE_PRIORITY_QUIET_MS
ATTENDANCE_QUEUE_FLUSH_INTERVAL_MS
ATTENDANCE_QUEUE_FLUSH_THRESHOLD
SNAPSHOT_REFRESH_POST_BROADCAST_DELAY_MS
GOOGLE_SHEETS_INTER_REQUEST_DELAY_MS
GOOGLE_SHEETS_INTER_REQUEST_DELAY_CONGESTED_MS
ONBOARDING_SHEET_TITLE
LOG_FILE_PATH
SETTINGS_FILE_PATH
GITHUB_TOKEN
```

Notes:

- `BOT_TIMEZONE` defaults to `Asia/Singapore`.
- `ONBOARDING_SHEET_TITLE` defaults to `ONBOARDING`.
- `SETTINGS_FILE_PATH` defaults to `./settings.yaml`.
- Preserve `\n` escapes in `GOOGLE_PRIVATE_KEY` when storing the key in `.env`.
- `GITHUB_TOKEN`, when configured with suitable repository access, enables the in-bot issue-reporting button.
- `ROSTER_STOP_MARKERS` remains in configuration for compatibility but is not used to define the canonical roster.

The default rate controls are intentionally conservative around Google Sheets. Sheets calls are spaced by at least one second, with a longer delay after repeated timeouts. Telegram broadcasts yield to active user interactions.

## Google and Telegram setup

Create the Telegram bot with [@BotFather](https://t.me/BotFather) and place its token in `.env`.

For Google Sheets:

1. Create or choose a Google Cloud project.
2. Enable the Google Sheets API.
3. Create a service account and JSON key.
4. Put its `client_email` and `private_key` into `.env`.
5. Share the attendance spreadsheet with the service-account email.
6. Put the spreadsheet ID in `GOOGLE_SHEETS_SPREADSHEET_ID`.

## Development

Run the syntax checks and test suite before merging:

```bash
npm run check
npm test
```

For a complete syntax pass over production JavaScript:

```bash
find src -type f -name '*.js' -print0 | xargs -0 -n 1 node --check
```

The production Docker image does not contain the test suite.

Useful code locations:

- `src/bot.js` — Telegram commands and interaction flows
- `src/googleSheets.js` — sheet access and reconciliation
- `src/attendanceQueue.js` — durable attendance queue
- `src/storage.js` — local user/registry persistence
- `src/syncManager.js` — background and forced sync cycles
- `src/weeklyFlow.js` / `src/holidays.js` — weekly attendance and holiday handling

## Operational cautions

Attendance must remain durable before acknowledgement. Queue replay must remain safe across retries and restarts.

Roster and binding code should fail closed on ambiguous spreadsheet state. Do not weaken those checks just to make a malformed sheet reconcile automatically.

Never commit Telegram tokens, Google credentials, spreadsheet IDs, GitHub tokens, user bindings, attendance records or runtime logs.
