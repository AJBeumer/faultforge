# Decision log, week 4, continued (from 23 November)

Part of the [decision log](../decision-log.md). Entries are copied verbatim, in order. The [first part of week 4](week-4.md) reached the page limit.

## Day 14: Turn your quality gate into a workflow

- **Challenge requirement:** one Qodo approval workflow that adds the "Qodo approved" label when a PR has no finding at Medium or higher in any category or finding type, one protected path that always needs a person, two useful PRs (one outside the path, one inside) with the outcome predicted before review, the observed label and PR Triage evidence, and the approval step drawn into the Day 10 diagram.
- **Increment delivered:**
  - **The workflow and the guard, configuration v15.** "Lab gate: nothing above Low", on this repository only, the gate in `factory.json` (Medium and High fixed, Low flagged). Guard: `.claude/hooks/**`, the hooks that keep the reviewer from seeing the answer key. Saved inactive, checked, switched on at 19:35 UTC. The target has no workflow and no guard.
  - **The label is checked, not trusted** ([PR #451](https://github.com/AJBeumer/faultforge/pull/451), ticket #448). `npm run approval:check` counts the label only when `qodo-code-review[bot]` added it after Qodo began reviewing the current head, that review is complete with nothing above Low, `gate:check` is met, every CI check has finished with each required job succeeded, and no changed file is guarded. `--predict` gives the expected outcome from the changed files alone.
  - **The label's rule replayed on known answers** (`npm run approval:replay`). The 22 adjudicated cases this log names: 0 false approvals (14 planted bugs, all held), 0 false holds (8 controls). Reviewer test v1's scored runs: 12 counted (the 4 of PR 391 left out: Qodo's `review_complete` stayed false), 1 false approval: a complete review of PR 367 under v12 with 0 findings, on code holding 5 proven defects. No guard covers that code.
  - **Three useful PRs:** #428, `qodo:check` also compares every repository's root and Wiki `.pr_agent.toml` ([PR #454](https://github.com/AJBeumer/faultforge/pull/454)); the approval step in the diagram ([PR #455](https://github.com/AJBeumer/faultforge/pull/455), [chart](../factory-diagram.md)); #452, the guard's private-id tests in temporary checkouts ([PR #456](https://github.com/AJBeumer/faultforge/pull/456)).
- **What changed from the plan and why:**
  - The guard was first saved for the whole repository, then as `claude/hooks/**` without the leading dot. Both were caught from screenshots before the workflow was switched on.
  - The PR inside the guarded path was made in a separate clone: the guard protects its own files only in the checkout it runs from, so no unlock was needed.
  - #428 needed a record of the `.pr_agent.toml` files in snapshot v15. The agent was refused writing a snapshot; the owner wrote it.
  - The third prediction ran on PR 455, not 454: a fourth push would have broken the gate's three-round limit.
- **Tests and Qodo evidence:**

  | PR | Predicted (decision log, 19:38 UTC, before either PR) | Observed |
  |---|---|---|
  | 454, outside | Label once the review has nothing above Low | Rounds 1 and 2 had findings: no label. Round 3 clean: label by `qodo-code-review[bot]` 49 s after the review began; `approval:check`: `approved-verified` |
  | 456, inside | No label, even with a clean review | Clean review, gate met, CI green; no label and no label event after 4 minutes; `held-for-human` |
  | 455, new push after the label | The label stays until the new head is reviewed | It stayed about 48 s; Qodo then skipped the docs-only head and removed the label itself. Wrong on that point; `approval:check` never verified the unreviewed head |

  The label also came on PR 455 with a Low finding open, as configured. Every Medium and High finding of the day (18 on PRs 449, 451, 454 and 455) went through `prove-finding` first: 9 earned a certificate from `proof:verify`; 7 could not run in the proof sandbox (a design choice, private storage, a real git process, a link the sandbox couldn't create) and were fixed on the owner's call; 2 were on Markdown. None was dismissed. CI green on Linux and Windows before every push.
- **Lesson or decision:**
  - A label is a claim about one commit. On its own it doesn't say which head was reviewed or who added it; `approval:check` ties it to both.
  - Capture PR Triage while the PR is open. Triage and the API behind it list open PRs only (the API answered `"total":0` with every status selected), so the three test PRs left no Triage record after merging. The workflow's evidence here is GitHub's label events and the saved reviews.
- **Remaining risk:**
  - No API reads workflows or guards; `factory.json` keeps a copy, and a change in the portal shows only as `approval:check` disagreeing.
  - PR Triage evidence is missing for the three test PRs.
  - One run of each prediction; the false-approval count rests on 12 runs.
