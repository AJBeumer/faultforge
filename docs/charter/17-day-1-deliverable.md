# 17. Day 1 deliverable

Part of the [FaultForge charter](../CHARTER.md), version 2.3.

**Capability:** inject one reproducible idempotency defect into an otherwise working booking API.

- [ ] `POST /bookings` accepts an idempotency key.
- [ ] Correct code returns the original booking on repeat submission.
- [ ] A deterministic injection command creates the faulty variant.
- [ ] A private proof test shows the variant violates INV-IDEMP-001.
- [ ] The private ledger records template, location, target commit, and proof artefact.
- [ ] The faulty change is published as a focused GitHub PR with a neutral description.
- [ ] Qodo reviews the PR. The actual findings and reviewed commit are stored.
- [ ] The outcome is recorded as case FF-0001: detected, missed, or review incomplete.
- [ ] The Day 1 discussion post shares only actual results and one engineering lesson.

Day 1 is a success even if Qodo misses the defect. That is an honest benchmark result, which is the point of the lab.
