---
name: daily-challenge
description: Start or finish a FaultForge hackathon day - read the backlog and the day's challenge, plan the smallest increment that meets it under the charter, and at the end write the decision-log entry and push all repos. Use when the user shares a new daily challenge, says "start day N", or asks to wrap up the day.
---

# FaultForge daily challenge

The charter is `docs/CHARTER.md`; its daily challenge protocol (section 16) is the source for this routine.

## Start of day

1. Read `private/BACKLOG.md`, the open tickets (`gh issue list --repo AJBeumer/faultforge`), the latest entry in `docs/decision-log.md`, and the roadmap row for today in the charter (section 16).
2. Read the day's challenge text. Its acceptance requirements are mandatory, even when they change the planned order.
3. Check that all three repos are clean and in sync (`git status -sb` in `.`, `private/` and `../faultforge-target`).
4. Run `npm run qodo:check` (`QODO_KEY_FILE` set). Exit 0: the reviewer matches the current snapshot. Exit 1: the reviewer changed since the snapshot; stop and tell the owner, with the printed differences. Only the owner decides, because results are only comparable under the same configuration: either Qodo is restored to the snapshot, or the owner records a new configuration version in the decision log and takes a new snapshot folder. Never create or edit a snapshot to make the check pass. Exit 2: the check could not run; fix the setup first.
5. Propose a plan to the owner, in plain English:
   - the challenge's requirements, quoted
   - the smallest increment that meets them and strengthens FaultForge
   - what changes and what stays fixed (match rule, Qodo configuration, published history)
   - which backlog items it closes
   - anything the owner must do by hand (browser steps, tokens)
6. Wait for agreement before building. If the challenge conflicts with the charter, adapt the implementation. Don't manufacture irrelevant features.

## During the day

- Build one testable slice. Run cases with `/new-case`.
- Keep the rules in `CLAUDE.md`. In particular, never reveal unreleased templates, the answer key or case ids in the target repo.
- Pick the day's work from the open tickets (GitHub Issues), in the order the owner gives. New work gets a ticket first.

## End of day

1. Write today's entry in `docs/decision-log.md`:

   ```markdown
   ## Day NN: [challenge title]
   - **Challenge requirement:**
   - **Increment delivered:**
   - **What changed from the plan and why:**
   - **Tests and Qodo evidence:**
   - **Lesson or decision:**
   - **Remaining risk:**
   ```

   Measured results only, with links to PRs and commits. Before writing, check the entry against the decision-log rules in `CLAUDE.md`: only adjudicated cases, nothing about held-back cases, and planned work goes in a ticket instead.
2. Update the Status table in `README.md` if a milestone changed.
3. Update `private/BACKLOG.md`: tick finished items, add new ones.
4. Commit and push FaultForge, `private/`, and the target if it changed. Plain-English commit messages, no attribution lines.
5. Draft the discussion post for the owner: the challenge's prompts, actual results, and one lesson. Mark the audience at the top of your reply.
