# review

A PR's review, waited for and saved as evidence, and the checks built on it.

- `review-wait-run.ts`, `review-poll.ts`, `review-feeds.ts`: wait for Qodo's review of an exact commit and save
  it. `saved-review.ts`: where a saved review lives and how it is read, for every reader.
- `review-gate.ts` with `review-gate-cache.ts` and `review-gate-records.ts`: whether a commit's tree was
  covered by a completed local review.
- `gate-check.ts`: whether a PR's saved review meets the quality gate in `factory.json`.
- `approval-check.ts` with `approval-rule.ts`: whether Qodo's "approved" label on a PR is backed by the saved
  review, the gate, the guarded paths (`approval` in `factory.json`) and CI.
- `review-local.ts` with `local-*.ts`: Qodo's review of a local diff, before a PR.
- `ci-wait.ts`: a commit's checks on every operating system, on a scratch branch, before a PR sees it.
  `ci-wait-verdict.ts`: its pure rules (which runs are its own, what passed, which remote is the repository).
  `ci-wait-origin.ts`: whether `origin` can send a push anywhere but the configured repository.

Entry points: `npm run ci:wait` (`cli/ci-wait-cli.ts`), `npm run review:wait` (`cli/review-wait.ts`), `npm run review:gate` (`review-gate.ts`), `npm run gate:check` (`cli/gate-check-cli.ts`),
`npm run approval:check` (`cli/approval-check-cli.ts`), `npm run review:local` (`review-local.ts`).

Uses: `shared`, `match`, `qodo`.
