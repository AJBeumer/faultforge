# 6. Seed application

Part of the [FaultForge charter](../CHARTER.md), version 2.3.

**Working name:** `booking-api`. A tiny fictional booking service with an HTTP API, deterministic fixtures, and SQLite or an in-memory store. Chosen over payments to get business-critical invariants without provider dependencies. It exists to make failure modes understandable to judges and to keep the challenger's problem bounded. It is not a product.

## Invariants

| Id | Rule | Defect class |
|---|---|---|
| INV-IDEMP-001 | Reusing an idempotency key never creates a second booking | Idempotency guard bypass |
| INV-AUTH-001 | A user cannot read or cancel another user's booking | Authorization check omission |
| INV-VALID-001 | Invalid requests are rejected without changing state | Input-validation removal |
| INV-NULL-001 | Absent optional data never crashes an otherwise valid request | Null and undefined handling |
| INV-BOUND-001 | Date and quantity limits are enforced at documented boundaries | Boundary and off-by-one |
| INV-OVERLAP-001 | A resource is never double-booked for overlapping ranges | Logic error, deferred until the store supports it |

## Testability constraints

- Fixed test data, deterministic clock and ids, isolated storage per run.
- No network access to real providers. Bounded runs.
- Every fault is observable by a test within seconds.
- Invariants are readable independently of the implementation.
- The hidden proof tests are distinct from the public application tests.
- Do not retain a database constraint that silently neutralizes an injection, and do not pretend its absence is safe in production. This is an instrumented lab.
- Do not lead with concurrency.
