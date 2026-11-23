# Decision log, week 4 (23 to 29 November)

Part of the [decision log](../decision-log.md). Entries are copied verbatim, in order.

## 23 November: Ponytail in interactive sessions only

The owner asked to include Ponytail (github.com/DietrichGebert/ponytail, MIT), a Claude Code plugin that adds "write the least code that fully works" rules to every prompt and every subagent, plus review and audit skills.

- **Where it runs.** Interactive Claude Code sessions in this repository, from 23 November. It is installed at local scope (the git-ignored `.claude/settings.local.json`), version 5.3.3, commit `ebd8654`. The agent read its hooks at that commit before the install: they send nothing over the network unless a webhook is set (none is), write their own state files on the owner's machine, and run `git ls-files`.
- **Where it does not run.** The factory is unchanged. Its workspaces live outside this repository, and the user settings it reads do not enable the plugin. The target repository never gets it, because its rules in the target would change what Qodo reads during a review.
- **Where it may run later, measured first.** Ticket #431 builds the same tickets with and without Ponytail in the factory, pre-registered. Ticket #432 scores Ponytail's review skill as a second reviewer on reviewer test v1's held-out answer key. Neither changes the factory or the gate before its result says keep.
- **Comparability.** Work built in sessions from today onward was written with Ponytail loaded. No case result depends on that: Qodo's configuration and the target are unchanged. Where Ponytail's rules and this repository's house rules disagree, `CLAUDE.md` and `AGENTS.md` win.

## Day 12: Give your factory the full picture

*Recorded 23 November. Qodo configuration v12; the lab Wiki holds no `.pr_agent.toml` (its history shows the page deleted on 19 November, nothing since). The target repository was not touched.*

- **Challenge requirement:** pick one expectation from a real ticket and one PR, give Qodo the source through the PR description, check the implementation with a test, run Qodo's review on the PR head, and record what it caught, what it missed and what can be verified about its use of the source.
- **Increment delivered:**
  - **Proof of source use, from Qodo's own answer.** A finding Qodo derives from a ticket has `finding_source: ComplianceTicketRule` and a citation with `source_type: ticket` that quotes the ticket. Over every saved lab review: 118 such findings in 70 PRs, each PR linking its own ticket.
  - **The PR and the expectation.** Lab PR 367, at its first reviewed commit `24b6bc6`. Ticket #364, Done when: "Comments say why, in one or two plain sentences". At that commit, the comment above `AppendOnlyScanner` in `ledger-check.ts` (lines 43 to 45) does not state the append rule plainly. PR 367's own round 1 raised exactly that, as a ticket finding citing #364.
  - **A test of the source, pre-registered in private storage before any review ran.** Reviewer test v1 (Day 11) had replayed this commit four times with a PR body that linked #410, a ticket unrelated to the diff: 0 of 4 caught the comment. Two fresh replay PRs ([#434](https://github.com/AJBeumer/faultforge/pull/434), [#435](https://github.com/AJBeumer/faultforge/pull/435)) used the same body with one change, `#410` became `#364`, so the linked source was the only difference. Rule: caught in 2 of 2 supported, 1 of 2 inconclusive, 0 of 2 not supported. Both PRs are closed without merging.
- **What changed from the plan and why:** nothing. `reviewer:score` needs arms A and B, so the four runs were scored in a scratch folder (v1's two v12 runs as A, today's as B); its own decision line belongs to reviewer test v1's rule and is not this test's result.
- **Tests and Qodo evidence:**
  - **Result: not supported.** Caught in 0 of 2 runs. No finding in any of the four runs names `ledger-check.ts` at lines overlapping 43 to 45, so no match needed a person's confirmation.
  - **Run 1 used the source.** Its one finding is a ticket finding citing #364's "Preserve existing tests and assertions": the PR shows no before-and-after test counts. The original PR body reported them; the replay body doesn't. A fair finding, on a different expectation of the same ticket.
  - **Run 2 found nothing** ("Requirement gaps (0)"). With no finding there is no citation, so whether it read #364 can't be shown either way.
  - **v1's 16 replay reviews, with #410 linked: 0 ticket findings.** With the right ticket, 1 in 2 reviews raised one.
  - **The implementation on main meets the expectation.** The comment now says when a removal counts. `ledger-check.test.ts` passes 31 of 31, including the three tests that pin that rule: an unchanged last line is an append, a changed or missing one is a removal, both in a real history.
- **Lesson or decision:**
  - **A linked ticket is used, but not as a checklist.** Qodo picked one expectation from #364 to check, a different one each run or none. One catch in seven reviews of this commit, with the right ticket in three of them, says round 1's catch was more likely chance than the source.
  - **The citation is the evidence, and silence proves nothing.** A ticket finding shows the source was read; a review with no findings shows neither that it was read nor that the ticket is met. So the factory's own checks stay the verification of a ticket's Done when list. Qodo's ticket findings are an extra signal on top.
  - **Linking the wrong ticket is not neutral.** Every replay body from now on links the original PR's own ticket, as PR 367 did.
- **Remaining risk:** one PR, one expectation, two runs. The baseline linked a wrong ticket, not none. Qodo had reviewed this commit five times before and may remember it.

