# 16. Thirty-day roadmap

Part of the [FaultForge charter](../CHARTER.md), version 2.3.

Daily challenges are inputs, not replacements. Sequencing is flexible; dependencies and the quality bar are not.

| Phase | Non-negotiable milestone | Stretch |
|---|---|---|
| Day 1 | Seed app, one validated mutation, ledger entry, one neutral PR, one Qodo review, one recorded outcome | CLI entry point |
| Day 2 | Qodo integration gate: local JSON verified or fallback chosen; trial coverage confirmed; variance measured (done later: trial coverage settled by the hackathon licence on Day 1; local structured review built on Day 8 as `review:local`; review variance measured with the benchmark cases) | Normalized findings |
| Days 3 to 7 | Several templates, clean controls, repeatable isolated cases, artefact capture, agent instructions under Qodo review, engine extracted as a library with target and review-source interfaces | CI automation |
| Days 8 to 14 | Adjudication criteria applied, measured detection and precision, contamination safeguards, frozen baseline config, first audit of an external TypeScript repository with generic templates | More classes, held-out cases |
| Day 15 | Devil's Advocate reveal: first evidence-based challenge on a real finding, persisted case | Case-file preview |
| Days 16 to 22 | Repeatable evidence generation, conservative verdicts, arbiter policy, audit trail, human gate, replay mode | Challenge GitHub Action |
| Days 23 to 27 | Before-and-after benchmark on the same findings, wrongly-suppressed and inconclusive counts | One approved rule-proposal PR, learn mode |
| Days 28 to 30 | Published Debate Chamber site, Codespace with replay verified on a clean machine, quick start, honest metrics | Live audit of a well-known open-source project, UI polish |

Devil's Advocate was first planned as a Day 15 surprise. Since version 2.2 the whole plan is public; Day 15 stays the milestone where it first runs on a real finding, after detection has been demonstrated.

## Daily challenge protocol

1. Read the challenge's exact acceptance requirements. They are mandatory even when they affect sequencing.
2. Identify the smallest increment that satisfies the challenge and strengthens FaultForge.
3. State what changes and what stays fixed.
4. Implement one testable vertical slice, review it with Qodo, capture evidence.
5. Record the decision in the decision log.
6. If a challenge conflicts with the plan, adapt the implementation rather than manufacturing irrelevant features.

```markdown
## Day NN: [challenge title]
- Challenge requirement:
- Increment delivered:
- What changed from the plan and why:
- Tests and Qodo evidence:
- Lesson or decision:
- Remaining risk:
```
