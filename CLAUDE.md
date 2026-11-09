# FaultForge: instructions for coding agents

FaultForge plants known bugs in a small target codebase, has Qodo review them as ordinary pull requests, and scores each review against a private answer key. The integrity of every result depends on the reviewer never getting a hint. Treat the rules below as hard constraints.

## Three repositories

| Repo | Visibility | Holds | Never holds |
|---|---|---|---|
| `faultforge` (this one) | public | harness, adjudicated templates, docs and charter, work tickets (Issues), sanitized results | answer key, raw evidence, unreleased templates |
| `faultforge-target` (`../faultforge-target`) | public, reviewed by Qodo | the booking API and its ordinary tests | any mention of FaultForge, planted bugs, cases, proof tests or the answer key |
| `faultforge-private` (`./private`, git-ignored here) | private | answer key, audit events, case records, raw evidence, unreleased templates, `BACKLOG.md` for anything that would reveal them | — |

- `private/` is its own git repository. Commit and push it after every case. It must never be added to this repo.
- A `PreToolUse` hook (`.claude/hooks/guard-target.ts`) blocks commits, PRs, comments and file edits in the target that contain giveaway words, and blocks force pushes to the target. If it blocks something, reword it. Don't work around it. It scans the whole shell command, so run target-repo actions in their own command, never chained with work in this repo.
- **Links go one way.** This repo's issues, PRs and commit messages may name target work as plain text ("target 3"), never as a link (`faultforge-target#3` or an issue/PR URL). GitHub would show "mentioned in faultforge#N" on the target's timeline, where Qodo reads it. Files such as the decision log may link to the target, because files don't create those events. The guard hook enforces this.
- `private/` is a separate repository inside this folder, and the shell's working directory can carry over between commands. Always use `git -C <path>` for git commands, so a commit can't land in the wrong repository.

## Rules for anything the reviewer can see

- Branch names, commit messages, PR titles and descriptions in the target must read like ordinary changes. No words such as sabotage, planted, inject, ledger, proof test, case ids, or the project's name.
- Only Qodo reviews target PRs. If another bot reviews one, save its output, mark it as not counting, and remove it from future PRs.
- Never merge a planted-bug PR. Close it without merging, with a normal-sounding comment.
- faultforge-target must have no active relationship in Qodo (Repositories → Relationships). Qodo discovers relationships in the background, and an active one would let it read this repository during a target review.
- Never dismiss a Qodo finding or chat with Qodo on a case PR. Qodo learns from both, which would bias later cases.
- Don't change Qodo's configuration without recording a new configuration version in the decision log. Results are only comparable under the same configuration.

## History and evidence

- Never force-push or rewrite `faultforge-target` history. Cases record exact commit ids.
- The answer key (`private/ground-truth.jsonl`) and audit log (`private/audit-events.jsonl`) are append-only. Correct them by appending an amendment entry, never by editing a line.
- The match rule is fixed: a finding counts as a catch only if it names the injected file, overlaps the injected lines, and describes the right kind of problem. Never loosen or tighten it after seeing results.
- Report only measured results. A miss is a valid result. When evidence is missing, the answer is "inconclusive", never "safe".
- A human (the project owner) confirms every verdict before a case is marked complete.

## Decision log (`docs/decision-log.md`)

The decision log is public on purpose: it shows judges that decisions came before results. Every entry must follow these rules:

1. Only adjudicated cases. Never mention a case, template or bug type before its review is done and the owner has confirmed the verdict.
2. Nothing about held-back benchmark cases, not even counts by type, until the final report.
3. Record decisions made and results measured. Planned work goes in a ticket; worries, half-formed ideas and anything that would reveal an unreviewed case go in `private/BACKLOG.md`.

The plan itself is public (`docs/CHARTER.md`, version 2.2), including Devil's Advocate and the arbiter. What stays private is what would let a reviewer, or a reader, know the answer before the review.

## Templates

- Write new templates and their proof tests in `private/templates/<id>/`. Copy one to `templates/seed/` only after its case is adjudicated. Held-back benchmark templates are published only with the final report.
- `npm run inject` looks in `private/templates/` first, then `templates/seed/`. It refuses branch names or commit messages that give the case away.

## Tickets

All FaultForge work is planned as GitHub Issues on `AJBeumer/faultforge`, grouped in milestones (one per phase of the charter roadmap).

- Every ticket states its **Result** and a **Done when** checklist that can be checked without judgement calls. Use the issue form (`.github/ISSUE_TEMPLATE/task.yml`).
- Work one ticket at a time, in the order the owner gives. The PR says `Closes #N`, and ticks the checklist only for criteria that were actually verified.
- Public tickets follow the decision-log rules above: they never name an unreviewed case, an unreleased template, or what a planned bug will be. Template work is described by count and defect class at most.
- Target tickets (`AJBeumer/faultforge-target` Issues) describe ordinary development work on the booking API and must read like any project's tickets. The guard hook checks them.
- Once ticketed cases start (#12, with its own configuration version), every case PR links a target ticket for the change it claims to make. The ticket describes the intended change, never the bug.
- Use `/work-ticket` for ordinary tickets: one at a time, its own branch and PR, the ticket link and acceptance criteria in the PR, Qodo's review saved straight away, and every criterion checked on the running app.

## Commands

```bash
npm run check                                        # typecheck, lint (Biome) and tests
npm run format                                       # apply Biome's formatting and safe fixes
npm run inject -- --template <id> --target ../faultforge-target --case FF-NNNN
cd ../faultforge-target && npm run check             # same three checks in the target
```

Run `npm run check` before every commit, in this repo and in the target (planted-bug branches excepted: the inject command validates those). Don't commit or push if a check fails. Both repos share the same Biome settings; keep `biome.json` identical in both.

## Daily routine

Use `/daily-challenge` at the start of each hackathon day, `/work-ticket` for each ticket, and `/new-case` to run a case end to end. In short: read `private/BACKLOG.md` and the day's challenge, pick the smallest increment that meets it, build one testable slice, get it reviewed, record the entry in `docs/decision-log.md`, and push all three repositories.

## Style

- The house rules in `AGENTS.md` apply to all work in this repository; Qodo reviews against them too.
- Plain English in docs, commit messages and posts. Short sentences.
- No attribution trailers in commits or PRs.
- Keep it lean: plain TypeScript scripts, no agent frameworks or orchestration platforms.