## Day 12, later: every review records the tickets Qodo cited

- **Decision:** Day 12 showed that a ticket citation is the only evidence in Qodo's answer that it used the linked source. So `review:wait` now saves `ticketsCited` for every PR review: the tickets Qodo cited in its findings on that commit, each once. It prints either "Source: Qodo cited <ticket>" or "no finding cites a ticket. That shows neither that the ticket was read nor that it is met." Ticket #437, [PR #438](https://github.com/AJBeumer/faultforge/pull/438), merged as `54caabf`.
- **Qodo's review of PR #438:** round 1 raised one Medium. A citation's source was printed verbatim, so a newline or terminal escape in it could forge report lines. Reproduced with a failing test, then fixed: only plain web addresses count. Round 2 found nothing, and the quality gate was met in 2 of 3 rounds.
- **Measured on PR #438 itself:** neither review cited #437, and both saves record `ticketsCited: []`. That fits Day 12: a clean review says nothing about the ticket. The ticket's checklist was verified by its own tests.
- **Unchanged:** the gate reads findings, not this field. Older saves without the field still pass `ledger:check`.

## Day 13: Teach your factory a new skill

*Recorded 23 November. Qodo configuration v12. The target repository was not touched.*

- **Challenge requirement:** turn one recurring check into a skill (`SKILL.md` with inputs, ordered steps, expected results, evidence and stop conditions), use it on a real task in a fresh session, refine what the agent misunderstood, retry, and record Qodo's review of the code.
- **Increment delivered:** findings that carry their own proof ([PR #442](https://github.com/AJBeumer/faultforge/pull/442), ticket #441).
  - **The skill, `prove-finding`:** given a review finding, the agent writes a new test and a fix confined to the cited lines, and runs both through the helper `try-proof.mjs`. The verdict is `supported`, `disproven` or `inconclusive`.
  - **The verifier, `npm run proof:verify`:** re-runs the bundle in a fresh export of the commit and never reads the agent's verdict. A certificate needs four things: the test fails as an assertion failure; it passes once only the fix is applied; the fix stays inside the cited lines; and the test is a new file that changes nothing else. Each test runs in a child process under Node's permission model, reading only its export and starting no process.
  - **The exam, `npm run skill:exam`:** runs the skill blind in fresh headless sessions on matched pairs, the same Qodo finding on the commit that was reviewed and on the commit that fixed it. Only certificates are scored.
- **What changed from the plan and why:**
  - **The selection rule was amended before any session ran and before the key was hashed.** The ticket's rule picked three findings. For two of them, no later commit changed the cited lines: Qodo had marked them implemented for fixes made elsewhere. Without such a commit there is no known-answer fixed side, so the rule now also requires a later reviewed commit that changes a cited line.
  - **Run 1 was void.** Its one session couldn't run a test, because of two harness faults: the tool list was joined with spaces, and Claude Code refuses writes under `.claude/`. It gave a verdict from reading the code instead. The refinement: the skill now runs every proof through its helper, and any verdict except `inconclusive` must rest on runs the session saw itself.
  - **Qodo's round 1 changed the verifier.** It raised 13 findings, including that a test could read private storage and that a stale report could earn a certificate. All were fixed. The sandbox came from that review, and the worker-thread version was found to run tests unconfined before it shipped.
- **Tests and Qodo evidence:**
  - **The exam key's sha256 was committed before the first session:** `docs/evidence/day-13/skill-exam-v1.key.sha256` in `24c6b6a`.
  - **Rule fixed in advance:** at least 2 of 3 certified on the reviewed side and 0 on the fixed side is "works"; any fixed-side certificate is "fails"; anything else is inconclusive.
  - **Run 2:** 3 of 3 certified, 0 false proofs. Works.
  - **Run 2's bundles re-verified with the sandboxed verifier:** the same result.
  - **Run 3, the final skill:** 2 of 3 certified (one `inconclusive`), 0 false proofs. Works.
  - **Across runs:** all 12 scored sessions loaded the skill as their first tool call, and every fixed-side session answered `disproven`.
  - **The sandbox, as an integration test:** a proof whose test reads a file outside its export is refused. Before the sandbox, that same bundle was certified.
  - **Qodo on PR #442:** three rounds (13, 1, 0 findings; 6 High, 7 Medium, 1 Low; none dismissed). The quality gate was met at round 3 on `f51814b`. CI is green on Linux and Windows.
- **Lesson or decision:**
  - **A skill needs an exam it can fail in both directions.** The fixed side checks that the skill doesn't manufacture proofs, and here it never did.
  - **A certificate proves cause, not remedy.** The reviewed side's test also ran on Qodo's own fix commit. It passed for one pair and stayed red for the others, because those tests pin a different remedy from the one the real fix chose.
  - **Qodo's "implemented" doesn't mean the cited lines changed.** In 3 of the 6 findings the selection rule reached, the fix was made elsewhere.
- **Remaining risk:**
  - Three pairs from one repository, so this shows a direction, not a rate.
  - The two runs split on one borderline finding.
  - The network stays open to agent-written tests (#27).
  - Native addons are allowed in the sandbox: only the ones `npm ci` installs from the lockfile.
