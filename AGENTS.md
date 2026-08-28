# Attendance Bot Agent Guide

This repository contains a Telegram attendance bot that treats Google Sheets as the shared record and durable local files as its restart-safe queue, registry, cache, and interaction state.

## Invariants

- Preserve the reconciliation model in `README.md`: visible `ONBOARDING` order is canonical, active membership is the safe union of sheet and local registry, and automatic deletion requires explicit evidence. Fail safely on ambiguous rows or bindings.
- Record attendance durably before acknowledging it, keep queue replay idempotent, and preserve appointment-identity resolution across row moves, month boundaries, restarts, and partial writes.
- Treat `settings.yaml` as deploy-time unit structure and preserve human-owned spreadsheet rows/columns outside the bot-managed area.
- Never commit Telegram tokens, Google credentials/private keys, spreadsheet IDs, GitHub tokens, user bindings, attendance data, logs, or files from `data/`.
- Do not contact Telegram, Google Sheets, GitHub, or a live deployment during tests unless the user explicitly requests a controlled integration check.

## Repository Map

- `src/index.js`, `src/bot.js`: startup and Telegram behavior.
- `src/googleSheets.js`, `src/syncManager.js`: sheet access and reconciliation.
- `src/attendanceQueue.js`, `src/attendanceTransferJournal.js`, `src/storage.js`, `src/fileStore.js`: durable state and recovery.
- `src/weeklyFlow.js`, `src/holidays.js`: attendance rules and date/roster validation.
- `settings.yaml`: unit-specific structure and default attendance options.
- `test/`: Node test suite with mocked clients and per-test temporary data.

## Focused Workflow

- Keep a single writer per source or test file. Route Telegram UX, sheet reconciliation, and local durability as separate scopes when parallel work is useful; follow implementation with an independent read-only regression review.
- Changes to onboarding codes, bindings, admins, deletion/tombstones, queue replay, spreadsheet writes, credentials, or issue-submission tokens require a security/data-integrity review.
- Add focused behavioral tests beside every changed recovery or reconciliation contract. Do not weaken ambiguity guards to make a fixture pass.

## Validation

- Syntax: check every production module, including files outside the current
  `npm run check` list, with
  `find src -type f -name '*.js' -print0 | xargs -0 -n 1 node --check`.
- Regression suite: run `npm test` on the host, where `test/` is present. The
  production image intentionally omits the test suite.
- Container build/syntax parity when Docker behavior changes: run
  `docker build -t attendance-bot:check .`, then
  `docker run --rm --entrypoint sh attendance-bot:check -c 'find src -type f -name "*.js" -print0 | xargs -0 -n 1 node --check'`.
  This proves the production image builds and every copied JavaScript source
  parses under the image's Node runtime; it does not replace the host regression
  suite or start the bot.

Use Node.js 20 or newer. State any live Telegram/Sheets behavior that remains unverified; unit tests are not authorization to deploy or to alter a production sheet.
