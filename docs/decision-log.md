# Decision log

One entry per daily challenge: what was asked, what was built, and what was learned.

---

## Day 1: Your factory's first delivery

- **Challenge requirement:** introduce the project, sign up for Qodo, build one small capability with a coding agent, open a focused PR, run a Qodo review, and share one lesson.
- **Increment delivered:** a small booking API with one invariant: sending the same request twice with the same idempotency key never creates two bookings. One injected bug bypasses the idempotency check, confirmed by a hidden test, and goes out as a normal-looking PR for Qodo to review. Recorded as case FF-0001.
- **What changed from the plan and why:** the injected bug is a one-line slip rather than a removed guard. On a repeat request, the code looks up the original booking by the idempotency key instead of the booking id it saved. Removing the whole guard would also have broken an existing public test, so the PR would have arrived with red CI and given the answer away. With this version, the target's own tests and typecheck still pass, and only the hidden proof test fails.
- **Tests and Qodo evidence:** [faultforge-target#1](https://github.com/AJBeumer/faultforge-target/pull/1), reviewed commit `c7ffd15`. Qodo's PR summary (14:27 UTC) and its code review (14:28 UTC) both flagged the bug. The review raised one finding, rated High, in `src/bookings/create.ts`, lines 24 to 61. It said a repeat request creates a second booking, and that a key equal to another user's booking id returns that user's booking. Under the fixed match rule, the right file, overlapping lines and the right kind of problem, **FF-0001 is detected**. I reproduced the second claim with a test: it holds.
- **Lesson or decision:** a one-line bug planted to break one rule actually broke two. Besides creating duplicate bookings (INV-IDEMP-001), it let one user read another user's booking (INV-AUTH-001). The answer key and the hidden test only knew about the first; Qodo found both. So the answer key has to record everything a planted bug breaks, not just what it was meant to break, or a reviewer's correct extra finding would be counted as noise.
- **Remaining risk:** Qodo's local structured review is not verified yet; that is the Day 2 gate. The finding's line range covers 38 lines, so "overlapping lines" is a loose test for wide ranges. The Qodo trial shows 14 days, not 30. GitHub also requested a Copilot review automatically. It posted after Qodo, so it didn't affect this case, but it has to be switched off for later ones.

### Decisions made today

- **Match rule fixed before any data.** A Qodo finding counts as a catch only if it names the injected file, overlaps the injected lines, and describes the right kind of problem. The rule is not loosened after seeing results.
- **Two repositories.** The harness lives here. The booking API lives in a separate target repository, so the answer key never sits next to the code Qodo reviews.
- **Neutral PRs.** Branch names, commit messages, and PR descriptions for injected bugs must read like ordinary changes.
- **Day 1 counts even if Qodo misses the bug.** A miss is an honest data point, not a failure.
- **The replay check is not in the target's own tests.** Repeat-request behaviour is checked only by the hidden proof test, so a planted bug there doesn't show up as a CI failure.
- **One reviewer per case.** Only Qodo reviews target PRs. Any other bot's output is saved but doesn't count. The two repositories are never linked in Qodo, so FaultForge's templates can't reach the review.
- **No force-pushes to the target's `main`.** Published history stays as it is. Cases record the exact commit that was reviewed.
- **One history rewrite in this repository, on Day 1.** The first commit's message had a `Co-Authored-By: Claude` line, which I removed so GitHub's contributor list matches who owns the project. Only that one line changed; files, authors and dates are the same. No case refers to this repository's commit ids. The target repository was not rewritten, so FF-0001's commits are unchanged. Claude Code is still the coding agent used to build this project.
