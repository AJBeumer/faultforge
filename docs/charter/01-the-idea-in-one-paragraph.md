# 1. The idea in one paragraph

Part of the [FaultForge charter](../CHARTER.md), version 2.3.

FaultForge is a software factory that deliberately introduces defects into its own code, uses Qodo to detect them, and demands executable proof before any finding is accepted or rejected. A saboteur injects known, realistic bugs into a small application. Qodo reviews the resulting pull requests. A challenger, Devil's Advocate, tries to support or disprove each Qodo finding by writing and running a test, not by arguing. A small policy layer decides what reaches the developer. Because the injected defects are known, every step can be measured. The output after 30 days is a reproducible benchmark, an audit trail, and a verification layer that extends Qodo's review into executable evidence. Judges can try it without setup, and developers can point it at their own repository with one command.

**The non-negotiable principle: demand proof, not opinion.** A model's agreement or disagreement is not evidence. When evidence is insufficient, the answer is *inconclusive*, never *safe*.
