# inject

Plants a template's bug in a target checkout, on a branch whose name and commit read like ordinary work, after
checking that the template's proof test fails on the variant and passes without it.

- `inject-case.ts`: the command. `inject-run.ts`: runs the target's checks. `inject-checks.ts`: the proof.
- `inject-template.ts`: loads and checks a template. `benchmark-rules.ts`: the rules for benchmark templates.
- `branch-name.ts`: a free branch name. `base-tree.ts`: giveaway words in the base commit.

Entry points: `npm run inject` (`cli/inject.ts`).

Uses: `shared`, `guard`, `ledger`.
