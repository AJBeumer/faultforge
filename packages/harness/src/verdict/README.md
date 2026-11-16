# verdict

The owner's verdict on a case, applied with the fixed match rule and recorded in the audit log.

- `verdict.ts`: the command. `verdict-inputs.ts`: what it reads. `verdict-ask.ts`: the owner's confirmation.
- `verdict-event.ts`: the event it writes. `verdict-amend.ts`: an amendment, never an edit.

Entry points: `npm run verdict` and `npm run verdict:amend` (in `cli/`).

Uses: `shared`, `match`, `review`, `ledger`.
