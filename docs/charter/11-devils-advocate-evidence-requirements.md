# 11. Devil's Advocate: evidence requirements

Part of the [FaultForge charter](../CHARTER.md), version 2.3.

**Input.** One Qodo finding, the exact code snapshot, the public invariants, and a sandboxed test runner. Not the ledger, not template metadata.

**Required output.** The finding's id and a paraphrase of its claim. A falsifiable hypothesis and the failure mechanism. The generated test and exact commands. Environment and snapshot hash. Observed result, output, and exit code. A statement of what the evidence shows and what it does not. A proposed disposition.

**Verdict policy, v1:**

| Verdict | Minimum evidence | Developer-facing behaviour |
|---|---|---|
| Supported | A relevant failing test or reproduction with a coherent causal link to the finding, ideally passing on the corrected baseline | Finding preserved, evidence attached |
| Disproven | Reviewable evidence that the alleged path is unreachable or prevented under stated constraints: a targeted test plus code or contract reasoning | Eligible for human-approved suppression; full audit record retained |
| Inconclusive | Test failed to run, insufficient coverage, contradictory signals, or a mere passing result | Finding preserved, flagged for human review |

Security and authorization findings stay visible unless a human approves dismissal. The challenger may never treat silence as proof of safety. Qodo reviews the challenger's generated tests before they count as evidence.
