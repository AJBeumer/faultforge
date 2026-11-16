# 5. Scope

Part of the [FaultForge charter](../CHARTER.md), version 2.3.

| Priority | Capability | Decision |
|---|---|---|
| Core | Seed application | One small TypeScript booking API with documented invariants |
| Core | Saboteur | Deterministic templates; each run produces one isolated change with neutral PR text |
| Core | Private ground truth | Case id, template, class, invariant, location, target commit, proof test. Never visible to reviewer or challenger |
| Core | Qodo integration | Collect actual findings, reviewed commit, review path, config version, and date. Record incomplete runs honestly |
| Core | Devil's Advocate | Targeted test generation and execution, evidence capture, proposed verdict |
| Core | Audit trail | Append-only events linking commits, findings, tests, verdicts, and human decisions |
| Core | Evaluation | Seeded recall, finding precision, retained precision, wrongly suppressed findings, inconclusive rate |
| Lightweight | Evidence arbiter | Deterministic policy function plus human gate. Not another agent |
| Lightweight | Rule evolution | Detect a recurring adjudicated pattern and open a proposed rule-change PR |
| Core | Engine as a library | Target adapter and review-source interfaces. Every shell runs the same core |
| Core | Judge access | Published case site, Codespace, replay mode that needs no Qodo account |
| Lightweight | Audit on any repository | Generic TypeScript templates, blind-spot report, `--budget` cap |
| Lightweight | Challenge Action | GitHub Action wrapping the challenger for pull requests |
| Presentation | Debate Chamber | Static case-file viewer rendered from sanitized records. No live streaming |
| Deferred | Concurrency defects | Only if reliable reproduction is demonstrated in the final week |
| Deferred | Hosted app | Accounts, billing, cross-repository dashboard. After the hackathon |
| Out of scope | Guaranteed proofs on arbitrary repositories, languages beyond TypeScript and JavaScript, self-modifying policies, orchestration frameworks, real payment infrastructure | Not needed to test the hypothesis |

**Scope rule.** A daily challenge may change sequencing, tooling, presentation, or implementation detail. It may not replace the north star or compromise measurement integrity. Every new feature must improve defect creation, independent review, evidence collection, adjudication, evaluation, or explainability.

**Rescoping priority when time is tight.** Preserve the end-to-end evidence chain, the benchmark, and judge access through replay. Drop, in order: UI polish, additional challenger strategies, rule automation, the learn mode, exotic defect classes, the challenge Action. The one-command audit is the last thing to drop.
