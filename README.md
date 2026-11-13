# FaultForge

**Break it. Review it. Prove it.**

An adversarial quality lab for AI software factories, powered by [Qodo](https://www.qodo.ai/).

Built for the Qodo hackathon *Build a Software Factory in 30 Days* (November 2026).

---

## See it in five minutes

Everything here is public and needs no account. In order of what it proves:

1. **One real case, end to end:** [`examples/FF-0001.json`](examples/FF-0001.json). The planted bug's file and line, the exact commit Qodo reviewed, Qodo's finding, the fixed match rule applied criterion by criterion, and the owner's verdict. Qodo's review is on [target PR 1](https://github.com/AJBeumer/faultforge-target/pull/1) itself, readable without an account. Qodo caught the bug.
2. **A measurement, not a claim:** [docs/rules-before-after.md](docs/rules-before-after.md). The same four diffs reviewed before and after one house rule, each of the eight PRs named, with the limits of the sample stated.
3. **The decisions, day by day:** [docs/decision-log.md](docs/decision-log.md). One entry per hackathon day: what was asked, built, measured and learned, with every PR and commit it rests on.
4. **The plan as tickets:** the [issues](https://github.com/AJBeumer/faultforge/issues) and the [board](https://github.com/users/AJBeumer/projects/6). The whole 30-day plan, including the parts not built yet, has been public since 6 November (Day 3), so every result from Day 3 on can be checked against a ticket that came first. Days 1 and 2 predate the tickets; their plan is the [charter](docs/CHARTER.md).
5. **The one command that works today:** plant a bug yourself in a throwaway clone of the target, following [Try it](#try-it) below. It takes a few seconds.

## Why

Coding agents write code faster than anyone can read it, so we lean on AI code review. But how good is that review on *your* codebase, for *your* kinds of bugs? Most of us are guessing.

FaultForge replaces the guessing with evidence.

## How it works

1. **Break it.** A saboteur injects a realistic bug into a TypeScript codebase using deterministic templates, such as a removed guard clause, a flipped comparison, a missing auth check, or a broken idempotency check. A template is published only after its case is adjudicated; one is public so far.
2. **Review it.** The change goes out as an ordinary-looking pull request, and Qodo reviews it.
3. **Prove it.** The answer key lives in a private ledger outside the repository, so the reviewer never gets a hint. Every finding is matched against it with a fixed rule: right file, overlapping lines, right kind of problem.

Every case is written to an append-only log, and every number in a report can be traced back to it. Clean control PRs with no injected bug go through the same review, so false positives are measured too, not just catches; three have run so far.

```mermaid
flowchart TB
  subgraph private["Private repository"]
    templates["Bug templates<br/>and hidden proof tests"]
    key[("Answer key")]
    log[("Append-only audit log")]
  end

  subgraph lab["FaultForge (this repository)"]
    inject["<b>1. Break it</b><br/>plant one bug on a new branch<br/>and prove it with the hidden test"]
    match["<b>3. Prove it</b><br/>match each finding to the answer key:<br/>right file, overlapping lines, right kind of problem"]
    verdict["A human confirms the verdict"]
  end

  subgraph target["faultforge-target (public)"]
    pr["Ordinary-looking pull request"]
    control["Clean control PR<br/>with no bug"]
  end

  qodo["<b>2. Review it</b><br/>Qodo reviews the PR"]

  subgraph outputs["What comes out"]
    bench["Benchmark<br/>catches, misses and false alarms"]
    site["Case site and replay<br/>no Qodo account needed"]
    audit["npx faultforge audit<br/>blind-spot report for your own repo"]
  end

  templates --> inject
  inject -->|"answer key"| key
  inject -->|"neutral branch and PR"| pr
  pr --> qodo
  control -.-> qodo
  qodo -->|"findings"| match
  key --> match
  match --> verdict --> log
  log -.-> bench
  log -.-> site
  lab -.->|"same engine, your code"| audit

  classDef planned stroke-dasharray: 5 5
  class bench,site,audit planned
```

Solid boxes work today; dashed boxes are planned. Qodo reviews both repositories; the two are not linked to each other in Qodo. The answer key and the audit log stay private. A template is published here only after its case has been adjudicated.

## Where it is going

By the end of the month:

- **For your own project:** run one command and get a blind-spot report showing the bugs that would get past both your test suite and your reviewer.

  ```bash
  npx faultforge audit
  ```

- **For judges and visitors:** browse every real case online, or open the repo in a Codespace and replay the full pipeline without needing a Qodo account.
- **A benchmark** with real counts and defined denominators: what Qodo caught, what it missed, and why.

Halfway through the month, the factory gets a new member that doesn't trust anyone: **Devil's Advocate**, which tries to support or disprove each Qodo finding by writing and running a test. The full plan is in the [charter](docs/CHARTER.md) and the [tickets](https://github.com/AJBeumer/faultforge/issues).

## Principles

- **Proof over opinion.** A model saying "looks fine" is not evidence. A test is.
- **The answer key stays hidden.** Ground truth never enters the reviewer's context.
- **Sabotage looks ordinary.** PR titles and commit messages never give the bug away.
- **Only measured numbers.** No simulated results, ever. Misses get published too.
- **Qodo is the reviewer, not the target.** FaultForge measures and extends review. It does not replace it.

## Status

| Day | Milestone | State |
|---|---|---|
| 1 | Booking API, first injected bug, first Qodo review (case FF-0001) | Done: Qodo caught it, under a condition recorded on [13 November](docs/decision-log.md#13-november-corrections-after-a-repository-audit) ([PR #1](https://github.com/AJBeumer/faultforge-target/pull/1), [case record](examples/FF-0001.json), [decision log](docs/decision-log.md#day-1-your-factorys-first-delivery)) |
| 2 | House rules: target `AGENTS.md` imported as Qodo review standards (configuration v3) | Done ([PR #2](https://github.com/AJBeumer/faultforge-target/pull/2), [decision log](docs/decision-log.md#day-2-house-rules)) |
| 3 | Backlog as [GitHub Issues](https://github.com/AJBeumer/faultforge/issues) with a [project board](https://github.com/users/AJBeumer/projects/6); thirteen tickets delivered in both repos, each through its own PR, CI and Qodo review (57 findings, 50 fixed); `review:wait` reads Qodo's real review status; the `/factory` loop works tickets between the owner's gates; Qodo configurations v4 and v5 | Done ([decision log](docs/decision-log.md#day-3-connect-your-factory-to-the-backlog)) |
| 4 | The factory starts itself: a `ready-for-agent` label (or a schedule) starts a run in [GitHub Actions](.github/workflows/factory.yml) that works one ticket to a Qodo-reviewed PR, fixes confirmed findings, and stops for the owner. It trusts only the owner's text and checks what actually changed after each run. Two unattended runs delivered merged PRs (one fixed a Qodo finding on its own); 29 Qodo findings on the day's PRs | Done ([decision log](docs/decision-log.md#day-4-automate-your-factorys-first-job), [how it works](docs/factory-trigger.md)) |
| 5 | The factory improves itself, with evidence: `rules:evidence` builds a citable table from the saved reviews, `rules:propose` opens proposal tickets when a pattern repeats, a blind session drafted candidates that were scored on held-out findings, and the owner adopted the first house rule ([AGENTS.md](AGENTS.md), [PR #91](https://github.com/AJBeumer/faultforge/pull/91), Qodo configuration v6). Its effect was then measured: the same four diffs reviewed with and without the rule ([before/after report](docs/rules-before-after.md)) | Done ([decision log](docs/decision-log.md#day-5-make-your-factory-self-improve)) |
| 6 | Qodo's Agentic Toolbox connected; the first check through it found Qodo had derived 14 active rules from `CLAUDE.md` on ordinary pushes, and configuration v6 was restored; every answer from Codebase Wisdom checked against the code (13 of 13 verified, [claims](docs/evidence/day-06/claims.md)); all 49 open tickets triaged ([triage](docs/evidence/day-06/triage.md)); ticket [#4](https://github.com/AJBeumer/faultforge/issues/4) rewritten from the evidence ([report](docs/wisdom-day-6.md)); then the tool itself measured: three tickets with a planted stale premise and one control, investigated blind through Qodo's read tools, 3 of 3 caught and 0 false alarms ([experiment](docs/evidence/day-06/premise-experiment/)) | Done ([decision log](docs/decision-log.md#day-6-ask-your-codebase-before-you-build)) |
| 7 | Review Resolver on a real PR: the Day 6 gate ticket built in session, five Qodo rounds (11, 2, 2, 2, 0 findings) read through the toolbox, a blind second reviewer of the same diff (12 findings, 6 in common), 9 of 17 Qodo findings reproduced by a failing test before the fix, the rest listed with the reason, `revert:check` 7 ([PR #149](https://github.com/AJBeumer/faultforge/pull/149), [scorecard](docs/evidence/day-07/)) | Done ([decision log](docs/decision-log.md#day-7-close-the-feedback-loop)) |
| 8 | Local review before commit, a check that it happened, and seven more cases: four bugs detected, two controls clean, one inconclusive | Done ([decision log](docs/decision-log.md#day-8-review-before-you-commit), [cases](docs/decision-log.md#cases-ff-0002-to-ff-0008-results-so-far-12-november)) |
| 9 to 14 | More bug templates, first measured baseline | Planned |
| 15 | Devil's Advocate challenges its first real Qodo finding with a test | Planned |
| 16 to 30 | Evidence, replay, one-command audit, final benchmark | Planned |

Progress and decisions for each daily challenge are recorded in [docs/decision-log.md](docs/decision-log.md).

## Repositories

- **FaultForge** (this repository): the harness, tooling, reports, and documentation.
- **[faultforge-target](https://github.com/AJBeumer/faultforge-target)**: the small booking API that gets attacked and reviewed. It is kept separate so the answer key never sits next to the code Qodo reviews.
- **A private repository** holds the answer key, raw reviewer output and unreleased bug templates. Templates are published here only after their case has been reviewed and adjudicated.

## Try it

Requires Node.js 22 or later.

```bash
npm install
npm run check      # typecheck, lint and tests
```

Planting a bug needs a checkout of [faultforge-target](https://github.com/AJBeumer/faultforge-target) next to this repository, with `npm install` run in it, a clean working tree, and `main` checked out. Use a throwaway clone: the command creates a branch in it.

```bash
git clone https://github.com/AJBeumer/faultforge-target ../faultforge-target
(cd ../faultforge-target && npm install)
npm run inject -- --template idempotency-guard-bypass-v1 --target ../faultforge-target --case FF-0001
```

The command applies the template on a new branch in the target (`tidy-replay-lookup`), runs the hidden proof test on `main` and on the branch, runs the target's own tests and typecheck, and keeps the branch only if the proof test passes on `main` and fails on the branch. It then switches the target back to `main`. It takes a few seconds and prints what it proved and the path of the answer key. Here, it creates a `private/` folder, which git ignores: the answer key (`ground-truth.jsonl`), an audit event (`audit-events.jsonl`), and the run's logs and diff under `raw-artifacts/FF-0001/`, which it does not announce. Nothing is pushed anywhere. Running the same template again doesn't need the old branch deleted: it picks a free name itself (a numeric suffix on the base name) and leaves the old one as evidence. A one-command audit for your own repository is planned (see Status).

## Repository layout

| Path | Contents |
|---|---|
| `packages/harness/` | The inject command, the review capture, the factory runner and their checks |
| `templates/seed/` | Bug templates and proof tests, published after their case is adjudicated |
| `examples/` | Sanitized public case records, published after their case is adjudicated |
| `schemas/` | JSON Schemas for the case record and `factory.json` |
| `factory.json` | The two repositories the factory works in, described once |
| `docs/CHARTER.md` | The plan: goals, principles, method, roadmap |
| `docs/decision-log.md` | One entry per daily challenge: decisions, results, lessons |
| `CLAUDE.md`, `.claude/` | Rules and tooling for the coding agent that helps build this project, including a hook that blocks hints from reaching the target repository |

## Stack

TypeScript, Node.js, Fastify, Vitest, Biome, Qodo. Built with Claude Code as the coding agent. Plain scripts and a small CLI. No agent framework.
