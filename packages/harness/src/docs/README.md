# docs

`npm run docs:check`: public text never names a case before its verdict, or a held-out one at all; and the docs
keep their shape: short pages, every link resolving, every page listed on the start page.

- `docs-check.ts`: the case and template ids, checked against private storage.
- `docs-check-structure.ts`: page length, links and the start page's list.

Entry points: `npm run docs:check` (`cli/docs-check-cli.ts`).

Uses: `shared`, `ledger`.
