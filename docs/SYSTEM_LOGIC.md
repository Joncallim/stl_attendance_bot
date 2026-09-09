# System Logic

This document explains how the attendance bot fits together, what owns each piece of state, and how it recovers from interrupted work.

## 1. System shape

The bot has three main stores:

1. **Telegram** is the user interface.
2. **Google Sheets** is the shared attendance record used by the unit.
3. **Local files under `data/`** provide durable queueing, bindings, recovery journals and caches.

The local files are not disposable scratch space. Some of them are part of the consistency model and allow the bot to survive restarts or temporary Google Sheets failures without losing acknowledged user actions.

The main modules are:

- `src/index.js` — process startup and shutdown
- `src/bot.js` — Telegram commands, menus and workflows
- `src/googleSheets.js` — sheet reads, writes, reconciliation and structural maintenance
- `src/attendanceQueue.js` — durable attendance event queue
- `src/storage.js` — users, appointment registry and runtime settings
- `src/syncManager.js` — scheduling and coalescing of background sync work
- `src/attendanceTransferJournal.js` — crash recovery for appointment transfers
- `src/concurrency.js` — bounded Telegram broadcast dispatch
- `src/workPriority.js` / `src/broadcastActivity.js` — interactive work takes priority over background work
- `src/weeklyFlow.js` / `src/holidays.js` — weekly attendance and public-holiday handling
- `src/messageCleanup.js` — restart-safe expiry of temporary Telegram controls

## 2. Sources of truth

There is intentionally no single source of truth for every field.

### Roster order

The visible appointment order in `ONBOARDING` is canonical. Month sheets should follow this order in the bot-managed area.

### Active roster membership

Active membership is reconciled from both:

- `ONBOARDING`
- `data/appointment-registry.json`

This prevents an interrupted write on one side from silently deleting an appointment. If an appointment exists on only one side, reconciliation normally restores the missing copy.

A deliberate removal is different: the bot records enough intent to distinguish an explicit removal from an accidental one-sided disappearance.

### Telegram bindings

Bindings are represented in local user and appointment state. Reconciliation can repair a missing copy from the surviving side when the identity is unambiguous.

The bot must not assign an appointment to a second Telegram account while it is already bound.

### Attendance

Google Sheets is the shared record, but newly submitted attendance first exists as a durable local queue event. The queue is therefore authoritative for acknowledged writes that have not yet reached Sheets.

## 3. Startup

`src/index.js` performs startup in a fixed order:

1. secure runtime file permissions
2. configure the network stack
3. configure logging
4. load stored configuration overrides
5. create the bot and its Sheets dependencies
6. start Telegram long polling
7. register Telegram commands
8. install graceful shutdown handlers

Startup and reconciliation code may also create missing sheet structures and recover durable local state.

The process should fail visibly if required configuration or a safety-critical state cannot be resolved. Silent fallback is appropriate only where the fallback is explicitly part of the design.

## 4. Onboarding

Each active appointment has a secret onboarding code.

A new user runs `/start` or `/onboard`, supplies the code and is bound to that appointment. The binding is stored locally and used for all later attendance actions.

Important rules:

- a code identifies an appointment, not a person
- a currently bound appointment cannot be claimed by another Telegram account
- deregistration clears the current binding and rotates the code
- binding repair must use stable appointment identity, not sheet row position

## 5. Daily attendance write path

The critical contract is: **the bot does not tell the user that attendance was accepted until it has been persisted locally.**

The normal flow is:

```text
Telegram callback
    |
    v
validate user, appointment, date and status
    |
    v
enqueue durable attendance event
    |
    v
append event to attendance-queue.ndjson
    |
    v
update in-memory queue state
    |
    v
acknowledge user
    |
    v
background queue flush
    |
    v
resolve appointment/date against live sheet layout
    |
    v
batch write to Google Sheets
    |
    v
append queue result record
    |
    v
refresh local/cache state
```

The queue is append-only between compactions. State is reconstructed by replaying queue records. This means a crash during a flush leaves enough history to determine whether an event is still pending, retryable, conflicted, skipped or complete.

### Idempotency

Attendance replay must be safe. Re-running a pending event must not create a second logical attendance submission.

The queue tracks event identity and idempotency information, and flush processing coalesces compatible writes where appropriate. The latest valid value for the same appointment/date can supersede an older queued value.

### Retry behaviour

Temporary failures are retried with backoff. Repeated failures are bounded so a permanently failing event does not retry forever.

A layout conflict is not treated like a transient network error. If the sheet structure is unsafe or ambiguous, the event is marked conflicted and requires reconciliation rather than blind retries.

## 6. Weekly attendance

The weekly workflow stages selections for the current Monday-to-Friday workweek, then resolves them into normal per-day attendance entries.

The weekly flow must handle:

- weeks crossing month boundaries
- weeks crossing year boundaries
- Singapore public holidays
- skipped days
- repeated edits before final submission

Public holidays are auto-filled as `PH`.

Weekly submission ultimately enters the same durable attendance pipeline as daily submission; it should not bypass the queue simply because several dates are being submitted together.

## 7. Google Sheets layout

### `ONBOARDING`

Managed fields:

- column A — appointment name
- column B — onboarding code

The bot should make no assumption that unrelated cells elsewhere on the sheet belong to it.

### Month sheets

Each month uses a worksheet such as `Sep 26`.

Managed layout:

