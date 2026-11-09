---
name: factory
description: Run the factory loop - take ready tickets one at a time, from either repo, in the owner's order, work each to an open PR with Qodo's completed review and evidence, and stop only at the owner's gates (approve a ticket, merge a PR, confirm a verdict). Logs every step. Use when the owner says "run the factory", "/factory", or gives a list of tickets to work through.
---

# The factory loop

Arguments: tickets in order, as `<repo> <N>` pairs from `factory.json`, e.g. `target 14, target 15, faultforge 49`. Without arguments, take the open items of the active epic in its listed order.

Read `CLAUDE.md` first. This loop is ordinary work: planted-bug cases go through `/new-case`, never through here.

## The owner's gates

The loop runs on its own between these, and stops at them:

1. **A ticket isn't ready.** `npm run ticket:ready` says why. The owner fixes the ticket; the loop doesn't fill the gap.
2. **A PR is ready to merge.** Only the owner merges.
3. **A review can't be settled by the loop:** Qodo skipped or didn't finish the review, a finding needs a decision about the product, three review rounds left an action-required finding open, or `revert:check` didn't show the PR's tests failing without its change (exit 1 or 2).
4. **Anything that changes the reviewer:** a ticket that edits a reviewed repo's `AGENTS.md` or `INVARIANTS.md` (a new Qodo configuration version). The loop builds it, but the owner approves the version before the PR is called ready.

It never merges, never dismisses or replies to a Qodo finding, and never changes Qodo's settings.

## For each ticket, in order

1. **Ready?** `npm run ticket:ready -- <repo> <N>`. Not ready, or blocked by a ticket whose PR isn't merged yet: log it as skipped with the reason, and go to the next ticket.
2. **Build it** with the `/work-ticket` routine: branch from an up-to-date `main`, a test per criterion plus a failure case, the repo's `check` from `factory.json`, a PR with the ticket link, criteria table and Must-not-break table. Commands for a reviewed repo run from its checkout.
3. **Wait for the real review:** `npm run review:wait -- <repo> <pr> --commit <sha>`, where `<sha>` is `git rev-parse HEAD` in the checkout you just pushed from. Right after a push GitHub can still show the old head, and without `--commit` the old commit's finished review would come back as the answer. It also saves the evidence on every run: each new version of Qodo's comments while it waits (Qodo rewrites them in place after a push), the raw API answer, and a `review.json` record, under `<evidence>/reviews/<repo>-pr<N>/`. Run it after every push, so every round has its own record. It needs `QODO_KEY_FILE` (or `QODO_API_KEY`) and `GH_TOKEN`. Don't pipe its output: a pipe hides the exit code, and a run that failed at once can look complete.
   - Exit 0: the review of the head commit is complete. Read **all open findings** it lists, not just the head's.
   - Exit 3: Qodo skipped the review. That's a gate: log it, the PR waits for the owner.
   - Exit 1: no completed review in time, or the PR head never became `<sha>` (or moved past it). That's a gate.
   - Exit 2: the tool couldn't run (usage, missing key, or `gh` or the API failing on every poll; a single failed poll is retried). Not a review result: fix the setup and run it again.
4. **Act on the findings**, as `/work-ticket` says: reproduce each with a failing test first, fix what's real, explain what isn't, push, and run `review:wait` again. At most three rounds; an action-required finding still open after that is a gate.
5. **Check the behaviour** on the running app (or with real commands for tooling), every criterion and a failure case. Save the transcript.
6. **Prove the tests:** `npm run revert:check -- <repo> <pr>`. In a scratch copy it runs the PR's new or changed tests with the change (they must pass) and without it (at least one must fail). Paste its output into the PR body under "How I checked it". It saves its record under `<evidence>/revert-checks/`. Don't pipe its output.
   - Exit 0: caught. A test fails without the change, as it should.
   - Exit 1: not proven. Every test still passes without the change. That's a gate: log it; the PR waits for the owner.
   - Exit 2: can't judge (no test file or no code file changed, the tests fail even with the change, or the copy couldn't be built). That's a gate too.
7. **Finish the PR:** fill in the results tables with what was observed, tick the ticket's verified criteria, save the evidence.
8. **Does it change the reviewer?** For a `reviewed` repo, list the PR's files (`gh pr diff <pr> --repo <github> --name-only`). If any of them is named `AGENTS.md` or `INVARIANTS.md`, in any folder, this is gate 4: log it as **waiting for the owner to approve a new Qodo configuration version**, never as ready to merge. Qodo picks up rule changes when they reach the default branch (seen on Day 3: about a minute after the merge), so the owner's merge is the moment the reviewer changes. Otherwise log it as **ready to merge**. Then go to the next ticket. Don't wait for the merge: a later ticket that depends on this one will be skipped as blocked, and picked up on the next run.

## The log

Append one entry per ticket to `<evidence>/factory-log/<YYYY-MM-DD>.md` as it happens:

```markdown
## <repo> <N>: <title>
- Ready: yes | skipped (<reason>)
- Branch / PR: <branch> → <PR link>
- Review rounds: <commit>: <effort>, <n> findings (<outcome per finding>) ; …
- Live check: <what was run, result>, transcript <path>
- Stopped at: <gate> | next ticket
```

At the end, print a short summary for the owner: what's ready to merge, what was skipped and why, and what needs a decision.
