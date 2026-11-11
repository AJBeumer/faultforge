# Day 7: Review Resolver on PR #149, with a blind second reviewer

PR: [#149](https://github.com/AJBeumer/faultforge/pull/149), ticket #147 (the stale-premise gate from Day 6), built in an interactive session so that the findings arrived unresolved. Five Qodo reviews between 19:13 and 19:40 UTC on 11 November. Final reviewed commit `36e6812`, complete, CI green.

**Method.** After every push, Qodo's findings were read through the Review Resolver tool (`qodo read pr-review-session findings --extended`; the first and last reads are [pr149-findings-round1.json](pr149-findings-round1.json) and [pr149-findings-final.json](pr149-findings-final.json)) and saved by `review:wait` in private storage. Before Qodo's first findings were read, a fresh subagent with no Qodo access reviewed the same diff and wrote [blind-review-pr149.md](blind-review-pr149.md). For every finding from either reviewer the rule was: write the reproduction test first; a failing test means fix, a passing test means leave it, with the test as the reason. The policy for writing outcomes back to Qodo was recorded in the decision log before any finding was touched (owner runs `mark-implemented`, `dismiss` only as "intentional" with the reason on the PR, never on the target).

## Qodo's findings, round by round

| id | round (commit) | severity | what | verdict | reproduced by a failing test first | blind reviewer |
|---|---|---|---|---|---|---|
| 7f4ea6d8 | 1 (5defd68) | action-required | checks the owner's working tree, not `main` | fixed: all reads go through git at `origin/main` | yes (file only in the working tree) | B1, same |
| 70e82959 | 1 | remediation | message omits where it looked | fixed: "not found on origin/main of the ticket's repo or N sibling repos" | message-only | noted |
| 93cf10ea | 1 | remediation | `./private/...` not skipped | fixed | yes | no |
| ffeaef1a | 1 | remediation | `npm run x -- args` unchecked | fixed | yes | B4, same |
| 0021805e | 1 | remediation | symlink recursion in the file walk | fixed by design: git's tree, no walk; private walk skips links | by design | B6, same |
| 1a1d2153 | 1 | remediation | exports accepted from anywhere, not the two folders the ticket names | left: repo-agnostic by intent; now limited to git-tracked source files at `main` | no | B9, same |
| 4222515e | 1 | remediation | `../outside.ts` can pass | fixed by design: not in the tree | message-only | no |
| a4abd903 | 1 | remediation | a missing clone throws and the runner re-picks the ticket | **left unchanged**, reason on the PR; still `pending` in Qodo | no | B6 (second half), same |
| c11c70fe | 1 | remediation | indented fences and `<details open>` not stripped | fixed | yes | B10, same |
| d842a7dd | 1 | remediation | deliverable sections skipped; look-back over-skips | half: look-back now stops at the clause; sections stay skipped by design | yes (look-back) | B2, sharper |
| f0e9e8bc | 1 | remediation | a sibling repo hides a missing premise | left in substance: cross-repo mentions are legitimate; sibling now consulted only on a miss and named in the message | no | no |
| d9d5efe7 | 2 (6dfcdfc) | action-required | `origin/main` may be unfetched | fixed: `git fetch origin main` before every check, failure is exit 2 | yes (refresh called; failure throws) | no |
| f729fd7b | 2 | action-required | multi-line imports invisible to a line grep | fixed: whole files via `git cat-file --batch` | yes | no |
| 0b1c5e60 | 3 (18ee367) | action-required | batch parsed by characters, sizes are bytes | fixed: byte offsets, per-blob decode | yes, once the fixture was big enough to drift past a header | no |
| ed975c13 | 3 | action-required | an unreachable sibling halts a check that never needed it | fixed: siblings fetched and read only on a miss | yes | no |
| 57b44343 | 4 (d306850) | action-required | the commit did not compile | fixed; my fault, see below | CI and `tsc` | no |
| adf6b2e1 | 4 | action-required | same commit, second symptom | fixed | CI and `tsc` | no |

Round 5 (`36e6812`): 0 findings. Qodo's own attribution at the end: 16 `implemented`, 1 `pending` (a4abd903). Two of the 16 (d842a7dd, f0e9e8bc) I count as half or not changed; attribution is Qodo's reading of the diff, not the adjudication.

## The blind reviewer

12 findings on the first diff (3 must fix, 4 should fix, 5 nits), written before any Qodo finding was read.

- **6 overlapped Qodo's** (B1, B2, B4, B6, B9, B10). Both reviewers put the same defect first: the gate read the owner's checkout instead of `main`.
- **Unique to the blind reviewer, all reproduced and fixed:** `node:fs` and GitHub qualifiers read as missing npm scripts (B3); `main()` and `existsSync()` reported stale because only exports were indexed (B5); the "new" look-back crossing line breaks (B2's sharper half); bare names of private files such as `BACKLOG.md` always stale (B7); other export forms (B8); Out of scope scanned as premises (B12). B11 (case-insensitive `existsSync` on Windows) was fixed by design once reads went through git.
- **Unique to Qodo:** the message's missing location, `./private`, `../outside`, the sibling hiding a miss, and everything from rounds 2 to 4, which the blind reviewer never saw.

Qodo's round-1 unique findings were edge cases of my code. The blind reviewer's unique findings were the ones that would have blocked ordinary tickets in this repository (`node:fs`, `main()`, `BACKLOG.md`). Neither list contained the other.

## What the tests decided

Before the round-1 fixes, 14 of the 24 new tests failed on the original code, 9 of them for behaviour and 5 for the new message text only. Before the round-2 fixes, 6 failed, 2 for behaviour. Before the round-3 fixes, 5 failed, 3 for behaviour. `npm run revert:check -- faultforge 149` at the final commit: 7 tests fail without the change.

## A mistake, recorded

Commit `d306850` did not compile. The command that produced it ran `npm run check`, piped its output through `grep`, and then committed and pushed on the pipeline's exit code, which was `grep`'s. Qodo's fourth review reported the two compile errors within a minute of the push, and CI failed. The next commit fixed it and the chain was changed to commit only on the check's own exit code. It belongs in the record because it is exactly the kind of failure the lab exists to measure.

## Tool observations

- `qodo read pr-review-session findings --extended` returned every finding with `attribution_status`, `git_sha`, `evidence` and `location`; the trailing `trace` line is indented and has to be stripped before parsing.
- Attribution moved to `implemented` on its own after each push, including for two findings that were only half addressed. A reviewer's attribution is a hint, not a verdict.
- Review effort was `standard` on commits with code changes and `lite` on the one-line fix and the skill-text PR earlier in the day.
