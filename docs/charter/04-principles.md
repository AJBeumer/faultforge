# 4. Principles

Part of the [FaultForge charter](../CHARTER.md), version 2.3.

These hold for the whole month regardless of what a daily challenge asks for.

1. **Every claim needs evidence.** An opinion from a second model is not a counterargument. A test is.
2. **Every verdict is auditable.** Each case goes to an append-only log with the finding, the challenge, the evidence, the decision, and who or what decided.
3. **Every improvement is measured.** No feature ships without a before-and-after number from the benchmark.
4. **A passing test is not proof.** The challenger must show its test exercises the alleged failure mechanism. Otherwise the verdict is inconclusive.
5. **Ground truth stays isolated.** The ledger lives outside the target repository and outside any context the reviewer or challenger can read.
6. **Sabotage looks ordinary.** Branch names, commit messages, and PR descriptions are neutral and plausible. We test whether Qodo can review code, not whether it can read a confession.
7. **Security findings always stay visible.** The arbiter never suppresses a security or authorization finding on a model's verdict alone.
8. **Only measured numbers go public.** Simulations and projections stay internal. Raw counts and denominators go with every percentage.
9. **The benchmark configuration is frozen.** Qodo configuration, templates, and match criteria are versioned, and no change happens mid-measurement without a new benchmark version.
10. **Qodo is the hero.** Devil's Advocate extends Qodo's review into executable verification. It does not fix a deficient reviewer.
11. **Human-approved learning.** Rule changes are proposed, evaluated, and approved. Nothing rewrites standards on its own.
12. **One working capability at a time.** There is always a complete runnable path through the system.
13. **One engine, many shells.** Judges, users, and the later app all run the same core. No feature exists only in the demo.
