# Telegram Attendance Bot

This bot records attendance through Telegram and writes each response into a shared Google Sheet with one worksheet per month.

## Onboarding

The roster-management workflow is named `Onboarding`.

- First-time users send `/start` and complete the Onboarding flow with their secret code.
- The `ONBOARDING` worksheet is the source of truth for appointment names, ordering, and generated secret codes.
- Admins manage the Onboarding workflow from Telegram, including invitations, roster sync, appointment changes, admin access, attendance-option changes, and deregistration.

## Core Behavior

- Returning users send `/start` to open the main inline menu.
- Daily attendance is written into the current month sheet for the bound appointment and date.
- Weekly attendance is submitted through an inline Monday-to-Friday flow and written in one batch at the end.
- Attendance submissions are durably queued first and flushed to Google Sheets on the minute-by-minute sync loop.
- A 5-minute forced reconciliation loop stays enabled so sheet-derived views remain current when people edit the spreadsheet directly.
- Singapore public holidays are treated as `PH` during weekly flows.
- Attendance summaries are available inside Telegram, including an unaccounted view.

## Attendance Options

- `ATTENDANCE_OPTIONS` defines the default attendance codes for the Onboarding workflow.
- Those options are copied into runtime config at startup and into Google Sheets dropdown validation.
- Admins can add, remove, and usage-sort attendance options from Telegram.
- Telegram edits are persisted in `data/settings.json`, so they survive restarts.
- Resetting attendance options from Telegram restores the env-configured `ATTENDANCE_OPTIONS` list, not a separate hardcoded list.

## Sheets Model

- `ONBOARDING` is the source of truth for appointment names and ordering.
- Column `A` of `ONBOARDING` stores appointment names.
- Column `B` of `ONBOARDING` stores the generated secret code for each appointment.
- Monthly sheets use column `A` for appointments and columns `B` onward for dates such as `1 Mar`, `2 Mar`, and so on.
- Monthly sheet row order follows `ONBOARDING`.
- The row labeled `Remarks` and anything below it are excluded from roster management.
- Existing sheet layout changes made by humans are preserved; the bot only provisions its default layout when it creates a new sheet.
- If `ONBOARDING` is missing, the bot creates it from the current month sheet when possible.
- If the spreadsheet starts completely blank, the bot bootstraps `ONBOARDING`, the current month sheet, and the next month sheet automatically.
- If no appointments are present anywhere during bootstrap, the bot seeds `USER1`, `USER2`, and `USER3` as default placeholder rows.
- The bot always ensures next month’s worksheet exists.

## Local State

- `data/users.json`: Telegram user state and conversation state.
- `data/appointment-registry.json`: secret codes, bindings, and custom admin appointments.
- `data/settings.json`: persisted attendance option overrides, ordering, and usage stats.
- `data/sheet-cache.json`: local attendance snapshot cache used for conservative recovery if a month sheet is wiped.
- `data/attendance-queue.ndjson`: append-only attendance event log that survives restarts until the next successful sheet flush.

## User Commands

- `/start`: start Onboarding for new users or open the main menu for bound users.
- `/attendance`: open today’s attendance picker directly.
- `/week`: open the weekly attendance flow.
- `/summary`: open the summary for today.
- `/help`: open the in-bot manual.
- `/manual`: alias for the in-bot manual.
- `/me`: show the bound appointment.
- `/myid`: show the current Telegram chat ID.
- `/lastupdate`: show the last roster and snapshot sync times.
- `/deregister`: remove the current Telegram binding and rotate the code.
- `/onboard`: manually restart Onboarding.
- `/cancel`: clear the current interactive flow.

## Admin Commands

- `/admin`: open the inline admin menu.
- `/promptall`: send the attendance prompt to all bound users.
- `/pending`: list active appointments that have not completed Onboarding yet.
- `/invite <appointment>`: generate an invitation message for one appointment.
- `/syncroster`: sync `ONBOARDING`, codes, and monthly sheets.
- `/admins`: list active admin appointments.
- `/addadmin <appointment>`: grant custom admin access to a currently bound appointment.
- `/removeadmin <appointment>`: remove custom admin access.
- `/addappointment <appointment>`: add a new appointment to the active roster and generate a fresh Onboarding code.
- `/removeappointment <appointment>`: remove an appointment from the active roster.

