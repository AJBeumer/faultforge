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
  - **Tickets in GitHub Issues, through the `gh` CLI.** The agent listed the Week 1 tickets and read [#3](https://github.com/AJBeumer/faultforge/issues/3) back with its result and checklist.
  - **The whole 30-day plan as [44 FaultForge tickets](https://github.com/AJBeumer/faultforge/issues),** in 6 milestones with due dates, with native "blocked by" links and a public [project board](https://github.com/users/AJBeumer/projects/6). Every ticket has a Result, a Done-when checklist and a Why.
  - **Four target tickets.** Three were worked in order, each on its own branch and PR:

    | Ticket | PR | Qodo | Outcome |
    |---|---|---|---|
    | [#3 Cancel a booking](https://github.com/AJBeumer/faultforge-target/issues/3) | [#6](https://github.com/AJBeumer/faultforge-target/pull/6) | 1 bug, 1 requirement gap | both confirmed and fixed; clean re-review |
    | [#7 Clarify the input rule](https://github.com/AJBeumer/faultforge-target/issues/7) | [#8](https://github.com/AJBeumer/faultforge-target/pull/8) | 1 low finding | valid, resolved by merge order; still shown after it was resolved |
    | [#4 List my bookings](https://github.com/AJBeumer/faultforge-target/issues/4) | [#9](https://github.com/AJBeumer/faultforge-target/pull/9) | no findings | every criterion confirmed on the running app |

    [#5 Prevent overlapping bookings](https://github.com/AJBeumer/faultforge-target/issues/5) is on hold, because it changes Qodo's rules.
  - **A `/work-ticket` skill** with the routine that worked, and PR templates in both repos that carry the ticket link and a criteria table.
- **What changed from the plan and why:**
  - **The charter and every ticket are public (charter 2.2), including Devil's Advocate.** The owner chose openness over the planned Day 15 surprise. What stays private: the answer key, raw evidence, and templates of cases not yet reviewed.
  - **GitHub Issues instead of Linear or Jira.** It's free and already connected. Qodo reads a linked GitHub issue without any extra integration, and judges can follow ticket → PR → review in public.
  - **Only target tickets were worked today.** Qodo has no access to this repository since Day 1, so FaultForge PRs would get no review. That's ticket [#16](https://github.com/AJBeumer/faultforge/issues/16).
- **Tests and Qodo evidence:**
  - **PR #6:**
    - Qodo found that the cancel route cancelled the booking even when the request body had unknown fields. I reproduced it with a failing test (`200` instead of `400`) before fixing it.
    - Qodo also flagged a **requirement gap**: ticket #3 says "requires `x-user-id`", and no test sent a request without the header. So it reads the linked ticket and checks the PR against the criteria.
    - My first fix, a body schema, broke every request without a body, and it ran before authentication. The existing tests caught both.
    - Re-review at `0149fd4`: no open findings.
  - **PR #8:** Qodo noted that rule 3 named `cancel.ts` before the file existed. It was resolved by merging #6 first. Qodo re-reviewed after `main` was merged in and kept the finding: it seems to clear a finding only when the lines it points at change.
  - **PR #9:**
    - Clean review.
    - Checked on the running server: newest first, other users excluded, empty list, `401` without a valid user.
    - The ordering tests fail when the sort is removed.
  - Every criterion of #3 and #4 was checked with real requests. A read-back showed that refused requests left the booking unchanged. The checks: target `npm run check`, 32 tests.
- **Lesson or decision:**
  - **Qodo configuration v4** (from 6 November, 17:22 UTC): v3 plus a clarified rule 3 in the target's `AGENTS.md`. Every route that changes state checks its whole input, including routes without a body, after authentication. It came straight from the PR #6 finding. Qodo turned that one sentence into two reworded rules and one new rule ("authenticate before rejecting body fields"), which is the very mistake in my first fix. 19 rules, 17 active, no linked repositories. No case has run under v3 or v4 yet.
  - **Qodo rewrites its review comment in place after every push.** The first version of the PR #6 review would have been lost if it hadn't been saved before the fix. Reviews are now saved the moment they appear, and again for each commit. This is part of ticket [#5](https://github.com/AJBeumer/faultforge/issues/5).
  - **A clean review is not a finished ticket, and an open finding is not an open problem.** PR #9 was clean and still had to be checked against every criterion. PR #8 kept a finding that was already resolved. Both are recorded, not dismissed.
  - **Check that the live check hits the right build.** The first check of #4 was answered by a leftover server from #3, because stopping the task ended `npx` but not Node. The answers looked plausible. I discarded that run and redid it after matching the server's process to the port. The skill now does this.
  - **Ticketed case PRs get their own configuration version.** They will link a target ticket for the change they claim to make, never describing the bug. When requirement-gap findings count is decided before the first such case ([#12](https://github.com/AJBeumer/faultforge/issues/12)).
- **Remaining risk:**
  - Qodo's structured review output (the charter's Day 2 gate, [#6](https://github.com/AJBeumer/faultforge/issues/6)) is still unverified.
  - Qodo reviews only the target, so harness PRs get no independent review ([#16](https://github.com/AJBeumer/faultforge/issues/16)).
  - The board's built-in workflows and repository link need the owner in the browser.
  - The FF-0001 public record ([#3](https://github.com/AJBeumer/faultforge/issues/3)) is due Sunday 8 November.
