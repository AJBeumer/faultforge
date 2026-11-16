# Decision log, week 3 (16 to 22 November)

Part of the [decision log](../decision-log.md). Entries are copied verbatim, in order.

## 16 November: Qodo configuration v11, web search off

Recorded before any case runs under it.

- **Web search is off.** The 15 November entry listed web search during review as the one channel verified open: a review could search the public web, this repository included. The owner switched it off at workspace level. Qodo's settings then showed it off for this repository and for `faultforge-target`, with no override for either. The screenshots are in private storage. A separate Qodo workspace for this repository was the other option. It was not chosen, because it would leave this repository public and searchable, and the trial ends this week.
- **4 new rules, scoped to this repository only.** Qodo wrote them by itself from this repository's `CLAUDE.md` after PR 351 described the door for target writes, and they are active. The rules that reach the target are unchanged, compared by id, name, content, state, scope and severity. `qodo:check` matches v11.
- **The 15 November unexplained rules, likely explained.** These 4 rules were created hours after Qodo's settings showed "auto-approve rules from repository files" off, and they are active anyway. So Qodo activates rules it imports from repository files even with that setting off. That is the likely route for the 7 charter rules recorded as unexplained. It is observed behaviour, not documented.
- **Comparability.** Every case so far ran with web search on. Cases under v11 are reported as their own group, never pooled with earlier results.

## 16 November: a layout a person can work in, and Qodo configuration v12

The eighth independent re-grade scored Maintainability 6. The owner decided that maintainability comes before further security work, with no change to behaviour.

