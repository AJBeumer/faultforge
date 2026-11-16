# 2. The problem

Part of the [FaultForge charter](../CHARTER.md), version 2.3.

Coding agents produce code faster than humans can read it. The bottleneck moves from generating code to knowing whether to trust it. AI code review is the obvious answer, and it brings two linked problems:

- **Missed defects.** A generated change can look plausible, pass superficial inspection, and still violate a business invariant. Nobody knows which defect classes a reviewer catches without ground truth.
- **Noisy findings.** Review tools flag issues that are unreachable, already guarded, or weakly evidenced. The developer triages every one by hand, and the time saved writing code is spent adjudicating comments. A second model saying "I disagree" adds an opinion, not a solution.

These are linked because suppressing findings makes precision look better while silently discarding real defects. Any honest solution measures both missed defects and false positives.

**Why Qodo is central.** Qodo is the independent reviewer and the main quality checkpoint. FaultForge supplies the adversarial testbed, the evidence, and the feedback that make a Qodo-driven workflow more useful. It demonstrates Qodo's value. It does not replace Qodo's review engine, and it is not a takedown.

**Product hypothesis.** Pairing Qodo review with controlled defect injection and evidence-based verification improves the usefulness of developer-facing findings without an unacceptable loss in detection of real defects. This is a hypothesis to test, not a claim to assume.
