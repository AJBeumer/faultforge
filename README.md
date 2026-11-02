# FaultForge

**Break it. Review it. Prove it.**

An adversarial quality lab for AI software factories, powered by [Qodo](https://www.qodo.ai/).

Built for the Qodo hackathon *Build a Software Factory in 30 Days* (November 2026).

---

## Why

Coding agents write code faster than anyone can read it, so we lean on AI code review. But how good is that review on *your* codebase, for *your* kinds of bugs? Most of us are guessing.

FaultForge replaces the guessing with evidence.

## How it works

1. **Break it.** A saboteur injects a realistic bug into a TypeScript codebase using deterministic templates: a removed guard clause, a flipped comparison, a missing auth check, a broken idempotency check.
2. **Review it.** The change goes out as an ordinary-looking pull request, and Qodo reviews it.
3. **Prove it.** The answer key lives in a private ledger outside the repository, so the reviewer never gets a hint. Every finding is matched against it with a fixed rule: right file, overlapping lines, right kind of problem.

Clean control PRs with no injected bug go through the same pipeline, so false positives are measured too, not just catches. Every case is written to an append-only log, and every number in a report can be traced back to it.

## Where it is going

By the end of the month:

- **For your own project:** run one command and get a blind-spot report showing the bugs that would get past both your test suite and your reviewer.

  ```bash
  npx faultforge audit
  ```

- **For judges and visitors:** browse every real case online, or open the repo in a Codespace and replay the full pipeline without needing a Qodo account.
- **A benchmark** with real counts and defined denominators: what Qodo caught, what it missed, and why.

Halfway through the month, the factory gets a new member that doesn't trust anyone. More on Day 15.

## Principles

- **Proof over opinion.** A model saying "looks fine" is not evidence. A test is.
- **The answer key stays hidden.** Ground truth never enters the reviewer's context.
- **Sabotage looks ordinary.** PR titles and commit messages never give the bug away.
- **Only measured numbers.** No simulated results, ever. Misses get published too.
- **Qodo is the reviewer, not the target.** FaultForge measures and extends review. It does not replace it.

## Status

| Day | Milestone | State |
|---|---|---|
| 1 | Booking API, first injected bug, first Qodo review (case FF-0001) | Done: Qodo caught it ([PR #1](https://github.com/AJBeumer/faultforge-target/pull/1)) |
| 2 | Verify Qodo's local structured review, or fall back to PR comments | Planned |
| 3 to 14 | More bug templates, control PRs, first measured baseline | Planned |
| 15 | Something new joins the factory | Planned |
| 16 to 30 | Evidence, replay, one-command audit, final benchmark | Planned |

Progress and decisions for each daily challenge are recorded in [docs/decision-log.md](docs/decision-log.md).

## Repositories

- **FaultForge** (this repository): the harness, tooling, reports, and documentation.
- **[faultforge-target](https://github.com/AJBeumer/faultforge-target)**: the small booking API that gets attacked and reviewed. It is kept separate so the answer key never sits next to the code Qodo reviews.

## Stack

TypeScript, Node.js, Fastify, Vitest, Qodo. Plain scripts and a small CLI. No agent framework.
