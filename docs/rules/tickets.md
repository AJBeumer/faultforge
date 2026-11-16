# Tickets

Part of the [rules for coding agents](../../CLAUDE.md). Each rule is one short bullet there; this page has the detail.

All FaultForge work is planned as GitHub Issues on `AJBeumer/faultforge`, grouped in milestones (one per phase of the charter roadmap).

- Every ticket states its **Result** and a **Done when** checklist that can be checked without judgement calls. Use the issue form (`.github/ISSUE_TEMPLATE/task.yml`).
- Work one ticket at a time, in the order the owner gives. The PR says `Closes #N`, and ticks the checklist only for criteria that were actually verified.
- Public tickets follow the decision-log rules above: they never name an unreviewed case, an unreleased template, or what a planned bug will be. Template work is described by count and defect class at most.
- Target tickets (`AJBeumer/faultforge-target` Issues) describe ordinary development work on the booking API and must read like any project's tickets. The guard hook checks them.
- Once ticketed cases start (#12, with its own configuration version), every case PR links a target ticket for the change it claims to make. The ticket describes the intended change, never the bug.
- Use `/work-ticket` for ordinary tickets: one at a time, its own branch and PR, the ticket link and acceptance criteria in the PR, Qodo's review saved straight away, and every criterion checked on the running app.
