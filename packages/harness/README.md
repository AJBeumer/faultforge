# The harness

The lab's own code: it plants a case, waits for Qodo's review, scores it against the answer key, records the
verdict, and runs the factory. `npm run <script>` starts every command; `package.json` names its file.

## Areas, in the order they may use each other

An area may import from the areas above it in this list, never from one below. `layout.test.ts` in `src/repo/`
checks it, so there is no import cycle between areas.

| # | Area | What it does |
|---|---|---|
| 1 | [`shared/`](src/shared/README.md) | Paths, config, the giveaway word list, the GitHub wrapper, JSON Lines, provenance, the CLI wrapper. |
| 2 | [`match/`](src/match/README.md) | The fixed match rule, and `npm run match`. |
| 3 | [`qodo/`](src/qodo/README.md) | Qodo's API: reading a review, the local-review API, `npm run qodo:check`. |
| 4 | [`review/`](src/review/README.md) | Waiting for a review and saving it, the review gate, the local review. |
| 5 | [`ledger/`](src/ledger/README.md) | The answer key and the audit log: append-only writes, checks, anchors, revisions. |
| 6 | [`door/`](src/door/README.md) | `npm run target:post`, the one way to write to a reviewed repo. |
| 7 | [`guard/`](src/guard/README.md) | Installs the git-level guard (`npm run guard:install`). |
| 8 | [`docs/`](src/docs/README.md) | `npm run docs:check`: public text and the docs' structure. |
| 9 | [`tickets/`](src/tickets/README.md) | Whether a ticket is ready, its premises, and writing to it. |
| 10 | [`inject/`](src/inject/README.md) | Plants a template's bug in the target (`npm run inject`). |
| 11 | [`case/`](src/case/README.md) | A case's ticket, PR, review and record (`npm run case:*`). |
| 12 | [`verdict/`](src/verdict/README.md) | The owner's verdict on a case, and its amendments. |
| 13 | [`rules/`](src/rules/README.md) | Evidence for Qodo's rules, and proposals for new ones. |
| 14 | [`factory/`](src/factory/README.md) | The unattended factory run: pick, workspace, agent, settle, recover. |
| 15 | [`proof/`](src/proof/README.md) | Proofs of review findings, their verifier, and the skill's exam. |
| 16 | [`repo/`](src/repo/README.md) | Checks on the repository as a whole, and the test launcher. |
| 17 | [`cli/`](src/cli/README.md) | The thin entry points `npm run` starts; each loads its area's body. |

`src/fixtures/` holds test support only. Slow tests live in `test/` ([README](test/README.md)).

## The hooks

The harness's code uses two hook modules: `.claude/hooks/shared/repos.ts` (which repos are reviewed) and
`.claude/hooks/answer-key/private-ids.ts` (private template ids). The hooks reach back only through
`.claude/hooks/shared/harness-bridge.ts`, which uses `shared/neutral.ts` and `door/target-post-run.ts`.

## Adding a module

Put it in the area that owns its subject, with its test next to it as `<name>.test.ts`. If it needs an area
below its own, the module belongs lower, or the shared part moves down. No module passes 400 lines.
