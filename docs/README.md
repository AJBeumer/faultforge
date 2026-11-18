# FaultForge docs

FaultForge plants known bugs in a small app and has Qodo review them as ordinary pull requests.
It scores each review against a private answer key, with a fixed match rule.
A miss is a valid result. When evidence is missing, the answer is "inconclusive", never "safe".
Everything here is public, except what would tell the reviewer the answer before the review.
Start with the [project README](../README.md) for results so far and a quick start.

Every document under `docs/` is listed below, one line each. `npm run docs:check` fails if one is missing.
New to the project's words? The [glossary](glossary.md) defines each one.

## About the project

- [Glossary](glossary.md): each project term in one or two sentences, with a link to where it is used.
- [Status](about/status.md): each hackathon day's milestone, and where it is recorded.
- [How the parts fit](about/how-it-fits.md): a diagram, the three repositories and the repository layout.
- [Where it is going](about/where-it-is-going.md): what the month should deliver.
- [Principles](about/principles.md): the five principles, in one line each.

## The plan: the charter

- [Charter](CHARTER.md): the plan, version 2.3. A short index of the parts below.
- [1. The idea in one paragraph](charter/01-the-idea-in-one-paragraph.md): what FaultForge is, and its one principle.
- [2. The problem](charter/02-the-problem.md): missed defects and noisy findings in AI review.
- [3. The fixed goal](charter/03-the-fixed-goal.md): the north star and what counts as success.
- [4. Principles](charter/04-principles.md): what holds for the whole month, whatever a challenge asks.
- [5. Scope](charter/05-scope.md): each capability, its priority and the decision on it.
- [6. Seed application](charter/06-seed-application.md): the booking API, its invariants and test limits.
- [7. Actors](charter/07-actors.md): who does what.
- [8. Workflows](charter/08-workflows.md): the three acts, from catch to lesson.
- [9. Architecture](charter/09-architecture.md): repositories, storage, stack and record contracts.
- [10. Qodo integration](charter/10-qodo-integration.md): the primary path, the fallback and the rules for both.
- [11. Devil's Advocate](charter/11-devils-advocate-evidence-requirements.md): what evidence a challenge needs.
- [12. Evaluation methodology](charter/12-evaluation-methodology.md): ground truth, measurements and reporting.
- [13. Learning loop](charter/13-learning-loop.md): which outcome patterns lead to which proposals.
- [14. Debate Chamber](charter/14-debate-chamber.md): a static viewer for each case file.
- [15. Adoption and access](charter/15-adoption-and-access.md): judges, developers, and the later app.
- [16. Thirty-day roadmap](charter/16-thirty-day-roadmap.md): the month's plan and the daily challenge protocol.
- [17. Day 1 deliverable](charter/17-day-1-deliverable.md): what Day 1 had to deliver.
- [18. Definition of done](charter/18-definition-of-done.md): when the project is finished.
- [19. Risks](charter/19-risks.md): what could go wrong, and the answer to each.
- [20. Open questions](charter/20-open-questions-to-settle-early.md): what had to be settled early.
- [21. Final demo](charter/21-final-demo.md): what the final demo shows.
- [22. Positioning](charter/22-positioning.md): the one-sentence and short pitch.
- [23. References](charter/23-references.md): the sources the plan relies on.
- [Charter control](charter/charter-control.md): what is locked, what can change, and the change history.

## Decisions and results: the decision log

- [Decision log](decision-log.md): the index. Every entry, by week. New entries go in the current week's file.
- [Week 1](decisions/week-1.md): 2 to 8 November, Days 1 to 3.
- [Week 2](decisions/week-2.md): 9 to 15 November, Days 4 to 8, cases, audits and benchmarks v1 and v2.
- [Week 3](decisions/week-3.md): from 16 November.
- [Does a house rule change the review?](rules-before-after.md): the Day 5 before-and-after measurement.
- [Ask the codebase before you build](wisdom-day-6.md): the Day 6 report.

## How the tools work

- [Starting the factory from a label](factory-trigger.md): the unattended factory run in GitHub Actions.
- [One door to the reviewed repository](target-door.md): `npm run target:post`, the only way to write to the target.
- [Reviewing before you commit](review-local.md): `npm run review:local`.
- [review:gate](review-gate.md): whether a commit's files were seen by a finished local review.
- [Questions before the build](ticket-questions.md): the factory asks the owner about a gap in a ticket before it builds, and `npm run clarify:measure`.
- [The quality gate](quality-gate.md): which findings must be fixed before a task is done, and `npm run gate:check`.
- [The factory, drawn from its own data](factory-diagram.md): every gate from ticket to `main`, with how often each one passed or stopped a run. Written by `npm run factory:diagram`.

## Rules for coding agents

The rules themselves are in [CLAUDE.md](../CLAUDE.md) and the house rules in [AGENTS.md](../AGENTS.md). These pages hold the detail.

- [Three repositories](rules/three-repos.md): what each repository holds and never holds, and links that go one way.
- [The door and the guard](rules/guard.md): how writes to the target are sent and checked.
- [Threat model](rules/threat-model.md): what the guard protects against, its known gaps, and the layers behind it.
- [Tickets](rules/tickets.md): how work is planned and tracked.
- [Code layout](rules/code-layout.md): where tests and helpers live, portability, module size, exit codes.

## Evidence

- [Day 6: method](evidence/day-06/00-method.md): the questions, written before the answers.
- [Day 6: claims](evidence/day-06/claims.md): each remote answer checked against the local checkout.
- [Day 6: probes](evidence/day-06/probes.md): tool calls that answered with an outage, and when.
- [Day 6: backlog triage](evidence/day-06/triage.md): all 49 open tickets, checked.
- [Day 6: premise experiment](evidence/day-06/premise-experiment/): planted false premises, investigated blind.
- [Ticket W-0](evidence/day-06/premise-experiment/tickets/W-0.md), [W-1](evidence/day-06/premise-experiment/tickets/W-1.md), [W-2](evidence/day-06/premise-experiment/tickets/W-2.md), [W-3](evidence/day-06/premise-experiment/tickets/W-3.md): the four tickets the experiment used.
- [Report W-0](evidence/day-06/premise-experiment/reports/W-0.md), [W-1](evidence/day-06/premise-experiment/reports/W-1.md), [W-2](evidence/day-06/premise-experiment/reports/W-2.md), [W-3](evidence/day-06/premise-experiment/reports/W-3.md): each investigator's report.
- [Day 7: Review Resolver on PR 149](evidence/day-07/): the scorecard, with a blind second reviewer.
- [Day 7: the blind review](evidence/day-07/blind-review-pr149.md): the second reviewer's findings.
- [Day 8: review before you commit](evidence/day-08/): the local review evidence.
