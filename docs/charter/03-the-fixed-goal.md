# 3. The fixed goal

Part of the [FaultForge charter](../CHARTER.md), version 2.3.

The daily challenges shape what gets built on which day. The destination does not move.

**North star:** build a software factory that can challenge its own quality claims, preserve the evidence, and report the results honestly.

**By Day 30, a stranger can:**

1. Run a documented, isolated defect-injection scenario.
2. Inspect the exact change Qodo reviewed and Qodo's actual output.
3. Open a case file showing the finding, the challenger's test, and the evidence.
4. See a defensible disposition: supported, disproven with evidence, or inconclusive.
5. Compare measured outcomes before and after the challenger, including real findings it wrongly suppressed.
6. Reproduce the benchmark from the audit log with one command.
7. Try FaultForge in under five minutes without a Qodo account.
8. Run an audit on their own TypeScript repository with one command and get a blind-spot report.

**What will exist:**

- A seed application with explicit, documented invariants.
- A library of deterministic fault-injection templates and a private ground-truth ledger.
- A Qodo integration reviewing every injected change and every clean control change, with the review path labelled per case.
- Devil's Advocate: a challenger producing a test, evidence, and a verdict per finding.
- An evidence arbiter: a small deterministic policy function plus human judgment.
- An append-only audit log and a static Debate Chamber generated from it.
- A benchmark report with real counts, defined denominators, and stated limitations.
- A rule-proposal workflow that opens a pull request for human approval.
- Agent instruction files, Qodo configuration, and the saboteur templates versioned as factory assets.
- A command-line tool for audit and replay, and a GitHub Action for the challenge mode.
- A published Debate Chamber site and a one-click Codespace for judges.
- A setup guide, architecture overview, and end-to-end demo.

**What success is not:** "the AI says the code is safe"; a debate animation with no reproducible tests; dismissing a finding because a generated test passed; a benchmark whose answer key the reviewer can read; accuracy claims from hand-picked examples; five half-finished agents.
