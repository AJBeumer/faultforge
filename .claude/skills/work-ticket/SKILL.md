---
name: work-ticket
description: Work one ticket end to end - read it from GitHub Issues, branch, build under the project's rules, open a PR with the ticket link and acceptance criteria, save Qodo's review, check every criterion on the running app, and fix what's confirmed. Use when the owner says "work ticket #N", "take the next ticket", or names tickets to work through in order.
---

# Work one ticket

Arguments: repo and ticket number, e.g. `target 4` or `faultforge 3`. One ticket at a time, in the order the owner gave.

Read `CLAUDE.md` first. In the target, also follow its `AGENTS.md`. This skill is for ordinary work. Planted-bug cases use `/new-case`.

Use the hackathon token for every `gh` call: `export GH_TOKEN="$(tr -d '\r\n' < 'C:/Users/aj_be/.github/PAT_GH_FF_BASIC_TARGET.txt')"`. Never print it. Run target commands on their own, never chained with commands for this repo (the guard hook scans the whole command).

## 1. Read the ticket

```bash
gh issue view <N> --repo AJBeumer/<repo>
```

- It must say what to deliver and have checkable acceptance criteria. If not, stop and ask the owner to fix the ticket.
- Check what it's blocked by. Don't start a blocked ticket.
- Move it to **In progress** on the board (FaultForge tickets only; the board doesn't track the target).

## 2. Branch and build

- Start from an up-to-date `main`. One branch per ticket, named after the change (`cancel-booking`), never after the ticket number.
- Write a test for every criterion, plus at least one failure case.
- `npm run check` must pass before committing.
- Editing the target's `AGENTS.md` or `INVARIANTS.md` changes Qodo's rules: that's a new configuration version. Record it in the decision log and snapshot it.

## 3. Open the PR

The title is the commit message. The body must give the reviewer the request alongside the change:

```markdown
Closes #N

Ticket: <link>

## Acceptance criteria and results
| Criterion | Result |
|---|---|
| <copied from the ticket> | <what you observed> |

## What changed
## How I checked it
```

Fill the Result column only with what you actually observed. Leave it blank until step 5.

## 4. Save Qodo's review straight away

Qodo rewrites its review comment in place after every push, so the first version is lost if you wait. Poll every 20 seconds (up to 20 minutes) and save the raw comments as soon as "Code Review by Qodo" appears, and again after each new commit:

```bash
D=private/raw-artifacts/day-NN
gh api repos/AJBeumer/<repo>/issues/<pr>/comments > $D/pr<pr>-issue-comments.<commit>.raw.json
gh api repos/AJBeumer/<repo>/pulls/<pr>/comments  > $D/pr<pr>-review-comments.<commit>.raw.json
```

## 5. Check the behaviour, not just the tests

A clean review doesn't mean the ticket is done.

- Run the app from the branch (target: `PORT=3000 npx tsx src/server.ts` in the background).
- Check every criterion and at least one edge or failure case with real requests. Show that a refused request left state unchanged by reading it back.
- Save the transcript to `private/raw-artifacts/day-NN/ticket-<N>-live-check.txt` and put the results in the PR table.
- Stop the server.

## 6. Act on the findings

For each Qodo finding:

- **Reproduce it first** with a failing test. If it reproduces, fix it, and the test must pass afterwards. If it doesn't reproduce, say so in the PR description with the evidence. Never click Dismiss and never reply to Qodo.
- Push, save the new review (step 4), and repeat the checks the fix touches.
- Note anything the review missed or raised that didn't matter.

Then decide, with the owner, whether the evidence calls for:

- a rule to add or clarify (`AGENTS.md` / `CLAUDE.md`), with its own ticket
- a repeatable task worth a skill
- context the reviewer was missing

## 7. Finish

- Tick only the ticket criteria you verified.
- Commit the saved evidence to `private/`.
- The owner merges. After the merge, update `main` locally and delete the branch.
- Record what happened for the day's decision-log entry: what was delivered, what Qodo found, what was confirmed, what changed.
