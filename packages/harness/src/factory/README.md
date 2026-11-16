# factory

The unattended factory run: one tick picks a ready ticket, builds a workspace, starts the agent under the
hooks, and settles what it left: a PR with Qodo's review and evidence, or a clear failure.

- The tick: `factory-tick.ts` with `factory-tick-*.ts`, `factory-deps.ts` (its real dependencies),
  `factory-finish.ts`, `factory-settle.ts`, `factory-verify.ts` and `factory-gates.ts` (the owner's gates).
- The workspace and the agent: `factory-workspace.ts`, `factory-agent*.ts`, `factory-sandbox*.ts`,
  `factory-hooks.ts` (the hooks' self-test), `factory-private.ts`, `trusted-checkout.ts`, `git-control.ts`.
- Locks and recovery: `factory-lock.ts`, `factory-process.ts`, `factory-kill.ts`, `factory-recover*.ts`.
- Evidence and the run log: `factory-evidence.ts`, `factory-keep.ts`, `factory-audit.ts`, `factory-timeline.ts`.
- GitHub: `factory-comments.ts`, `factory-relabel.ts`, `ticket-snapshot.ts`, `factory-review-broker.ts`,
  `factory-door-run.ts`, `factory-check-files.ts`, `factory-exec.ts`.
- `revert-check.ts` with `revert-run.ts`: the revert checks. `alert.ts`: the lab's alert issues.

Entry points: `npm run factory:tick`, `factory:timeline`, `factory:recover` (in `cli/`); `factory:keep`
(`factory-keep.ts`), `factory:sandbox` (`factory-sandbox-setup.ts`), `revert:check` (`revert-check.ts`).

Uses: `shared`, `qodo`, `review`, `door`, `guard`, `tickets`, `rules`.
