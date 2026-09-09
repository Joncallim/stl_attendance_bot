# System Logic and Reimplementation Specification

This document defines the behaviour of the attendance system independently of JavaScript, Telegraf and the Google client library. A replacement implementation in another language should preserve the contracts here even if its internal structure is different.

## 1. External boundaries

The system has three persistent boundaries:

1. **Telegram** — commands, callbacks, prompts and notifications.
2. **Google Sheets** — the human-visible attendance workbook.
3. **Local durable storage** — accepted-but-not-yet-synchronised attendance, roster/binding state, recovery journals and cached sheet snapshots.

Local durable storage is part of the correctness model. It cannot be replaced with process memory unless the replacement provides equivalent crash durability.

## 2. Domain model

### Appointment

An appointment is the stable operational identity used by the attendance system. Attendance belongs to an appointment, not to a Telegram user or spreadsheet row.

Required properties are the appointment name, active/removed state, onboarding code, optional Telegram binding, hierarchy assignment and admin status where applicable.

Appointment-name comparison is normalised consistently before identity checks. A port must choose one normalisation rule and apply it at every storage boundary.

### Telegram user

A Telegram user record identifies a chat/account and may be bound to one appointment. Conversation state and pending interactions are user state, not roster identity.

### Attendance entry

The logical key is:

```text
(appointment, calendar date)
```

The value is one configured attendance status. Spreadsheet row and column numbers are locations discovered at write time; they are not part of attendance identity.

### Attendance event

A submitted attendance change becomes a durable event before acknowledgement. At minimum an event needs a unique ID, idempotency key, appointment, date, status, creation time and enough metadata to detect unsafe layout changes during flush.

### Roster

Roster order and roster membership have different recovery rules. Visible order comes from `ONBOARDING`; membership is reconciled with the local appointment registry so an interrupted one-sided write is not mistaken for deletion.

## 3. Sources of truth

| Data | Authority / reconciliation rule |
| --- | --- |
| Roster display order | Visible managed order in `ONBOARDING` |
| Active roster membership | Safe reconciliation of `ONBOARDING` and local appointment registry |
| Deliberate removal | Explicit recorded removal intent; absence on one side is insufficient |
| Telegram binding | Mirrored local user/registry state; repair only when identity is unambiguous |
| Acknowledged attendance not yet flushed | Durable attendance queue |
| Synchronised attendance | Google Sheets, subject to unresolved newer queued events |
| Unit hierarchy/default statuses | `settings.yaml` |
| Runtime attendance-option overrides | local settings state |

This distinction is essential. A port that declares either the spreadsheet or local files universally authoritative will change failure behaviour.

## 4. Spreadsheet contract

### `ONBOARDING`

Managed fields:

- column A: appointment name
- column B: onboarding code

The visible managed appointment order is canonical. Other cells are not implicitly owned by the application.

### Monthly worksheets

A worksheet represents one calendar month, for example `Sep 26`.

Managed coordinates are discovered from:

- appointment names in column A
- date headings in row 1

The application manages only the intersection of known appointments and recognised date columns. It must not overwrite unrelated rows or columns.

Before a write, resolve the current row from appointment identity and the current column from the date heading. Never persist a row number for later use as identity.

Duplicate or otherwise ambiguous managed rows are an error. Do not choose one heuristically.

## 5. Startup sequence

Startup order is semantically significant where later components depend on earlier configuration:

1. create/secure the local data directory and files
2. configure networking
3. initialise logging
4. load deploy-time configuration and stored runtime overrides
5. recover incomplete local storage transactions
6. construct Sheets and Telegram clients
7. initialise/reconcile required sheet structures and caches
8. recover durable queue, transfer and message-cleanup state
9. register handlers and scheduled work
10. start Telegram long polling

Required configuration and corrupt safety-critical state should fail visibly. Do not silently manufacture replacement state unless the fallback is explicitly defined.

## 6. Onboarding and binding

Each active appointment has a secret code. The code identifies the appointment; it is not a user password.

Binding sequence:

1. user begins onboarding
2. supplied code is normalised and resolved to one active appointment
3. verify that the appointment is not bound to another Telegram identity
4. persist the binding consistently in local state
5. only then report successful onboarding

Deregistration clears the binding and rotates the code so the previous code cannot reclaim the appointment.

Binding reconciliation may repair a missing mirrored record only when the surviving record identifies one unambiguous appointment/user pair.

## 7. Daily attendance transaction

This is the principal durability contract.

```text
receive Telegram action
        |
validate actor, binding, date and status
        |
construct attendance event
        |
append + fsync durable queue record
        |
update process cache
        |
acknowledge user
        |
background flush
        |
resolve live sheet coordinates
        |
batch write to Sheets
        |
record durable queue outcome
        |
update cached sheet state
```