- column A — appointments
- row 1 — date headings
- body — attendance values

Writes are resolved from appointment name and date against the current sheet. The bot must not keep using a row number captured before a user manually reorders the sheet.

## 8. Reconciliation

Reconciliation exists to repair expected drift without destroying uncertain human changes.

The safe bias is conservative:

- recover a one-sided roster record instead of deleting it
- repair a binding from a surviving unambiguous copy
- preserve cells outside the managed area
- prefer current sheet structure over stale cached row assumptions
- stop when duplicate or missing rows make identity ambiguous

A reconciliation failure should be diagnosable. It is preferable to leave an obvious unresolved state than to make a destructive guess.

## 9. Background sync

`src/syncManager.js` coalesces overlapping sync requests so background work does not start duplicate cycles.

A cycle can include:

1. queue flush
2. onboarding/roster refresh
3. admin cache refresh
4. month-slice refresh

There are several reasons a cycle may be requested: routine background refresh, foreground user work, reminder preparation, forced reconciliation or an explicit flush threshold.

If a stronger request arrives while a weaker cycle is already running, the manager records a follow-up rather than dropping the stronger requirement.

During structural maintenance, foreground or durability-critical work is deferred and replayed afterward instead of being discarded.

## 10. Interactive priority

Telegram user interactions take priority over broadcasts and nonessential Sheets refreshes.

The process-wide Telegram dispatcher limits both launch rate and concurrency. Broadcast work checks whether interactive work has started before consuming a send slot.

Rate-limit responses and temporary Telegram server errors are retried within bounded limits. A global pause is shared across concurrent broadcast callers so two broadcasts cannot independently exceed the intended send rate.

The same principle is used around background Sheets work: routine refreshes may yield when the bot is actively serving users.

## 11. Reminders

Two reminder passes are scheduled by default:

- 07:00 — all bound users
- 08:00 — users who are still blank

Before sending reminders the bot refreshes enough state to avoid prompting from obviously stale attendance data.

Reminders are not sent on weekends or Singapore public holidays.

A Telegram user must previously have started the bot in private chat, and Telegram can still prevent delivery if the user blocks the bot.

## 12. Appointment transfers

Moving attendance/binding ownership between appointments is a multi-step operation and cannot safely be treated as one in-memory transaction.

`attendance-transfer-journal.json` records progress through the transfer. The journal is written before the dangerous steps begin and is only removed when the operation is known to be complete.

This prevents a restart between:

- copying attendance
- changing the binding
- clearing the source appointment

from leaving an invisible half-completed transfer.

If a journal already exists, a second transfer must not begin until the previous transfer is recovered or deliberately resolved.

## 13. Local files

Key runtime files:

### `attendance-queue.ndjson`

Append-only attendance queue and outcome log. Replayed to reconstruct current queue state. Periodically compacted after resolved records no longer need to be retained.

### `appointment-registry.json`

Local roster copy, onboarding codes, appointment bindings and admin appointments.

### `users.json`

Telegram user state and interaction state.

### `sheet-cache.json`

Cached onboarding and month slices plus sync metadata. Used to avoid unnecessary Sheets calls and keep menus responsive.

### `settings.json`

Runtime attendance-option changes made by admins. `settings.yaml` remains the deploy-time default.

### `attendance-transfer-journal.json`

Present only while an appointment transfer is in progress or awaiting recovery.

### `attendance-button-cleanup.json`

Tracks temporary Telegram controls that still need to be removed or disabled after their expiry time, including across restarts.

## 14. Configuration model

`settings.yaml` defines unit-specific structure:

- unit identity
- hierarchy
- known appointments
- default admins
- attendance groups and statuses

Environment variables configure deployment and runtime behaviour, including credentials, reminder times, queue thresholds and rate limits.

Do not add a second configuration path for the same setting unless migration compatibility requires it. Where runtime admin overrides are supported, make the precedence explicit.

## 15. Failure modes

### Telegram unavailable

Attendance cannot be submitted through the bot, but existing local and Sheets state remains intact.

### Google Sheets temporarily unavailable

Already accepted attendance stays in the local queue and is retried. The user-facing write contract therefore does not depend on immediate Sheets availability.

### Process restarts

Durable local files are replayed. Pending queue events, transfer journals and cleanup jobs survive.

### Manual sheet reorder

Attendance is resolved again by appointment identity and date, avoiding stale row-number writes.

### Duplicate or malformed managed rows

Automatic repair stops rather than guessing which row represents the appointment.

### Partial roster update

Membership is reconstructed from the sheet/registry union unless there is explicit evidence of a deliberate deletion.

## 16. Changing the system safely

Changes to any of the following are high risk:

- attendance acknowledgement timing
- queue record schema or replay
- roster deletion
- appointment identity
- Telegram bindings
- appointment transfer
- admin authorization
- sheet structural maintenance
- reconciliation ambiguity handling
- credential handling

For these changes, tests should cover both the happy path and interruption/restart cases. A test that merely makes the final state look right is insufficient if the implementation can lose an acknowledged action in the middle.

The most important invariants are repeated here because they should remain obvious during maintenance:

1. Never acknowledge attendance before durable local persistence.
2. Never use a stale row number as appointment identity.
3. Never turn uncertain roster loss into automatic deletion.
4. Never overwrite spreadsheet content the bot does not own.
5. Never guess through ambiguous roster or binding state.
6. Keep retries and replay idempotent.
