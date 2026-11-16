# 18. Definition of done

Part of the [FaultForge charter](../CHARTER.md), version 2.3.

**Must have**

- [ ] A stranger can set up and run a fault scenario from the documentation.
- [ ] Every published result links to a real change and real Qodo output.
- [ ] Ground truth was hidden during review and challenge.
- [ ] Misses, unsupported findings, and uncertainties are recorded without rewriting.
- [ ] Devil's Advocate produced executable evidence for representative findings.
- [ ] No finding was discarded because a model merely disagreed.
- [ ] The before-and-after table uses comparable cases and defined denominators.
- [ ] A static case file tells one complete story from mutation to disposition.
- [ ] The benchmark can be reproduced from the audit log with one command.
- [ ] A judge can browse real cases from a link and run replay in a Codespace in under five minutes, without a Qodo account.
- [ ] A developer can run the audit on their own TypeScript repository with one command and get a blind-spot report.

**Should have**

- [ ] Multiple distinct defect classes, not repeats of one template.
- [ ] Control changes and some held-out cases.
- [ ] Automated artefact collection with reproducible commands.
- [ ] At least one case where the challenger disproved a finding with a mechanism-covering test, and one where it supported a finding with a reproducing test.
- [ ] The challenge mode runs as a GitHub Action on a real pull request.
- [ ] At least one external open-source repository has been audited, with its blind spots published.

**Could have**

- [ ] A human-approved rule-change proposal based on recurring outcomes.
- [ ] A richer dashboard, more languages, or harder defect classes.

A negative or mixed result, carefully explained, beats a fabricated success.
