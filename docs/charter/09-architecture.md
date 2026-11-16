# 9. Architecture

Part of the [FaultForge charter](../CHARTER.md), version 2.3.

## Repositories and storage

```text
faultforge/                      public harness and source project
  README.md                      pitch and quick start
  docs/
    CHARTER.md                   this document
    evaluation-method.md         metric definitions and denominators
    decision-log.md              one entry per daily challenge
  AGENTS.md / CLAUDE.md          agent instructions: factory assets, reviewed by Qodo
  .qodo/ or .pr_agent.toml       Qodo configuration, versioned and frozen per benchmark
  .devcontainer/                 one-click Codespace for judges
  packages/
    core/                        the engine: target adapters, review sources, cases, policy
    harness/                     injection runner, PR creation, review ingestion
    challenger/                  test generation and sandboxed execution
    report/                      metrics and static case-file generation
    cli/                         faultforge audit | replay | report
    action/                      GitHub Action for challenge and learn modes
  templates/                     never loaded into reviewer or challenger context
    seed/                        templates for booking-api, with hidden proof tests
    generic/                     structural templates for any TypeScript project
  replay/                        recorded Qodo output for replay mode
  examples/                      sanitized public case records only

faultforge-target/               separate public repository that Qodo reviews
  src/                           booking-api
  test/                          ordinary application tests
  INVARIANTS.md                  the documented invariants

PRIVATE STORAGE                  outside both public repositories
  ground-truth.jsonl             answer key
  audit-events.jsonl             full append-only event stream
  raw-artifacts/                 Qodo output, test logs, snapshots
```

The separation prevents the answer key from entering Qodo's review context. Nothing private is exported to `examples/`. Build the smallest working slice first; this layout is the target, not a Day 1 requirement.

## Stack

TypeScript and Node.js. Fastify or an equally lean HTTP framework. Vitest for tests. SQLite or an in-memory store. Plain scripts and a small CLI, no orchestration platform. Static HTML for the Debate Chamber, reading sanitized JSON. Append-only JSONL with a single writer for events; reports are derived views, never the source of truth. Challenger tests run in disposable worktrees or containers with time, resource, and network limits, and never with real credentials.

## Record contracts

**Private ledger entry** (never leaves private storage; an illustrative shape, not a copy of a real entry):

```json
{
  "caseId": "FF-0001",
  "kind": "sabotage",
  "templateId": "idempotency-guard-bypass-v1",
  "invariantId": "INV-IDEMP-001",
  "defectClass": "idempotency",
  "targetCommit": "<sha>",
  "injectedFile": "src/bookings/create.ts",
  "injectedLines": [42, 57],
  "proofTest": "<private artefact id>",
  "validated": true,
  "createdAt": "2026-11-02T00:00:00Z"
}
```

**Public case record** (published only after adjudication, sensitive fields stripped):

```json
{
  "caseId": "FF-0001",
  "kind": "sabotage | control",
  "targetCommit": "<sha>",
  "pr": { "repo": "...", "number": 0 },
  "review": { "path": "cli | pr-comments", "configVersion": "...", "reviewedAt": "..." },
  "findings": [{ "id": "...", "file": "...", "lines": [0, 0], "category": "...", "summary": "..." }],
  "detection": { "caught": true, "matchedFindingIds": [] },
  "challenge": { "findingId": "...", "hypothesis": "...", "testArtefact": "...", "mechanismCovered": true, "result": "..." },
  "verdict": "supported | disproven | inconclusive | not_run",
  "arbiter": { "policyVersion": "...", "routedTo": "pr | human | audit-only" },
  "human": { "disposition": "...", "adjudicatedAt": "..." },
  "status": "complete | incomplete"
}
```

Every durable event also carries an event id, type, UTC timestamp, tool and agent version, environment id, and input snapshot hash.
