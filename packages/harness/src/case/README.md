# case

One case end to end, after `inject`: its ticket, its PR, its saved review, and its public record.

- `case-ticket.ts` and `case-pr.ts`: the target ticket and the PR, sent through the door.
- `case-review.ts`: records the saved review in the audit log. `case-rerun.ts`: marks a case as a rerun of
  another, by an amendment.
- `case-build.ts` with `case-builder.ts`, `case-overlay.ts`, `case-record.ts`, `case-save.ts` and
  `record-print.ts`: builds the record from the saved evidence, and saves it to private storage.

Entry points: `npm run case:ticket`, `case:pr`, `case:review`, `case:rerun` and `case:build` (in `cli/`).

Uses: `shared`, `match`, `qodo`, `review`, `ledger`, `door`.
