# Decision log

One entry per daily challenge: what was asked, what was built, and what was learned.

---

## Day 1: Your factory's first delivery

- **Challenge requirement:** introduce the project, sign up for Qodo, build one small capability with a coding agent, open a focused PR, run a Qodo review, and share one lesson.
- **Increment delivered:** a small booking API with one invariant: sending the same request twice with the same idempotency key never creates two bookings. One injected bug bypasses the idempotency check, confirmed by a hidden test, and goes out as a normal-looking PR for Qodo to review. Recorded as case FF-0001.
- **What changed from the plan and why:** the injected bug is a one-line slip rather than a removed guard. On a repeat request, the code looks up the original booking by the idempotency key instead of the booking id it saved. Removing the whole guard would also have broken an existing public test, so the PR would have arrived with red CI and given the answer away. With this version, the target's own tests and typecheck still pass, and only the hidden proof test fails.
- **Tests and Qodo evidence:** [faultforge-target#1](https://github.com/AJBeumer/faultforge-target/pull/1), reviewed commit `c7ffd15`. Qodo's PR summary (14:27 UTC) and its code review (14:28 UTC) both flagged the bug. The review raised one finding, rated High, in `src/bookings/create.ts`, lines 24 to 61. It said a repeat request creates a second booking, and that a key equal to another user's booking id returns that user's booking. Under the fixed match rule, the right file, overlapping lines and the right kind of problem, **FF-0001 is detected**. I reproduced the second claim with a test: it holds.
- **Lesson or decision:** a one-line bug planted to break one rule actually broke two. Besides creating duplicate bookings (INV-IDEMP-001), it let one user read another user's booking (INV-AUTH-001). The answer key and the hidden test only knew about the first; Qodo found both. So the answer key has to record everything a planted bug breaks, not just what it was meant to break, or a reviewer's correct extra finding would be counted as noise.
- **Remaining risk:** Qodo's local structured review is not verified yet; that is the Day 2 gate. The finding's line range covers 38 lines, so "overlapping lines" is a loose test for wide ranges. The Qodo trial shows 14 days, not 30. GitHub also requested a Copilot review automatically. It posted after Qodo, so it didn't affect this case, but it has to be switched off for later ones.

### Decisions made today

- **Match rule fixed before any data.** A Qodo finding counts as a catch only if it names the injected file, overlaps the injected lines, and describes the right kind of problem. The rule is not loosened after seeing results.
- **Two repositories.** The harness lives here. The booking API lives in a separate target repository, so the answer key never sits next to the code Qodo reviews.
- **Neutral PRs.** Branch names, commit messages, and PR descriptions for injected bugs must read like ordinary changes.
- **Day 1 counts even if Qodo misses the bug.** A miss is an honest data point, not a failure.
- **The replay check is not in the target's own tests.** Repeat-request behaviour is checked only by the hidden proof test, so a planted bug there doesn't show up as a CI failure.
- **One reviewer per case.** Only Qodo reviews target PRs. Any other bot's output is saved but doesn't count. The two repositories are never linked in Qodo, so FaultForge's templates can't reach the review.
- **No force-pushes to the target's `main`.** Published history stays as it is. Cases record the exact commit that was reviewed.
- **Unreleased templates stay private.** This changes the charter's layout: a bug template and its proof test live in the private repository until their case is adjudicated, and only then may be copied to `templates/seed/`. Held-back benchmark templates never go public. The inject command looks in private storage first.
- **Rules enforced in code, not just in docs.** `CLAUDE.md` holds the rules for coding agents. A Claude Code hook blocks giveaway words in anything sent to the target repository and blocks force pushes to it. The inject command refuses giveaway branch names and commit messages. The `/new-case` and `/daily-challenge` skills hold the repeatable routines.
- **Qodo configuration v2 for every case after FF-0001.** FF-0001 ran on Qodo's default Precision preset (v1). Qodo's own data showed it had then linked this repository and the target by itself, and that it can mine its own review rules from past PRs and activate them without approval. Either would let earlier cases or the lab itself influence later reviews. v2 switches off three settings: the cross-repository review agent, rule mining from review history, and auto-approval of mined rules. Everything else stays on the Precision preset. FF-0001 isn't affected: its review used no cross-repository context and no rules existed. Before every case we now check through Qodo's API that the target has no linked repositories and that no rules exist.
- **One history rewrite in this repository, on Day 1.** The first commit's message had a `Co-Authored-By: Claude` line, which I removed so GitHub's contributor list matches who owns the project. Only that one line changed; files, authors and dates are the same. No case refers to this repository's commit ids. The target repository was not rewritten, so FF-0001's commits are unchanged. Claude Code is still the coding agent used to build this project.

---

## Day 2: House rules

- **Challenge requirement:** create an `AGENTS.md` at the repository root with a short project description, setup and verification commands, and three to five project rules, each saying where it applies and why it exists. Commit and push it, and check that Qodo has turned the rules into review standards.
- **Increment delivered:** an [`AGENTS.md`](https://github.com/AJBeumer/faultforge-target/blob/main/AGENTS.md) in faultforge-target, the repository Qodo reviews. Four rules: idempotency keys belong to a user; someone else's booking is "not found", never "forbidden"; check the whole request before touching the store; no real clock or random ids in application code. Merged through [faultforge-target#2](https://github.com/AJBeumer/faultforge-target/pull/2) (merge commit `841d69d`). Qodo imported the rules, and they are now part of the reviewer's configuration (v3).
- **What changed from the plan and why:** I expected four rules. Qodo made 18: 8 from `AGENTS.md`, which it split into finer rules, and 10 from `INVARIANTS.md`, which it imported as well. One rule, "do not double-book a resource", came from an invariant marked *not yet enforced*. The code doesn't enforce it, so it would flag existing behaviour on unrelated PRs. It was switched off. Qodo left another rule inactive by itself, because it overlaps an `AGENTS.md` rule. 16 rules are active. The same PR also fixed the target's `package.json` description, which named this project. That broke the target's no-mention rule, and it had been public since Day 1.
- **Tests and Qodo evidence:** target `npm run check` passed (typecheck, lint, 19 tests). Qodo reviewed PR #2 at commit `d96ac35` and found no issues (0 bugs, 0 rule violations, 0 requirement gaps). The rules were checked through Qodo's API after import: 18 rules, 16 active, no review skills, no linked repositories.
- **Lesson or decision:**
  - **Configuration v3 = v2 plus the rules imported from the target's `AGENTS.md` and `INVARIANTS.md`.** Every case from now on runs under v3. FF-0001 stays a v1 result. Before each case, `/new-case` compares Qodo's rules with the saved v3 snapshot and stops on any difference.
  - **Editing `AGENTS.md` or `INVARIANTS.md` in the target is now a configuration change.** Qodo keeps imported rules in sync on pushes, so a one-line doc edit changes the reviewer.
  - **A house rule written from a review can carry that review's answer.** One imported rule reads "fetch the original booking via the stored idempotency record's bookingId, never via the client key". That is the FF-0001 bug almost word for word. Re-running that bug under v3 would measure whether Qodo applies a rule, not whether it finds a bug unaided, so it can't serve as a before-and-after comparison.
- **Remaining risk:** the rules cover most of the target's invariants, so cases on those topics now test "Qodo plus house rules" rather than Qodo alone. That is how a real team would run it, but results must be reported with their configuration version. Qodo's structured review output (the charter's Day 2 gate) is still unverified, and is carried to Day 3.

---

## Day 3: Connect your factory to the backlog

- **Challenge requirement:** connect a ticketing system to the coding agent through MCP or a CLI, and check that it can list tickets and read one back. Choose tickets and their order. Work them one at a time, each on its own branch and PR, with the ticket link and acceptance criteria in the PR. Investigate Qodo's findings, run the delivered behaviour against every criterion, fix what's confirmed, and use the feedback before the next ticket.
- **Increment delivered:**
  - **Tickets in GitHub Issues, through the `gh` CLI.** The agent listed the Week 1 tickets and read [#3](https://github.com/AJBeumer/faultforge/issues/3) back with its result and checklist. The whole 30-day plan is [public as tickets](https://github.com/AJBeumer/faultforge/issues) in six milestones, with "blocked by" links and a [project board](https://github.com/users/AJBeumer/projects/6). Every ticket has a Result, a Done-when checklist and a Must-not-break list.
  - **Two factories, one way of working.** The product (the target's booking API) and the tool itself (FaultForge) both go ticket → branch → PR with the ticket link and criteria → CI → Qodo → live check → fix. Nine tickets were delivered this way, one at a time:

    | Repo | Ticket | PR | Delivered |
    |---|---|---|---|
    | target | [3](https://github.com/AJBeumer/faultforge-target/issues/3) cancel a booking | [6](https://github.com/AJBeumer/faultforge-target/pull/6) | cancel route, one shared not-found reply |
    | target | [7](https://github.com/AJBeumer/faultforge-target/issues/7) clarify input rule | [8](https://github.com/AJBeumer/faultforge-target/pull/8) | AGENTS.md rule 3 (Qodo configuration v4) |
    | target | [4](https://github.com/AJBeumer/faultforge-target/issues/4) list my bookings | [9](https://github.com/AJBeumer/faultforge-target/pull/9) | list route, newest first |
    | target | [10](https://github.com/AJBeumer/faultforge-target/issues/10) checks on every PR | [12](https://github.com/AJBeumer/faultforge-target/pull/12) | CI, required on `main` |
    | faultforge | [#3](https://github.com/AJBeumer/faultforge/issues/3) FF-0001 case record | [#45](https://github.com/AJBeumer/faultforge/pull/45) | [`examples/FF-0001.json`](../examples/FF-0001.json), schema, leak test |
    | faultforge | [#46](https://github.com/AJBeumer/faultforge/issues/46) links one way | [#52](https://github.com/AJBeumer/faultforge/pull/52) | guard: nothing here links to the target |
    | faultforge | [#47](https://github.com/AJBeumer/faultforge/issues/47) refuse tickets that aren't ready | [#53](https://github.com/AJBeumer/faultforge/pull/53) | `npm run ticket:ready`, Must-not-break in forms |
    | faultforge | [#17](https://github.com/AJBeumer/faultforge/issues/17) checks on every PR | [#54](https://github.com/AJBeumer/faultforge/pull/54) | CI, required on `main` |
    | faultforge | [#48](https://github.com/AJBeumer/faultforge/issues/48) one factory.json | [#55](https://github.com/AJBeumer/faultforge/pull/55) | both repos described once; guard, readiness check and skill read it |

  - **A `/work-ticket` skill** with the routine that held up, and an epic ([#51](https://github.com/AJBeumer/faultforge/issues/51)) that lists the target's tickets as plain text, so the target never links back here.
- **What changed from the plan and why:**
  - **The charter is public ([version 2.2](CHARTER.md)), including Devil's Advocate.** The owner chose openness over the Day 15 surprise. What stays private: the answer key, raw evidence, and templates of cases not yet reviewed.
  - **GitHub Issues instead of Linear or Jira.** Free, already connected, and Qodo reads a linked GitHub issue with no extra integration. Judges can follow ticket → PR → review in public.
  - **Qodo reviews FaultForge again (configuration v5).** Its access was removed on Day 1 to stop lab content reaching target reviews. The factory's own work should get the same review, and almost everything here is public now. Checked through Qodo's read-only API right after: both repos registered, the target's 19 rules unchanged and scoped to the target only, no review skills, no linked repositories, and standards discovery not run on FaultForge. Recorded as a new version because Qodo carrying context from FaultForge PRs into target reviews can't be ruled out. No case has run under v3, v4 or v5.
  - **Every change now goes through a PR.** Both `main` branches require the CI check, with no bypass.
- **Tests and Qodo evidence:** Qodo raised **39 findings** on the nine PRs. 38 were counted from the saved review comments; the 39th only showed up later through Qodo's API (see the first lesson). Each one is visible on its PR:

  | Outcome | Count |
  |---|---:|
  | Real, and fixed | 32 |
  | Right problem, wrong suggested fix (one would have invented a verdict in a public record) | 2 |
  | Valid, deliberately not fixed: the guard blocks too much, never too little | 2 |
  | Valid, resolved by merging in the right order | 1 |
  | Not reproduced (CI on Linux ran all 74 tests) | 1 |
  | **Missed by us and merged**: added to the comment after we read it; reproduced since, now [target ticket 14](https://github.com/AJBeumer/faultforge-target/issues/14) | 1 |

  Findings were reproduced with a failing test before they were fixed, and every acceptance criterion was checked on the running app or with real commands. Seven of the 32 were bugs in my own earlier fixes. Qodo found nothing on target PR 9, and the live check agreed. The review missed at least one problem I found myself: the guard blocking a commit message that merely quoted a command.
- **Lesson or decision:**
  - **A Qodo comment is not a finished review.** Three times the comment first said "no open findings" and was edited minutes later to add findings: twice on PR #55 (one High), and once on target [PR 6](https://github.com/AJBeumer/faultforge-target/pull/6), where the added finding came after we had declared the PR done. It was merged with a real bug: a cancel sent with a JSON content type and no body gets a 400 and doesn't cancel. We only found it when `npm run review:wait` ([#5](https://github.com/AJBeumer/faultforge/issues/5)) read Qodo's API for that PR. Only the API status (`review_session.status: completed` for the head commit) says a review is done. Review start varied from 6 seconds to 10 minutes after a push. Ticket [#56](https://github.com/AJBeumer/faultforge/issues/56) will make that status a required check.
  - **Zero findings can mean "not reviewed".** Qodo finished the run for this decision-log PR with `review_effort: skip` and `review_complete: false`; its comment showed "Bugs (0)". `review:wait` reports that as skipped, never as clean.
  - **Qodo tracks findings by line, not by problem.** On target PR 8 a finding fixed elsewhere stayed open; on PR #52 and #55 findings we deliberately didn't fix were closed because their lines changed. "Resolved" needs its own check, which matters for the benchmark.
  - **After three rounds of bypasses, change the design.** Qodo kept finding ways past the guard through chained commands and quoted text. Reading a shell command with patterns can't be complete, so a command that writes across repos must now be split, and a reviewed repo may link to its own tickets only from its own checkout.
  - **Qodo configuration v4** (from 17:22 UTC): AGENTS.md rule 3 now covers routes that take no body. Qodo turned that one sentence into two reworded rules and one new one within a minute. 19 rules, 17 active.
- **Remaining risk:**
  - The `/factory` loop ([#50](https://github.com/AJBeumer/faultforge/issues/50)) isn't built, so tickets are still worked with the owner approving each step.
  - The merge gate on Qodo's run status ([#56](https://github.com/AJBeumer/faultforge/issues/56)) isn't built, so a PR can still look reviewed before Qodo has finished.
  - Qodo's local structured review (the charter's Day 2 gate, [#6](https://github.com/AJBeumer/faultforge/issues/6)) is still unverified.
