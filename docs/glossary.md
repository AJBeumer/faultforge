# Glossary

Part of the [docs](README.md). Each project term in one or two sentences, with a link to where it is used.

## The three repositories

- **Lab.** This repository, `faultforge`: the harness, the docs and the tickets. See [three repositories](rules/three-repos.md).
- **Target.** `faultforge-target`, the small booking API that Qodo reviews. Its pull requests must read like ordinary work. Also called the reviewed repo, marked `"guard": "reviewed"` in `factory.json`.
- **Private storage.** The private repository, checked out at `private/` and ignored by this one. It holds the answer key, the audit log, raw evidence and unreleased templates.

## Cases

- **Case.** One measurement: a pull request on the target, Qodo's review of it, and the owner's verdict, under an id such as `FF-0001`. [`/new-case`](../.claude/skills/new-case/SKILL.md) runs one end to end.
- **Template.** A recipe for one case's change: the file and lines it touches, its ticket text, and, for a bug, its proof test. Unreleased ones stay in private storage; [`templates/seed/`](../templates/seed/) holds the published ones.
- **Proof test.** A test that passes on the target's `main` and fails once the bug is planted. `npm run inject` keeps a planted bug only when its proof shows that.
- **Control case.** A case with no planted bug: a correct change reviewed the same way. It measures false alarms. See the [decision log](decisions/week-2.md#14-november-benchmark-v2-method-decided-before-any-v2-case).
- **Development case.** A case run and published as the work goes on, as opposed to a held-out case.
- **Held-out case.** A benchmark case fixed in advance and run last. Nothing about it is published before the final report. See [charter control](charter/charter-control.md).
- **Rerun.** A case that reopens another case's exact diff as a new PR, to see how much Qodo's review varies. Recall counts distinct bugs, not reruns.
- **Benchmark.** A frozen set of conditions under which cases are reported together: Qodo's configuration, the match rule and the template rules. Benchmark v1 and v2 are reported apart. See the [README's results](../README.md#results-so-far).

## Scoring

- **Answer key.** The private record of each case: the planted file and lines, and what kind of problem it is (`private/ground-truth.jsonl`). It is append-only.
- **Audit log.** The private, append-only list of every step of every case (`private/audit-events.jsonl`). A correction is a new entry, never an edit.
- **Match rule.** The fixed test of a catch: a finding names the planted file, overlaps the planted lines, and uses one of the template's kind terms. It never changes after results are seen. See [`match/`](../packages/harness/src/match/README.md).
- **Kind term.** A word a template lists for its kind of problem. A finding must use one in its title, summary or category to meet the third part of the match rule.
- **Verdict.** The owner's judgement of a case, recorded with `npm run verdict`. A bug case is `detected`, `missed` or `review incomplete`; a control is `clean`, `false alarm` or `review incomplete`.
- **Inconclusive.** The answer when the evidence is missing, for example when Qodo skipped the review. It is never read as "safe".

## Qodo

- **Configuration version.** A numbered record of Qodo's setup: its rules, its review skills and the target's relationships, kept as a snapshot in private storage. Results are only compared within one version, and each new version is entered in the [decision log](decision-log.md).
- **Relationship.** A link Qodo makes between two repositories it reviews, which would let it read one while reviewing the other. The target must have none.
- **`qodo:check`.** The command that compares Qodo's live setup with the latest snapshot. See the [threat model](rules/threat-model.md#the-layers-behind-it).
- **"Qodo approved".** The label Qodo's approval workflow adds to a lab pull request with nothing above Low and no guarded file. A claim, checked by `approval:check`. See [Qodo's approval label](approval-label.md).
- **Review effort.** The depth Qodo chose for a review, such as `lite`, `standard` or `skip`. A skipped review is not a clean one.

## Keeping hints away from the reviewer

- **Giveaway word.** A word on the shared list in `neutral.ts` that would tell Qodo about the lab or a planted bug.
- **Door.** `npm run target:post`, the one command that writes to the target. It checks the exact text it sends. See [the door](target-door.md).
- **Guard.** The Claude Code hook that refuses every write to the target except through the door. See [what it protects against](rules/threat-model.md).
- **Git guard.** The git hooks `npm run guard:install` puts in the target's checkout. They check commits and pushes made in that checkout; a push from another clone doesn't run them.

## The factory

- **Factory run.** An unattended run that takes one ready ticket to a reviewed pull request, started by the `ready-for-agent` label. See [starting the factory](factory-trigger.md).
- **Tick.** One pass of `npm run factory:tick`: take the lock, pick the oldest ready ticket, run the agent on it, check what it did, and report on the ticket.
- **Runner.** The tick's own process. It sets up the run, starts the agent, and checks the result itself rather than taking the agent's word.
- **Owner gate.** A point where the factory stops for the owner: a ticket that isn't ready, a PR ready to merge, a review it can't settle, or a change to Qodo's rules.

## Records

- **Decision log.** The public, dated record of every decision and measured result, one entry per day or event. See [the decision log](decision-log.md).
- **Ledger anchor.** A line in [`ledger-anchors.txt`](ledger-anchors.txt) with a date and a commit id of private storage. It shows publicly that the private history wasn't rewritten later.
- **Re-grade.** An independent audit of the project, scored by dimension. Its corrections go in the decision log.
