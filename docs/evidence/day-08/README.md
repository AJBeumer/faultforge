# Day 8 evidence: review before you commit

Date: 12 November 2026. Tool: Qodo local review (`qodo review`, Agentic Toolbox CLI 2.x), standard or lite effort as Qodo chose (`auto` depth). Everything here is about this repository's own code, except the summary of the benchmark comparison in section 4, which gives results by letter and keeps the raw findings private until the final report.

The JSON files in `raw/` are Qodo's output, pretty-printed by the project formatter; the content is unchanged. The private repository holds the unformatted originals.

## 1. The ticket built uncommitted, reviewed before the commit (#126, PR 163)
- **What was reviewed:** the uncommitted diff against `main` (`d21666b`): three modified, unstaged files, about 22 KB in round 1 and 24 KB after the fix ([scope-evidence.txt](raw/scope-evidence.txt)). Context sent: the ticket's Done-when list and five decisions ([session-context.json](raw/session-context.json)).
- **Round 1, standard effort, two findings** ([review-1.raw.json](raw/review-1.raw.json)): a cleanup failure replaced the hook error and lost the report (real: three tests written first failed on the code, then passed after the fix), and the event is logged after the ticket is picked although the ticket says before (declined as intentional: the self-test needs the worktree that exists only after pickup).
- **Rerun on the updated, still-uncommitted code** ([review-2-after-fix.raw.json](raw/review-2-after-fix.raw.json)): no new finding. Both earlier findings were still listed as open until the owner marked one implemented and dismissed the other ([triage-outcomes.raw.txt](raw/triage-outcomes.raw.txt)), even though the decision was in the review context.
- **The PR review of the same change** ([round 1](raw/pr163-review-wait-round1.txt), [round 2](raw/pr163-review-wait-round2.txt)): the dismissed finding came back open (a local dismissal did not carry to the PR), and a new one said the PR text claimed a test for every bullet while the public artifact and the docs line had none. Three tests were added; `revert:check` shows the tests fail without the change ([pr163-revert-check.txt](raw/pr163-revert-check.txt)).

## 2. Staged, unstaged and untracked changes were all reviewed
One scratch worktree of this repository at the parent of commit `9829482`, with that commit's changes applied uncommitted and split three ways ([git-status-before-review.txt](raw/escaped-bug-refactor/git-status-before-review.txt)): one file staged (`M `), twelve modified but unstaged (` M`), four new files untracked (`??`). The CLI reported "Including 4 untracked file(s)" and 44,865 B of local changes. The review's two findings are on a staged file (`factory-tick.ts`) and an untracked file (`github.ts`) ([local-review.raw.json](raw/escaped-bug-refactor/local-review.raw.json)); section 1 covers the unstaged kind.

## 3. Would local review have caught the bug that reached `main`?
That same commit is the refactor that dropped `api` from one `gh` call, so a finished factory run failed on 12 November (#168). The local review of the uncommitted refactor, with the commit message as its "ticket", **did not flag it**. The PR review of that change at the time (PR 154, extended effort, four findings) did not flag it either, and neither did CI: no test reached the call with real arguments. Both reviews did flag the same different problem, the factory's evidence path escaping the private worktree (`factory-tick.ts:1376`). The two findings from this local run were not triaged.

What we did about it: a test that reads the harness sources and fails the build for a REST path passed to `gh` without `api` (PR 169). It does not catch a path held in a variable, and says so.

## 4. Local review against the answer key
Four planted bugs from adjudicated cases (A to D, FF-0003 to FF-0006) and two clean controls (E and F, FF-0002 and FF-0008). Each change was applied uncommitted in its own fresh worktree and reviewed locally, with the ticket linked as an issue the way the PR review had it; D was run twice. Scored with the project's fixed match rule.

| Case | Kind | Local review | PR review |
|---|---|---|---|
| A, B, C, D | bug | caught, one finding each on the planted line (D in both runs) | caught |
| E, F | control | no finding | no finding |

- **A trap, and the correction.** Qodo keeps a local review's open findings per working folder. A first attempt that reviewed five cases from one checkout carried a finding from one case onto unrelated changes, and a rerun that looked like independent agreement had only carried the first run's finding. That batch was discarded; each case then got its own fresh worktree.
- **Framing.** In the first run on D, where the ticket went in as plain notes (standard effort), the only finding was a test gap. In every later run, in a fresh stream with the ticket linked as an issue, it was a correctness finding about the raised limit: two runs at auto depth (lite), then three at `--fast` (lite) and three at `--deep` (extended), all six caught under the match rule. So the framing did not follow the effort level. The one different run also differed in how the ticket was attached, and one run cannot separate the two. (An earlier version of this README said the framing varied with effort; that was not supported.)
- Raw findings stay in private storage until the final report.

## Limits
Six cases, one review of each kind per case (D has more local runs), effort chosen by Qodo unless forced: a measurement of these cases, not a rate. The local review in section 3 reported `finding_state.complete: false` while `coverage.complete` was true; we do not know what the first means. A local dismissal not carrying to the PR is one observation.
