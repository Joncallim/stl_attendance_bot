# Telegram Attendance Bot

A Telegram bot for ship or unit attendance that uses Google Sheets as the shared source of record and Telegram as the user interface.

The bot supports:

- daily attendance submission
- weekly Monday-to-Friday attendance submission
- admin roster management
- onboarding by secret code
- Google Sheets sync and repair
- reminder notifications
- cached summaries and unaccounted views
- local persistence so the bot can recover cleanly after restarts
- unit-specific structure from `settings.yaml`

## Quick Start

The simplest path is Docker Compose.

1. Create a Telegram bot with [@BotFather](https://t.me/BotFather) and copy the token.
2. Create a Google Sheet.
3. Create a Google service account, enable the Google Sheets API, and share the sheet with that service account email.
4. Copy `.env.example` to `.env`.
5. Copy `settings.yaml` and edit it for your unit:
   - unit metadata
   - department and section hierarchy
   - appointment definitions and default admins
   - attendance groups and options
6. Fill in these required values in `.env`:
   - `TELEGRAM_BOT_TOKEN`
   - `GOOGLE_SHEETS_SPREADSHEET_ID`
   - `GOOGLE_SERVICE_ACCOUNT_EMAIL`
   - `GOOGLE_PRIVATE_KEY`
7. Start the bot:

```bash
docker compose up -d --build
```

To stop it:

```bash
docker compose down
```

That is enough for a working deployment. The bot uses long polling, so you do not need to expose any HTTP port.

## What The Bot Does

### Users

- `/start` opens the home menu for bound users and starts onboarding for unbound users.
- `/attendance` opens today’s attendance picker.
- `/week` opens the weekly attendance flow.
- `/summary` opens the attendance summary for the selected day.
- `/help` and `/manual` open the in-bot manual.
- `/me` shows the bound appointment.
- `/myid` shows the Telegram chat ID.
- `/deregister` removes the current Telegram binding and rotates the secret code.
- `/cancel` clears the current interactive flow.

### Admins

Admins can do everything users can do, plus:

- `/admin` opens the admin menu.
- `/promptall` sends today’s attendance prompt to all bound users.
- `/pending` lists appointments that are active but not yet onboarded.
- `/invite <appointment>` generates an invitation message and code for one appointment.
- `/syncroster` syncs `ONBOARDING`, monthly sheets, registry data, and cache.
- `/admins` lists current admins.
- `/addadmin <appointment>` grants admin access to a bound appointment.
- `/removeadmin <appointment>` removes admin access.
- `/addappointment <appointment>` adds a new active appointment and generates a code.
- `/removeappointment <appointment>` removes an appointment from the active roster.
- `/lastupdate` shows queue, cache, and reconciliation timing.

The inline admin menu also includes:

- roster management
- invitation generation
- admin management
- attendance option management
- prompt sending
- deregistration flows
- cached summary and unaccounted views

## Sheets Model

### Canonical Roster

`ONBOARDING` and the local appointment registry are mirrored roster records.

- Column `A` contains appointment names.
- Column `B` contains the generated secret code for each appointment.
- The visible managed appointment order in `ONBOARDING` is the canonical order used everywhere else.
- If an appointment survives in either `ONBOARDING` or `appointment-registry.json`, roster sync restores it to the missing side.
- Automatic roster deletion requires an explicit bot-removal tombstone; a one-sided disappearance is treated as an interrupted write.
- The bot no longer relies on `Remarks` as a stop marker.
- Anything outside the managed `ONBOARDING` columns is treated conservatively and should not be assumed to be bot-owned.

### Monthly Sheets

Each month lives in its own worksheet, for example `Mar 26` or `Apr 26`.

- Column `A` contains appointment names.
- Row `1` contains date headers such as `1 Mar`, `2 Mar`, and so on.
- The bot only manages the intersection of:
  - appointments present in canonical `ONBOARDING`
  - date columns that actually exist in the month sheet header row
- The bot preserves human-added layout outside that managed box.
- The bot resolves attendance by appointment identity, not by stale row number.

### Bootstrap Behavior

If the spreadsheet is blank:

- the bot creates `ONBOARDING`
- the bot creates the current month sheet
- the bot creates the next month sheet

If the bot can recover an existing roster from month sheets, it will do that before using placeholders.

If there is no roster data anywhere, it seeds:

- `USER1`
- `USER2`
- `USER3`

## Onboarding And Binding

- Each active appointment gets a secret code.
- A user starts onboarding with `/start` or `/onboard`.
- The user enters the secret code to bind Telegram to the appointment.
- If an appointment is already bound to a different Telegram account, another user cannot claim it with the same code.
- Deregistration clears the binding and rotates the code.

## `settings.yaml`

`settings.yaml` is the deploy-time source of truth for unit structure.

- `unit`: unit identity metadata
- `hierarchy`: explicit department and section nodes
- `appointments`: configured appointments, hierarchy assignment, and `defaultAdmin`
- `attendance.groups`: grouped attendance options used by Telegram menus and summaries

The bot expects `settings.yaml` at the repo root by default. Override the path with `SETTINGS_FILE_PATH` if needed.

## Attendance Flow

### Daily

- Users submit one attendance value for today.
- The bot records the choice durably first.
- The write is then flushed to Sheets in a background batch, normally within two minutes or sooner when 25 eligible entries accumulate.

### Weekly

- The weekly flow covers the current workweek.
- Public holidays are auto-filled as `PH`.
- Cross-month weeks are supported.
- Cross-year month rollover is supported.
- Weekly entries are staged and then written as per-day attendance events.

## Reminders

By default:

- `0700` reminder: sent to all bound users with an appointment
- `0800` reminder: sent only to users whose attendance is still blank

Reminder rules:

- reminders run only on weekdays
- reminders are skipped on Singapore public holidays
- reminder times can be changed with:
  - `FIRST_REMINDER_TIME`
  - `SECOND_REMINDER_TIME`

## Summary And Cache

The bot uses a local cache so Telegram screens stay fast and Google Sheets reads stay low.

- home menu and summary views render from cache
- the queue is persisted locally before sheet flush
- cached month snapshots are used for summary and reminder checks
- a 1-minute background loop refreshes cache opportunistically
- nonessential snapshot reads defer during a prompt broadcast and for 30 seconds afterward
- a 5-minute forced reconciliation pass repairs drift and pushes resolved changes back to Sheets

Summary features include:

- grouped attendance categories
- per-category breakdowns
- unaccounted view on working days
- cached rendering for faster response

## Sync And Repair Model

The bot is intentionally conservative when people edit spreadsheets manually.

- `ONBOARDING` remains authoritative for visible row order; active membership is reconciled as the union of `ONBOARDING` and the local appointment registry.
- Roster and binding checksums are stored after reconciliation. Missing user/registry bindings are repaired from the surviving side.
- A user binding is cleared automatically only when its appointment exists in neither active roster record, or when the bot deliberately removed that appointment.
- Month-sheet writes are resolved by appointment name, not by row position.
- If the sheet is ambiguous, the bot fails safe instead of guessing.
- Direct sheet edits are preferred over stale bot assumptions during reconciliation.
- The bot preserves unmanaged rows and unmanaged columns.
- Unexpected rows inside the managed month block are treated as drift and can block repair instead of being silently deleted.
- Duplicate or missing appointment rows are treated as unsafe conditions.

## Attendance Options

Attendance defaults and menu grouping are defined by `attendance.groups` in
`settings.yaml`; there is no `ATTENDANCE_OPTIONS` environment override.
Statuses may appear in more than one Telegram menu for searchability, while
the Google Sheets dropdown always receives each status only once.

Behavior:

- these values come from `settings.yaml` and seed the Google Sheets dropdown validation
- admins can add, remove, and reset options from Telegram
- changes are stored in `data/settings.json`
- resetting options restores the `settings.yaml` defaults
- older stored option overrides are migrated when the attendance option schema changes

## Local Data Files

The bot stores local state in `./data`.

- `data/users.json`: Telegram user state and conversation state
- `data/appointment-registry.json`: appointments, secret codes, bindings, and admin appointments
- `data/settings.json`: attendance option overrides and usage data
- `data/sheet-cache.json`: cached sheet snapshots and sync metadata
- `data/attendance-queue.ndjson`: append-only queued attendance events
- `data/attendance-button-cleanup.json`: restart-safe expiry jobs for attendance confirmation buttons
- `data/logs/attendance-bot.log`: optional human-readable log file if `LOG_FILE_PATH` is set

## Installation

### Option 1: Docker Compose

1. Copy the environment template:

```bash
cp .env.example .env
```

2. Edit `.env`.
3. Edit `settings.yaml` for the unit you are deploying.
4. Start the bot:

```bash
docker compose up -d --build
```

5. Check logs:

```bash
docker compose logs -f
```

### Option 2: Run Locally

Requirements:

- Node.js 20 or newer
- a Telegram bot token
- a Google Sheet
- a Google service account with access to that sheet

Steps:

```bash
cp .env.example .env
npm install
npm start
```

Edit `settings.yaml` before starting the bot. To use a different file location:

```bash
SETTINGS_FILE_PATH=/path/to/settings.yaml npm start
```

For `pm2`, use the same startup contract:

```bash
pm2 start npm --name attendance-bot -- start
```

Useful commands:

```bash
npm run check
npm test
```

## Environment Variables

### Required

- `TELEGRAM_BOT_TOKEN`
- `GOOGLE_SHEETS_SPREADSHEET_ID`
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- `GOOGLE_PRIVATE_KEY`

### Common Optional

- `BOT_TIMEZONE`
- `FIRST_REMINDER_TIME`
- `SECOND_REMINDER_TIME`
- `TELEGRAM_BROADCAST_INTERVAL_MS`
- `TELEGRAM_BROADCAST_CONCURRENCY`
- `INTERACTIVE_PRIORITY_QUIET_MS`
- `ATTENDANCE_QUEUE_FLUSH_INTERVAL_MS`
- `ATTENDANCE_QUEUE_FLUSH_THRESHOLD`
- `SNAPSHOT_REFRESH_POST_BROADCAST_DELAY_MS`
- `GOOGLE_SHEETS_INTER_REQUEST_DELAY_MS`
- `GOOGLE_SHEETS_INTER_REQUEST_DELAY_CONGESTED_MS`
- `ONBOARDING_SHEET_TITLE`
- `LOG_FILE_PATH`
- `SETTINGS_FILE_PATH`
- `GITHUB_TOKEN`

### Notes

- `GOOGLE_PRIVATE_KEY` must keep newline escapes as `\n`.
- `BOT_TIMEZONE` defaults to `Asia/Singapore`.
- `ONBOARDING_SHEET_TITLE` defaults to `ONBOARDING`.
- `SETTINGS_FILE_PATH` defaults to `./settings.yaml`.
- `ROSTER_STOP_MARKERS` is still present in config, but the bot now uses `ONBOARDING` as the canonical roster source and does not rely on `Remarks`.
- `GITHUB_TOKEN` is a GitHub Personal Access Token with `repo` scope. When set, users can submit bug reports from the bot via the "🐛 Report Issue" button. The button is hidden when this variable is not configured.

### Responsiveness Tuning

The defaults reserve Telegram and Sheets capacity for incoming user actions:

- broadcasts launch every `100` ms with up to `12` concurrent requests, or about 10 messages/second
- background launches pause while an update is handled and for `500` ms afterward
- attendance is durable locally before acknowledgement, then flushed every `120000` ms or at `25` eligible queued entries
- nonessential snapshots wait until `30000` ms after the latest broadcast
- Sheets requests retain `1000` ms spacing and automatically use `3000` ms spacing after repeated timeouts

At the default broadcast rate, 100 recipients take approximately 10 seconds and 300 take approximately 30 seconds. Sheets can trail Telegram by roughly one to two minutes during busy periods, while attendance taps remain immediately acknowledged and locally recoverable.

Safety bounds clamp broadcast concurrency to 15 and Sheets spacing to at least one second. Tune the variables in `.env` and restart the process; no code change is required.

## Google Setup

### Telegram

1. Open Telegram and talk to [@BotFather](https://t.me/BotFather).
2. Run `/newbot`.
3. Copy the token into `.env`.

### Google Cloud

1. Create or select a Google Cloud project.
2. Enable the Google Sheets API.
3. Create a service account.
4. Create a JSON key for that service account.
5. Copy:
   - `client_email` into `GOOGLE_SERVICE_ACCOUNT_EMAIL`
   - `private_key` into `GOOGLE_PRIVATE_KEY`

### Google Sheet

1. Create a Google Sheet.
2. Share it with the service account email.
3. Copy the spreadsheet ID into `GOOGLE_SHEETS_SPREADSHEET_ID`.

## Logging

The Docker Compose setup already enables rotated container logs.

If you also want a plain text log file, set:

```env
LOG_FILE_PATH=/app/data/logs/attendance-bot.log
```

With Docker Compose, that file will persist inside the mounted `./data` directory.

## Operational Notes

- The bot uses Telegram long polling.
- Users must have started the bot in a private chat to receive reminders.
- If a user blocks the bot, notifications cannot be delivered.
- The `0700` reminder goes to everyone bound to an appointment.
- The `0800` reminder goes only to users still blank for that day.
- Admin home shows `Last Synchronisation` from the 5-minute reconciliation pass.

## Data Flow

This section describes the complete lifecycle of a user action from Telegram to Google Sheets and back.

### User submits attendance (daily flow)

```
User taps attendance button in Telegram
  │
  ▼
Telegraf callback handler (bot.js)
  │  reads user from users cache (storage.js — 30 s TTL)
  │  reads current attendance status from adminCache.sheetSnapshots (in-memory)
  │
  ▼
enqueueAttendanceEvent (attendanceQueue.js)
  │  serialized by QUEUE_MUTEX_KEY
  │  appends one NDJSON line to data/attendance-queue.ndjson
  │  updates in-memory cachedQueueState
  │
  ▼
Bot responds immediately (cache read — no Sheets API call)
  │
  ▼ (background, up to 60 s later)
syncManager.runCycle → flushAttendanceQueue (attendanceQueue.js)
  │  serialized by QUEUE_MUTEX_KEY
  │  coalesces events: last-write-wins per (appointment, date)
  │  calls reconcilePendingAttendanceWithSheets
  │
  ▼
reconcilePendingAttendanceWithSheets (googleSheets.js)
  │  reads local sheet-cache.json
  │  fetches live month slice(s) via Sheets API (force: true)
  │  resolves row and column for each entry against the live layout
  │  builds a batch of { range, value } pairs
  │
  ▼
sheets.spreadsheets.values.batchUpdate (single API call for all entries)
  │  governed by acquireSheetsSemaphore: one request in-flight at a time
  │  1 000 ms inter-request delay (3 000 ms under congestion)
  │  15 s timeout per request with up to 5 retries (exponential backoff)
  │
  ▼
Queue bookkeeping written in one batch appendJsonLines call
  │  all flushed / skipped / conflicted records written atomically
  │
  ▼
Local sheet-cache.json updated with the reconciled snapshot
  │
  ▼
adminCache.sheetSnapshots updated (in-memory) on the next preload cycle
```

### 0700 morning reminder (up to 100 concurrent users)

```
node-cron fires at 0700 SGT
  │
  ▼
isReminderWorkingDay check (Singapore public holidays + weekday filter)
  │
  ▼
syncManager.runCycle({ force: true, reason: "reminder" })
  │  flushes any queued attendance before reading live state
  │  refreshes month snapshots via Sheets API (TTL-gated)
  │
  ▼
listUsers() → users cache (storage.js — 30 s TTL, single disk read)
  │  filters to bound users (appointment !== null)
  │  first reminder: all bound users
  │  second reminder: only users with blank attendance for today
  │
  ▼
Promise.allSettled over all users — all Telegram sends fire concurrently
  │  buildAndSendAttendancePrompt(bot, config, user, adminCache)
  │    reads current status from adminCache.sheetSnapshots (in-memory, no disk)
  │    calls bot.telegram.sendMessage (Telegram API, concurrent per user)
  │    returns { chatId, awaitingAttendance }
  │
  ▼
batchUpdateUsersByChatId(patches) — single read-modify-write for all users
  │  serialized by STORAGE_MUTEX_KEY
  │  reads users.json once, applies all patches, writes once
  │  updates in-memory users cache
```

### Background sync cycles

```
Every 60 s — opportunistic background cycle
  │  syncManager.runCycle({ force: false })
  │  skips if a cycle is already running (deduplication)
  │  flushes queue, refreshes onboarding TTL, refreshes month slices TTL
  │
Every 5 min — forced reconciliation cycle
  │  syncManager.runCycle({ force: true })
  │  same as above but bypasses TTL gates
  │  self-healing: detects and repairs appointment name drift in month sheets
  │
02:00 daily — structural maintenance cron
  │  inserts / deletes rows to match canonical ONBOARDING roster
  │  compacts attendance-queue.ndjson (drops resolved events)
  │  refreshes attendance option sort order
```

### Caching layers

| Layer | Backing store | TTL | Governs |
|---|---|---|---|
| `usersCache` (storage.js) | `data/users.json` | 30 s | All user record reads |
| `adminCache.sheetSnapshots` (bot.js) | In-memory Map | No TTL — refreshed by sync cycle | Summary and reminder status reads |
| `processSpreadsheetCache` (googleSheets.js) | In-memory WeakMap | 45 min | `spreadsheets.get` metadata |
| `onboardingSlice` (sheet-cache.json) | `data/sheet-cache.json` | 2 min | ONBOARDING roster reads |
| `monthSlices` (sheet-cache.json) | `data/sheet-cache.json` | 60 s | Monthly attendance reads |

### Concurrency controls

| Mutex / semaphore | Key | Serializes |
|---|---|---|
| `runSerialized("storage")` | `STORAGE_MUTEX_KEY` | All `users.json` and registry write operations |
| `runSerialized("attendance-queue")` | `QUEUE_MUTEX_KEY` | All queue reads and writes |
| `runSerialized("sheet-operations")` | `SHEET_OPERATION_MUTEX_KEY` | All Sheets sync cycles |
| `acquireSheetsSemaphore()` | Module-level promise chain | All outgoing Google Sheets API calls |

## Safety Notes

- Secret codes are generated automatically.
- Binding is blocked if an appointment is already claimed by another Telegram account.
- The bot prefers direct spreadsheet edits over stale bot state during reconciliation.
- When the managed month area becomes ambiguous, the bot is designed to fail safe rather than guess.
