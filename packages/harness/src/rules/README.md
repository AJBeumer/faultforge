# rules

Qodo's review rules, measured: which findings each rule produced across the saved reviews, and proposals for
new rules as lab tickets.

- `rules-evidence.ts`: one table of every finding and the rule behind it.
- `rules-propose.ts`: proposes rules from that table.

Entry points: `npm run rules:evidence` (`rules-evidence.ts`), `npm run rules:propose` (`rules-propose.ts`).

Uses: `shared`, `qodo`, `review`, `ledger`.