The acknowledgement boundary is after durable local persistence and before remote Sheets completion. Moving it earlier permits acknowledged data loss; moving it after Sheets makes Telegram responsiveness depend on Sheets availability.

### Queue state machine

An implementation may encode this differently, but it must represent these outcomes:

- `pending` — accepted locally, not yet resolved remotely
- `failed_retryable` — transient flush failure with retry schedule
- `conflicted` — cannot safely resolve against current sheet structure
- `flushed` — remote write completed
- `skipped_noop` — remote state already represents the requested logical value
- `failed_permanent` — bounded retry policy exhausted

Queue history is append-oriented so a crash cannot rewrite the only copy of an accepted event. Compaction is allowed only when malformed/incomplete records have been ruled out and the logical state of retained events is preserved.

### Idempotency and coalescing

Replaying the same logical event must be safe. A retry must not create a second attendance fact.

For multiple unresolved values targeting the same `(appointment, date)`, the newest valid submission may supersede older queued values. Supersession must be explicit and deterministic.

### Retry policy

Network/time-out failures use bounded backoff. Structural ambiguity is not a retryable network failure and must enter a conflict path instead of repeatedly writing against uncertain coordinates.

## 8. Weekly attendance

Weekly entry is a user-interface transaction over Monday through Friday. It stages choices and then emits ordinary per-date attendance events through the same durable queue.

Required behaviour:

- support month and year boundaries
- use calendar dates rather than weekday indexes as stored identity
- preserve an existing value when the user skips a day
- allow a staged value to replace an earlier staged value for the same date
- mark Singapore public holidays as `PH`
- submit final changed dates through the normal attendance durability path

A port must not create a separate, weaker persistence path for weekly attendance.

## 9. Queue-to-Sheets flush

A flush performs the following logical work:

1. load eligible unresolved events
2. apply retry timing and terminal-state rules
3. coalesce superseded values by `(appointment, date)`
4. obtain sufficiently fresh sheet structure
5. resolve each appointment/date to current coordinates
6. reject ambiguous/missing managed structure as conflict
7. compare with current remote value where needed to identify no-op writes
8. batch compatible writes
9. record each event outcome durably
10. update local sheet snapshots

If the process dies after the Sheets request but before local outcome recording, replay must converge safely. This is why idempotent logical writes are required.

## 10. Roster reconciliation

Reconciliation repairs expected drift without interpreting uncertainty as intent.

Rules:

- `ONBOARDING` controls visible order
- membership is recovered from both `ONBOARDING` and the local registry
- a one-sided missing appointment is normally restored
- automatic deletion requires explicit removal evidence
- bindings are repaired only from an unambiguous surviving copy
- managed month rows are aligned by appointment identity
- unmanaged spreadsheet content is preserved
- duplicate/malformed managed structure stops automatic repair

The desired failure mode is an explicit unresolved condition, not a plausible-looking destructive guess.

## 11. Synchronisation scheduler

Only one logical sync cycle should own the Sheets reconciliation path at a time.

A cycle may include queue flush, onboarding refresh, admin/cache refresh and month-snapshot refresh. Requests can differ in strength: routine refresh, explicit flush, foreground read, reminder preparation or forced reconciliation.

If a stronger request arrives during an existing weaker cycle, retain the stronger requirements and run a follow-up cycle. Do not silently drop them.

Structural maintenance may temporarily exclude ordinary sync work. Durability-critical or foreground requests arriving during that window must be retained and replayed afterward.

## 12. Interactive priority and rate control

User interactions take priority over broadcasts and nonessential background reads.

Telegram sends use a process-wide dispatcher with:

- bounded concurrency
- minimum launch spacing
- bounded retry for rate limits/transient server failures
- a shared pause after Telegram requests a retry delay
- checks immediately before launch so a newly arrived user interaction can pre-empt queued broadcast work

Sheets requests are serialised/rate-limited and background requests yield at safe request boundaries while interactive work is active. An in-flight remote request is allowed to finish rather than being cancelled mid-operation.

The exact concurrency primitives are language-specific; the observable ordering and fairness rules are not.

## 13. Scheduled work

Default scheduled behaviour includes:

- regular background sync/cache refresh
- forced reconciliation every five minutes
- 07:00 reminder to all bound users
- 08:00 reminder only to users still blank
- daily structural/queue maintenance
- restart-safe cleanup of temporary Telegram controls

Reminder jobs run only on working weekdays and skip Singapore public holidays. They refresh sufficient attendance state before deciding who is blank.

## 14. Appointment transfer transaction

Transferring an appointment can touch attendance, bindings and source/destination state. It is a multi-step transaction across systems that do not share a database transaction.

Before the first irreversible step, persist a transfer journal containing source, destination, expected source binding identity and phase.

Advance the journal after each durable phase. Clear it only when the complete transfer is known to have finished. On startup, an existing journal means recovery is required before another transfer can begin.

The journal prevents a crash between attendance copy, binding change and source cleanup from becoming an invisible half-transfer.

