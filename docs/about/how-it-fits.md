# How the parts fit

Part of the [docs](../README.md). Moved here from the [project README](../../README.md).

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

## Repositories

- **FaultForge** (this repository): the harness, tooling, reports, and documentation.
- **[faultforge-target](https://github.com/AJBeumer/faultforge-target)**: the small booking API that gets attacked and reviewed. It is kept separate so the answer key never sits next to the code Qodo reviews.
- **A private repository** holds the answer key, raw reviewer output and unreleased bug templates. Templates are published here only after their case has been reviewed and adjudicated.

## Repository layout

| Path | Contents |
|---|---|
| `packages/harness/` | The inject command, the review capture, the factory runner and their checks |
| `templates/seed/` | Bug templates and proof tests, published after their case is adjudicated |
| `examples/` | Sanitized public case records, published after their case is adjudicated |
| `schemas/` | JSON Schemas for the case record (v1 and v2), the answer-key entry, the audit event, the saved review, the bug template and `factory.json` |
| `factory.json` | The two repositories the factory works in, described once |
| `docs/README.md` | The docs' start page: every document, one line each |
| `docs/CHARTER.md` | The plan: goals, principles, method, roadmap |
| `docs/decision-log.md` | The decision log's index: one entry per daily challenge, plus dated decisions and corrections, kept by week under `docs/decisions/` |
| `docs/ledger-anchors.txt` | Commit ids of the private history, so a rewrite of it is detected |
| `CLAUDE.md`, `.claude/` | Rules and tooling for the coding agent that helps build this project, including a hook that blocks hints from reaching the target repository |