## Reminders

- Automatic reminders run at `0700 hrs` and `0800 hrs` by default.
- Reminders are only sent on weekdays.
- Reminders are skipped on Singapore public holidays.
- The second reminder only goes to users whose attendance is still blank.
- Reminder times can be changed with `FIRST_REMINDER_TIME` and `SECOND_REMINDER_TIME`.
- Attendance options can be sorted from most-used to least-used by scanning the latest 3 month sheets at startup and once nightly.

## Setup

### 1. Create the Telegram bot

1. Open Telegram and talk to [@BotFather](https://t.me/BotFather).
2. Run `/newbot`.
3. Copy the bot token into `.env`.

### 2. Create the Google Sheet

1. Create a Google Sheet.
2. Share the sheet with the Google service account email.
3. The bot will create the `ONBOARDING` worksheet if it does not exist.
4. The bot will create monthly worksheets automatically, for example `Mar 26` and `Apr 26`.
5. A completely blank spreadsheet is supported. On first sync, the bot will create `ONBOARDING`, the current month, and the next month. If there is no existing roster to import, it will seed `USER1`, `USER2`, and `USER3`.

### 3. Create a Google service account

1. In Google Cloud, create or select a project.
2. Enable the Google Sheets API.
3. Create a service account.
4. Generate a JSON key.
5. Share the Google Sheet with the service account email.
6. Copy `client_email` into `GOOGLE_SERVICE_ACCOUNT_EMAIL`.
7. Copy `private_key` into `GOOGLE_PRIVATE_KEY` and preserve newline escapes as `\n`.

### 4. Configure environment variables

Copy `.env.example` to `.env` and fill in the values.

Required:

- `TELEGRAM_BOT_TOKEN`
- `GOOGLE_SHEETS_SPREADSHEET_ID`
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- `GOOGLE_PRIVATE_KEY`

Common optional settings:

- `BOT_TIMEZONE`
- `FIRST_REMINDER_TIME`
- `SECOND_REMINDER_TIME`
- `ONBOARDING_SHEET_TITLE`
- `ROSTER_STOP_MARKERS`
- `DEFAULT_ADMIN_APPOINTMENTS`
- `ATTENDANCE_OPTIONS`
- `LOG_FILE_PATH`

Example `ATTENDANCE_OPTIONS`:

```env
ATTENDANCE_OPTIONS=PRESENT,DUTY,PH,WFH,OFF,MC
```

Use a comma-separated list. This becomes the default option set for the Onboarding workflow, and admins can refine it later from Telegram without editing the container.

## Run Locally

```bash
npm install
npm start
```

For a quick syntax verification:

```bash
npm run check
```

## Docker Compose

The simplest deployment path is Docker Compose.

1. Copy `.env.example` to `.env`.
2. Fill in the real secrets and attendance options.
3. Start the bot:

```bash
docker compose up -d --build
```

The included `docker-compose.yml` uses:

- `build: .` so you can deploy directly from this repository.
- `env_file: .env` so secrets stay out of the compose file.
- `./data:/app/data` so bindings, codes, queue data, and attendance-option overrides survive restarts.
- Rotated `json-file` container logging.

To stop it:

```bash
docker compose down
```

## Docker

If you prefer plain Docker:

```bash
docker build -t attendance-bot .
docker run -d \
  --name attendance-bot \
  --restart unless-stopped \
  --env-file .env \
  -v "$(pwd)/data:/app/data" \
  attendance-bot
```

Notes:

- Use `--env-file .env` so secrets stay outside the image.
- Mount `./data` to `/app/data` so bindings, codes, queue state, and attendance-option overrides survive container restarts.
- The bot uses Telegram long polling, so there is no HTTP port to publish.

## Notes

- Secret codes are generated automatically for appointments in the active roster.
- Duplicate appointment names in `ONBOARDING` are normalized with `-1`, `-2`, and so on.
- Admin access is effective only while the appointment is currently bound.
- The in-bot manual is available through `/help`, `/manual`, and the Help button in the home menu.
- The bot uses Telegram long polling by default.
