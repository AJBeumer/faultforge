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
