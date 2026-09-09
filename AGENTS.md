# Agent Notes

Read `docs/SYSTEM_LOGIC.md` before changing persistence, roster reconciliation, attendance writes, bindings or background sync.

Do not change these contracts accidentally:

- Attendance is persisted locally before acknowledgement.
- Queue replay is idempotent across retries and restarts.
- `ONBOARDING` controls visible roster order.
- Active membership is reconciled from `ONBOARDING` and the local appointment registry; a one-sided disappearance is not an automatic deletion.
- Attendance is resolved by appointment identity, not remembered row number.
- Human-owned spreadsheet content outside the managed area is preserved.
- Ambiguous roster or binding state fails closed.
- `settings.yaml` is the deploy-time source for unit structure and default attendance options.

Never commit credentials, spreadsheet IDs, bindings, attendance data, logs or runtime files from `data/`.

Tests must not contact live Telegram, Google Sheets, GitHub or a deployment unless explicitly requested.

Before handing over a change, run:

```bash
npm run check
npm test
find src -type f -name '*.js' -print0 | xargs -0 -n 1 node --check
```

Changes to bindings, admin access, roster deletion, queue replay, Sheets writes or credentials require an explicit security/data-integrity review and focused regression tests.
