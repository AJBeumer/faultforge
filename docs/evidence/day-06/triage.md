# Backlog triage, 11 November 2026

All 49 open tickets (`raw/triage-open-issues.json`, listed through Qodo at `0b84165`), judged by one question: do the files, scripts and behaviours the ticket names exist on `main`? Evidence for the week-1 and process tickets is in `claims.md` (C6, C12) and the local checks noted here. Week 2 to 4 tickets are planned work that has not started, which is the expected state; they are listed for completeness.

## Week 1 tickets (6 Nov)

| Ticket | State on main | Evidence | Action |
|---|---|---|---|
| #2 Block unreviewed case names in public issues and PRs | not started | no hook reads names from private storage (`grep ground-truth\|private/templates` in `.claude/hooks/`: no hits) | keep |
| #4 Check Qodo's setup before each case | not started; a manual step since 6 Nov | C6, C7; no `qodo-check.ts`, no `qodo:check` | **investigated today, rewritten** (see `../wisdom-day-6.md`) |
| #6 Pick the review source and measure variance | not started | no three-run variance in the decision log | keep (its dependency #5 is closed) |
| #7 End-to-end tests for inject | not started; one criterion now conflicts with the code layout rule | no `inject.e2e.test.ts`; `packages/harness/test/` exists for integration tests (C12) and `npm run check` never runs them (CLAUDE.md, Code layout) | comment: criterion 3 should say `npm run test:integration` |
| #8 One branch per case | not started | `inject.ts:138,166` still use the template's fixed `publish.branch` | keep |
| #12 Link a target ticket to every case PR | not started | `new-case/SKILL.md` has no `Closes #` step | keep |
| #13 Run the first control cases | not started | no control case in the ledger | keep |
| #14 Run more bug cases | not started | one case (FF-0001) | keep |
| #15 Move the engine into a core package | not started | `packages/` holds only `harness` (C12) | keep |
| #16 Get Qodo to review FaultForge's own PRs | **delivered on Day 3** | decision log, Day 3: "Qodo reviews FaultForge again (configuration v5)", checked through the read-only API; `CLAUDE.md` carries the no-relationship rule; `cross-repo-relations.json` empty in the v6 snapshot (9 Nov) and again today | comment with evidence; owner closes |

## Process and harness tickets

| Ticket | State on main | Evidence | Action |
|---|---|---|---|
| #49 One top-down status view | not started | no `factory status` command | keep (after #48, closed) |
| #51 Epic: one factory loop for both repos | 7 of 11 criteria ticked | ticket | keep |
| #56 Block merging until Qodo's review is complete | not started as a required check; the factory's verify step waits for completion | workflows are `check`, `drill-foreign-label`, `factory` (C12); `review-wait` waits for `completed` on the head commit | keep |
| #62 Prove our tests catch the bugs they were written for | half delivered by #64 | `revert:check` (closed #64) does the per-PR half: scratch copy, base version of the changed code files, the PR's tests must fail | comment: rescope to the list of past fixes run in CI, or close as superseded by #64 and #101 |
| #101 The runner runs revert:check itself | not started | `factory-tick.ts:1873` only classifies the command for the audit; it never runs it | keep |
| #108 One GitHub helper and one paths module | not started; two details stale | six `gh` call sites, not five (C2: `verdict.ts:202` missing from the ticket); `privateDir()` already exists in `templates.ts:15` and is used by four scripts (C5), while `factory-tick.ts` computes the path three times and `rules-propose.ts` once | comment with the corrections |
| #109 Split factory-tick along its seams | not started; justified | 1916 lines, 31 commits in 48 hours (C8) | keep, after #108 |
| #126 Run log records the hooks' self-test | not started | the self-test exists (`factory-tick.ts:518,1402`) but logs no `hooks-checked` event | keep; ready for the factory |

## Rule proposals (opened by `rules:propose`)

| Ticket | Note |
|---|---|
| #82, #83, #84, #85, #124 | waiting for the owner's decision |
| #136 Testability | part of its evidence (PR 135, "Unit check now spawns git in every run") was linked by Qodo to a `CLAUDE.md`-derived rule that was active without adoption from 9 Nov 18:17Z until 11 Nov; decide with that in mind |

## Week 2 to 4 tickets, not started by design

#20, #21, #22, #23, #24, #25, #26, #27, #28, #29, #30, #31, #32, #33, #34, #35, #36, #37, #38, #39, #40, #41, #42, #43, #44.