- **Docs (#354, PR 357).** A start page, `docs/README.md`, maps every doc. The charter and this log are split into short pages, the README is under 100 lines, and `CLAUDE.md` keeps each hard rule as one bullet with a link to the page that explains it. Content was moved, not reworded, and a word-for-word comparison is in the PR. `docs:check` now holds every page to 150 lines, checks every link, and checks that the start page links every doc.
- **Hooks (#355, PR 358).** The guard's modules sit in folders by job, with a one-page map. Test files are named for the behaviour they test rather than the audit round that found it. Dependencies on the harness go through one bridge module. Hook code may not grow past 7,001 lines without a reviewed change to that budget.
- **Harness (#356, PR 359).** 223 files in one folder became 17 area folders, each with a short README. The areas depend on each other in one direction.
- **Tests.** Every test that existed before still exists, under the same title. The two PRs added 11 tests for the new structure (3,072 to 3,083).
- **Qodo configuration v12.** Qodo changed its own rules for this repository after the charter and `CLAUDE.md` were restructured. It removed the 8 rules it had written from the charter and 2 from `CLAUDE.md`, reworded 5, and set one muted rule active again. Nobody on the project made these changes. The rules that reach the target are unchanged, web search stays off, and `qodo:check` matches v12. No case ran under v11, so no result is affected. It is the third time a rule for this repository became active without anyone approving it.

## Day 9: Set up quality gates

*Recorded 16 November, four days after the challenge was set.*

- **Challenge requirement:** save a quality gate where the factory reads it (fix every valid High and Medium finding, report every Low one), try it on a small change, loop review and fix until the gate is met, and report the task as not done when a finding at or above the threshold is open, verification is incomplete or the loop stalls.
- **Increment delivered:**
  - **One gate, as data, enforced by the runner** ([PR #378](https://github.com/AJBeumer/faultforge/pull/378), ticket #374). The gate is the `gate` section of `factory.json`: fix `action_required` and `remediation_recommended`, flag `informational`, block on any other label, three review rounds at most. The agent's instructions are written from that data. The runner applies it itself, from Qodo's record and a fresh checkout of `main`, whatever the agent reports. It also refuses a review of another commit, an unfinished review, and a pull request that took more rounds than allowed. `npm run gate:check` prints the account for a pull request. Until this change the runner blocked only on `action_required`. The gate is not in `AGENTS.md` or `CLAUDE.md`, because Qodo reads those as rules and that would be a new configuration version. [How it works](../quality-gate.md).
  - **The threshold checked against known answers** ([PR #379](https://github.com/AJBeumer/faultforge/pull/379) and [PR #380](https://github.com/AJBeumer/faultforge/pull/380), ticket #375). `npm run gate:replay` applies the gate to the saved reviews of adjudicated cases.
  - **The gate checked by its outcome** (ticket #376). `npm run gate:trial` applies an adjudicated case's change, uncommitted, in a scratch copy that can't push. Qodo's local review reads it with the ordinary ticket, the gate decides, and a builder agent that is told only the ticket and the findings fixes what the gate says to fix. When the loop stops, the case's proof tests run. Neither the reviewer nor the builder saw them.
- **What changed from the plan and why:**
  - **PR #379 never reached `main`.** It was stacked on PR #378 and merged into that branch two minutes after the branch had gone into `main`. PR #380 brings the same commits to `main`.
  - **The trial asks for a review again when the reviewer answers with an error.** Two runs ended that way and said nothing about the gate.
  - **Not built today:** a check of a ticket for open questions before the agent builds (ticket #377), and a live factory run under the new gate.
- **Tests and Qodo evidence:**
  - **The gate on its own pull requests.** PR #378: three rounds, 5 Medium, then 5 new Medium on the fixes, then none; 2 Low flagged and left unchanged; gate met at the last allowed round. PR #379: three rounds each raised a new Medium finding, so after round 3 it was reported as not done; the owner asked for the fix, and round 4 had nothing open. PR #380, the same code as a new pull request: Qodo raised 4 Medium findings it had not raised on PR #379, then 1 more, then none; gate met at round 3. All 19 Medium findings on the three pull requests were valid and fixed with a test. None was disputed.
  - **Replay, on the cases this log names.** 14 bug runs, all caught by the reviewer, and 8 controls. Under "fix High only", 4 of the 14 would have been called done with the planted bug in: FF-0012, FF-0015, FF-0016 and FF-0019, three distinct bugs, because FF-0019 reruns FF-0015. In each the finding that describes the bug was labelled Medium. All four ran under configuration v9 (4 of 9 runs there; 0 of 2 under v8, 0 of 2 under v10, 0 of 1 for FF-0001). Under the saved gate none passes. The cost is 2 more findings to act on across the bug runs and none on the controls. No finding in these reviews was labelled Low.
  - **Trials, their own group, under configuration v12.** Ten runs on three bug cases and two controls. Two ended on a reviewer error and are not counted.

    | Case | Gate | How the loop ended | What the proofs say |
    |---|---|---|---|
    | FF-0012 | High only | done at round 1: one finding on the bug, labelled Medium | defect still there |
    | FF-0012 | saved | not done at round 2: the builder disputed a finding with a test that passes | defect still there |
    | FF-0015 | High only | done at round 2: the bug was labelled High and fixed | defect gone |
    | FF-0015 | saved | done at round 2: two Medium fixed, one Low flagged | defect gone |
    | FF-0016 | High only | done at round 2: the bug was labelled High and fixed | defect gone |
    | FF-0016 | saved | done at round 2: one Medium fixed | defect gone |
    | FF-0009, control | saved | done at round 1: no finding | nothing broken |
    | FF-0011, control | saved | done at round 1: one Low flagged, code unchanged | nothing broken |

    In no run did a fix break a proof that passed before, and the target's own tests passed after every run. The builder ran 7 times, 11.30 USD in all.
  - **The label is not stable.** The three bug changes were reviewed locally 8 times in their first round today. The finding on the planted bug was labelled High in 4 and Medium in 4. Their pull-request reviews on 13 November had labelled all three Medium.
  - **Checks.** `npm run check` passed on every pushed commit, 3265 tests on the last. CI was green on Linux and Windows for PR #378 and PR #379. `revert:check` showed 8 tests of PR #378 fail without the change. It could not judge PR #379: its only tests are for a module the pull request adds.
- **Lesson or decision:**
  - **The threshold is High and Medium, and now there is a measured reason.** A High-only gate called FF-0012 done with the defect in, and whether it does so depends on which label a run happens to draw.
  - **Meeting the gate is not the same as being right, and the gate knew its limit.** In FF-0012 under the saved gate the builder fixed the finding in round 1. The round 2 review then held the change to the ticket's own words, the builder took the fix out again, and it disputed the next finding. The loop stopped as "the owner must decide". The proof says the defect was still there. The ticket and the invariant disagree, and no review loop can settle that.
  - **A new pull request is a new review.** The same code drew 5 findings on PR #380 that four rounds on PR #379 had not. A clean review says that one run found nothing.
  - **A round limit needs a person behind it.** Two of three pull requests reached round 3. One of them needed a fourth, which the owner allowed.
- **Remaining risk:** these are a handful of runs, not rates: one run per arm, three bugs, two controls. The builder could not run the target's formatter, which its tool list left out. The trial's builder and the lab's agent are the same model. Local review and pull-request review are different reviews, so a trial says nothing certain about a factory run. The two Low findings on PR #378 are open for the owner: an upper-case commit id in `gate:check`, and slow tests in the unit suite.
