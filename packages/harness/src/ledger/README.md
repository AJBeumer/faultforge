# ledger

The answer key (`ground-truth.jsonl`) and the audit log (`audit-events.jsonl`) in private storage. Both are
append-only: a correction is an amendment entry, never an edited line.

- `ledger.ts`: reads both. `ledger-append.ts`: the one writer. `ledger-schemas.ts`: each event's shape.
- `ledger-check.ts`: checks both against their schemas, the saved evidence and the anchors.
- `ledger-hashes.ts`: the input hash each tool writes into its event. `ledger-anchor.ts`: anchors the private
  history in this repo. `ledger-revise.ts`: records a template changed after its case was planted.

Entry points: `npm run ledger:check`, `ledger:anchor` and `ledger:revision` (in `cli/`).

Uses: `shared`, `review` (saved reviews).
