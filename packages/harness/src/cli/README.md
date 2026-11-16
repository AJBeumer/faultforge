# cli

The thin entry points `npm run` starts. Each imports only `shared/cli-entry.ts` and loads its area's body
inside it, so an error even while the body loads ends as the command's documented exit code (AUD-N3).

`<name>-cli.ts` loads `<name>.ts` from its area: `case-*` from `case/`, `ledger-*` from `ledger/`,
`verdict*` from `verdict/`, `factory-*` from `factory/`, and so on. `inject.ts` loads `inject/inject-case.ts`;
`review-wait.ts` loads `review/review-wait-run.ts`, or asks the factory's broker during a run.

A command with its own body and no split entry (`review-gate.ts`, `qodo-check.ts`, `rules-*.ts`, ...) lives in
its area; `package.json` names each file.

Uses: every area it starts. Nothing imports `cli/`.