## 15. Local durability requirements

Local state containing bindings, queue records or recovery journals should be private to the service account/process user.

Whole-file JSON writes use atomic replacement: write a temporary file, flush it, rename it over the destination, then synchronise the parent directory where supported.

Append-only queue records are flushed before acknowledgement. Record checksums detect corruption. A truncated final append may be ignored for non-destructive recovery while its bytes remain on disk; destructive compaction must refuse to proceed when malformed records exist.

Serialise writes that target the same logical file/state domain. A language port may use mutexes, actors, a transactional embedded database or another mechanism, but must preserve atomicity and ordering.

## 16. Telegram interaction state

Callback payloads should contain opaque interaction/choice identifiers rather than full privileged operation parameters.

Server-side pending interaction state records:

- interaction ID and kind
- actor chat/user identity
- allowed choices
- operation payload
- creation/expiry time
- pending/consumed state

On callback, verify actor, kind, expiry and allowed choice before executing. Consumed or expired interactions cannot be replayed. Text-input workflows use the same ownership and expiry model.

## 17. Caching

Caches exist for latency and quota control; they do not replace identity checks at dangerous write boundaries.

Typical cached data includes users, spreadsheet metadata, onboarding slices and monthly attendance slices. A foreground display may use cached state, but a structural write or reconciliation that depends on current layout must obtain the freshness required by that operation.

A port may choose different TTLs or cache technology if it preserves correctness, quota limits and interactive responsiveness.

## 18. Configuration precedence

`settings.yaml` defines deploy-time unit structure and default attendance groups. Environment variables define credentials and operational tuning. Supported runtime admin overrides are stored locally.

For any setting with more than one source, define and document deterministic precedence. Do not introduce parallel configuration mechanisms for the same concept without a migration reason.

## 19. Failure matrix

| Failure | Required behaviour |
| --- | --- |
| Telegram unavailable | No new Telegram actions; persisted state remains intact |
| Sheets unavailable | Already acknowledged attendance remains queued and retryable |
| Process crash/restart | Replay durable queue, journals and cleanup jobs |
| Crash after Sheets write before queue completion record | Replay converges idempotently to the same remote value |
| Manual row reorder | Re-resolve by appointment name/date before writing |
| Duplicate managed appointment rows | Stop automatic write/repair for ambiguous target |
| One-sided roster disappearance | Restore surviving membership unless explicit removal exists |
| Conflicting binding copies | Stop and surface conflict; do not guess owner |
| Corrupt/truncated queue tail | Preserve bytes; recover complete records; block destructive compaction if malformed data remains |
| Rate limiting | Respect bounded retry/backoff without starving interactive work |

## 20. Module map in the current implementation

The module boundaries are useful when reading the JavaScript implementation but are not required in a port:

- `index.js` — process lifecycle
- `bot.js` — Telegram presentation and workflow orchestration
- `googleSheets.js` — workbook adapter, reconciliation and structural maintenance
- `attendanceQueue.js` — attendance event log/state machine and flush coordination
- `storage.js` — users, registry, settings and local transactions
- `fileStore.js` — atomic/private file primitives
- `syncManager.js` — sync coalescing and scheduling state
- `concurrency.js` — Telegram dispatch/rate limiting
- `workPriority.js` / `broadcastActivity.js` — foreground/background arbitration
- `attendanceTransferJournal.js` — transfer recovery journal
- `telegramInteractions.js` — callback/text interaction capability state
- `weeklyFlow.js` / `holidays.js` — weekly-domain logic
- `messageCleanup.js` — durable Telegram-control expiry
- `config.js` — configuration loading/validation

## 21. Reimplementation checklist

Before replacing the current implementation, demonstrate all of the following against the new version:

1. An acknowledged attendance submission survives immediate process termination.
2. Replaying a write after an uncertain remote result does not duplicate or corrupt attendance.
3. A manually reordered month sheet still receives attendance in the correct appointment row.
4. A one-sided roster loss is repaired rather than deleted.
5. An explicit roster removal remains removed after reconciliation.
6. Duplicate managed rows stop unsafe automatic writes.
7. A bound appointment cannot be claimed by another Telegram identity.
8. Deregistration rotates the onboarding code.
9. Weekly submission uses the same durable attendance path as daily submission.
10. Month/year boundary weeks resolve the correct worksheet/date columns.
11. Public holidays suppress reminders and resolve as `PH` in weekly attendance.
12. Background broadcasts and Sheets work yield to interactive Telegram work.
13. Rate-limit retry is bounded and globally coordinated.
14. Transfer recovery resumes or reports an interrupted transfer without silently starting a second one.
15. Queue compaction cannot erase malformed/unrecovered records.
16. Human-owned spreadsheet cells outside the managed region remain unchanged.

These are behavioural acceptance criteria. Passing them matters more than reproducing the current class, function or file structure.