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
3. **Prove it.** The answer key lives in a private repository the reviewer can't read. Hints are checked, not assumed away: every write to the target goes through one command that checks the exact text it sends, and a guard refuses any other write there; a test reads every file, commit message and branch name in the target for them; and `npm run qodo:check` compares the target's relationships in Qodo, and Qodo's rules, with a recorded snapshot. These checks are built against accidental hints from agents doing normal work, not against a deliberate attacker; the [threat model](docs/rules/threat-model.md) lists what they don't cover. Every finding is matched against the answer key with a fixed rule: right file, overlapping lines, right kind of problem.

Every case is written to an append-only log, and every number in a report can be traced back to it. The private history is anchored here, in [`docs/ledger-anchors.txt`](docs/ledger-anchors.txt), so it can't be rewritten unnoticed. Clean control PRs with no injected bug go through the same review, so false positives are measured too, not just catches.

## Results so far

Published cases only. Held-out cases are reported with the final benchmark. The [decision log](docs/decision-log.md) has every case, each correction, and why.

| Set | Bugs | Controls |
|---|---|---|
| FF-0001 (Qodo configuration v1, no rules, reported apart) | 1 of 1 detected | none |
| Benchmark v1: FF-0002 to FF-0019 | 10 of 10 distinct bugs detected (11 runs; FF-0019 reruns FF-0015) | 6 clean, 1 inconclusive (Qodo skipped the review) |
| Benchmark v2: FF-0024 to FF-0027 | 2 of 2 detected | 2 clean |

How to read these numbers:
- **What the catches rest on.** In benchmark v1, most catches were Qodo checking the diff against its ticket or a house rule that stated the broken behaviour, not finding the bug unaided. Benchmark v2 was designed against that: tickets that don't state the oracle, controls that change behaviour and carry a test, and results split by Qodo's own source label. In v2, one catch was Qodo's own issue finding, on behaviour no target rule states; the other was a house-rule finding.
- **Sample size.** These are small diffs in a 450-line app. A clean sweep is a lower bound, not a rate.
- **Web search was on.** Every case so far ran with Qodo's web search on, so a review could have searched the public web, this repository included. It was switched off on 16 November (configuration v11), and later cases are reported as their own group.
- **Where the corrections are.** An independent audit on 14 November found the gaps behind these caveats. They are corrected in the decision log, never by editing earlier entries.

## Try it

Requires Node.js 22.18 or later. The hooks and some scripts run TypeScript files with plain `node`, which earlier versions cannot do.

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

The command applies the template on a new branch in the target (`tidy-replay-lookup`), runs the hidden proof test on `main` and on the branch, runs the target's own tests and typecheck, and keeps the branch only if the proof test passes on `main` and fails on the branch. It then switches the target back to `main`. On today's target the planted variant also fails one of the target's own tests, a replay test added after this case ran on 2 November. That is recorded, not refused, because a bug that a test catches is still a bug. It takes a few seconds and prints what it proved and the path of the answer key. Here, it creates a `private/` folder, which git ignores: the answer key (`ground-truth.jsonl`), an audit event (`audit-events.jsonl`), and the run's logs and diff under `raw-artifacts/FF-0001/`, which it does not announce. Nothing is pushed anywhere. Running the same template again doesn't need the old branch deleted: it picks a free name itself (a numeric suffix on the base name) and leaves the old one as evidence. A one-command audit for your own repository is planned (see Status).

## Read more

- [The docs' start page](docs/README.md): every document, one line each.
- [Glossary](docs/glossary.md): every project term in a sentence or two.
- [Threat model](docs/rules/threat-model.md): what the guard protects against, and what it doesn't.
- [Status](docs/about/status.md): each hackathon day's milestone and where it is recorded.
- [How the parts fit](docs/about/how-it-fits.md): a diagram, the three repositories and the repository layout.
- [Where it is going](docs/about/where-it-is-going.md) and [principles](docs/about/principles.md).

## Stack

TypeScript, Node.js, Fastify, Vitest, Biome, Qodo. Built with Claude Code as the coding agent. Plain scripts and a small CLI. No agent framework.
