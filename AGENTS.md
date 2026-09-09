# Agent Notes

This repo is a Telegram attendance bot with Google Sheets as the shared record. Local files under `data/` provide restart-safe queueing, bindings and cache state.

## Rules that should not change accidentally

- `ONBOARDING` controls visible roster order.
- Active roster membership is reconciled from both `ONBOARDING` and the local appointment registry. Do not turn a one-sided disappearance into an automatic deletion.
- Attendance must be persisted locally before the user is told it was accepted.
- Queue replay must stay idempotent across retries, restarts and partial Sheets writes.
- Resolve attendance by appointment identity, not a remembered row number.
- Preserve spreadsheet content outside the bot-managed area.
- Treat ambiguous roster or binding state as an error rather than guessing.
- `settings.yaml` is the deploy-time source for unit structure and default attendance options.

Do not commit credentials, spreadsheet IDs, Telegram bindings, attendance data, logs or other runtime files from `data/`.

Tests must not contact live Telegram, Google Sheets, GitHub or a deployed bot unless an integration check was explicitly requested.

## Where things live

- `src/index.js` — startup
- `src/bot.js` — Telegram commands and UI
- `src/googleSheets.js` — Sheets access and reconciliation
- `src/syncManager.js` — sync scheduling
- `src/attendanceQueue.js` / `src/attendanceTransferJournal.js` — queued attendance writes
- `src/storage.js` / `src/fileStore.js` — local persistence
- `src/weeklyFlow.js` / `src/holidays.js` — weekly attendance and date rules
- `settings.yaml` — unit configuration
- `test/` — Node test suite

## Working on the repo

Keep changes scoped where practical. Changes involving onboarding codes, user bindings, admin access, roster deletion, queue replay, spreadsheet writes or credentials need an explicit security/data-integrity review.

Add regression tests when changing recovery or reconciliation behaviour. Do not relax an ambiguity guard simply to make a fixture pass.

Use Node.js 20 or newer.

Run:

```bash
npm run check
npm test
```

`npm run check` does not currently cover every production source file, so also run:

```bash
find src -type f -name '*.js' -print0 | xargs -0 -n 1 node --check
```

If Docker behaviour changed, also verify that the production image builds and its copied JavaScript parses:

```bash
docker build -t attendance-bot:check .
docker run --rm --entrypoint sh attendance-bot:check -c 'find src -type f -name "*.js" -print0 | xargs -0 -n 1 node --check'
```

The production image does not contain `test/`, so the container check does not replace `npm test` on the host.

If live Telegram or Sheets behaviour was not exercised, say so rather than treating the unit suite as deployment evidence.
