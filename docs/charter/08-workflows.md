# 8. Workflows

Part of the [FaultForge charter](../CHARTER.md), version 2.3.

## Act I: can Qodo catch the defect?

```text
Correct seed app with explicit invariant
        |
        v
Saboteur applies one validated mutation
        |
        +--> PRIVATE ledger entry (outside target repo and agent context)
        |
        v
Isolated branch, neutral PR, exact commit snapshot
        |
        v
Qodo review (path, config version, and date recorded)
        |
        v
Raw output stored, findings normalized
        |
        v
Match against ledger using the fixed rule, human-checked
        |
        v
Detection result and audit record
```

Day 1 is already a complete vertical slice: one defect, one PR, one review, one traceable observation.

## Act II: should the developer trust this finding?

```text
Existing Qodo finding
        |
        v
Devil's Advocate forms a testable hypothesis
        |
        v
Generates test, runs it in an isolated sandbox
        |
        v
Records results, artefacts, and limitations
        |
        v
Arbiter applies policy; human adjudicates if needed
        |
        +--> Supported     --> visible finding with evidence attached
        +--> Inconclusive  --> visible, flagged for human review
        +--> Disproven     --> retained in audit; suppression only under approved policy
        |
        v
Static case file and updated evaluation
```

Raw Qodo findings and filtered developer-facing findings are both retained. Filtering never overwrites evidence or rewrites history.

## Act III: what did the factory learn?

Group adjudicated outcomes by template, class, and conditions. Where a recurring pattern exists, open a proposed rule or guidance change as a PR with supporting and counter-example case ids, the risk of masking real defects, and a held-out evaluation result. Require human approval. Never teach the reviewer the hidden answers, and never adapt the benchmark to flatter results. If no credible pattern emerges, no rule PR is better than a contrived one.
