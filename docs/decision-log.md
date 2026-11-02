# Decision log

One entry per daily challenge: what was asked, what was built, and what was learned.

---

## Day 1: Your factory's first delivery

- **Challenge requirement:** introduce the project, sign up for Qodo, build one small capability with a coding agent, open a focused PR, run a Qodo review, and share one lesson.
- **Increment delivered:** a small booking API with one invariant: sending the same request twice with the same idempotency key never creates two bookings. One injected bug bypasses the idempotency check, confirmed by a hidden test, and goes out as a normal-looking PR for Qodo to review. Recorded as case FF-0001.
- **What changed from the plan and why:** nothing yet.
- **Tests and Qodo evidence:** to be added after the review.
- **Lesson or decision:** to be added after the review.
- **Remaining risk:** Qodo's local structured review is not verified yet. That is the Day 2 gate.

### Decisions made today

- **Match rule fixed before any data.** A Qodo finding counts as a catch only if it names the injected file, overlaps the injected lines, and describes the right kind of problem. The rule is not loosened after seeing results.
- **Two repositories.** The harness lives here. The booking API lives in a separate target repository, so the answer key never sits next to the code Qodo reviews.
- **Neutral PRs.** Branch names, commit messages, and PR descriptions for injected bugs must read like ordinary changes.
- **Day 1 counts even if Qodo misses the bug.** A miss is an honest data point, not a failure.
