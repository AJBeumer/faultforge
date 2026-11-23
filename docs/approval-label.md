# Qodo's approval label

On this repository, Qodo adds the label "Qodo approved" when a pull request meets the
[quality gate](quality-gate.md)'s threshold. A label is a claim about one commit, so FaultForge checks
it before anyone relies on it. The target repository has no workflow and no label.

## The workflow and the guard

Both are set in Qodo's portal (Workflows), on `AJBeumer/faultforge` only. Configuration v15 in the
[decision log](decisions/week-4.md#23-november-qodo-configuration-v15-and-two-predictions-before-review).

- **Workflow "Lab gate: nothing above Low".** When Qodo finishes reviewing a pull request and no finding
  at Medium or higher is open, in any category or finding type, it adds the label. A Low finding doesn't
  stop it. When a review is incomplete (skipped), it takes the label off.
- **Approval guard `.claude/hooks/**`.** A pull request that changes the guard's own files never gets the
  label, however clean its review. A person reviews it.

No API reads workflows or guards. [`factory.json`](../factory.json) keeps a copy in
`repos.faultforge.approval`: the label, the login that adds it, and the guarded paths.

## Checking a label

```
npm run approval:check -- faultforge <pr>            # the label against the head commit
npm run approval:check -- faultforge <pr> --predict  # before any review: does a guard apply?
```

It counts the label only when `qodo-code-review[bot]` added it after Qodo began reviewing the current
head, that review is complete with nothing above Low, `gate:check` is met, every CI check has finished
with each required job succeeded, and no changed file is guarded. It says `approved-verified` (exit 0),
`held-for-human` or `not-eligible` (1), or `disagree` (3). Run `review:wait` first: it reads the saved
review of the head.

## Checking the rule against known answers

```
npm run approval:replay
npm run approval:replay -- --key <key.jsonl> --runs <dir> [--replays 411=391,...]
```

It applies the label's rule to saved reviews with a known answer: the adjudicated cases the decision log
names, and, with a key, a review test's runs of code with proven defects. A label on a planted bug or on
proven-defective code is a false approval; a held clean control is a false hold. Results: Day 14 in the
[decision log](decisions/week-4b.md#day-14-turn-your-quality-gate-into-a-workflow).

## Evidence in the portal

PR Triage, and the data behind it, list open pull requests only. The workflow's decision per pull request
(`mergeAutomation`, `approvalEligibility`) is in that data, not on the page: capture it before merging.
