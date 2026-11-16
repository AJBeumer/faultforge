# 7. Actors

Part of the [FaultForge charter](../CHARTER.md), version 2.3.

**Saboteur, the defect producer.** Chooses from a catalog of known templates, applies one mutation to a disposable branch, verifies with a hidden proof test that the mutation violates its invariant, writes the answer key to the private ledger, and generates neutral PR text. Deterministic in v1. An LLM may propose mutations later only if a hidden test validates them first.

**Qodo, the independent reviewer.** Reviews the changed snapshot through the supported integration and produces findings with location, description, and category. Has normal repository context and truthful requirements. Never the answer key. Qodo also reviews the challenger's generated tests and the factory's own agent instruction files, so it stays central in every act.

**Devil's Advocate, the challenger.** Receives one Qodo finding plus the code and permitted public context. Forms a falsifiable hypothesis, writes an isolated targeted test, runs it in a sandbox, records commands, environment, exit status, and output, and proposes supported, disproven, or inconclusive with evidence attached.

**Evidence arbiter, the policy layer.** Verifies that artefacts exist and came from the right snapshot, checks that the evidence addresses the finding, applies the written policy, routes uncertain or high-risk cases to a human, and records every decision with a timestamp and rationale. Not an AI.

**Human, the final authority.** Adjudicates ambiguous matches and false-positive claims, reviews uncertain and risky cases, approves or rejects rule proposals, and can always inspect suppressed findings. In a solo project the human also wrote the answer key, so adjudication follows the predefined match rule and is logged, never done from memory.
