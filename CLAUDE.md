# FaultForge: instructions for coding agents

FaultForge plants known bugs in a small target codebase, has Qodo review them as ordinary pull requests, and scores each review against a private answer key. The integrity of every result depends on the reviewer never getting a hint. Treat the rules below as hard constraints.

## Three repositories

| Repo | Visibility | Holds | Never holds |
|---|---|---|---|
| `faultforge` (this one) | public | harness, adjudicated templates, docs, sanitized results | answer key, raw evidence, unreleased templates |
| `faultforge-target` (`../faultforge-target`) | public, reviewed by Qodo | the booking API and its ordinary tests | any mention of FaultForge, planted bugs, cases, proof tests or the answer key |
| `faultforge-private` (`./private`, git-ignored here) | private | answer key, audit events, case records, raw evidence, unreleased templates, `BACKLOG.md`, charter | — |

- `private/` is its own git repository. Commit and push it after every case. It must never be added to this repo.
- A `PreToolUse` hook (`.claude/hooks/guard-target.ts`) blocks commits, PRs, comments and file edits in the target that contain giveaway words, and blocks force pushes to the target. If it blocks something, reword it. Don't work around it. It scans the whole shell command, so run target-repo actions in their own command, never chained with work in this repo.

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
3. No hints about the Day 15 reveal before Day 15.
4. Record decisions made and results measured. To-dos, worries and half-formed ideas go in `private/BACKLOG.md`.

## Templates

- Write new templates and their proof tests in `private/templates/<id>/`. Copy one to `templates/seed/` only after its case is adjudicated. Held-back benchmark templates never go public.
- `npm run inject` looks in `private/templates/` first, then `templates/seed/`. It refuses branch names or commit messages that give the case away.

## Commands

```bash
npm run check                                        # typecheck, lint (Biome) and tests
npm run format                                       # apply Biome's formatting and safe fixes
npm run inject -- --template <id> --target ../faultforge-target --case FF-NNNN
cd ../faultforge-target && npm run check             # same three checks in the target
```

Run `npm run check` before every commit, in this repo and in the target (planted-bug branches excepted: the inject command validates those). Don't commit or push if a check fails. Both repos share the same Biome settings; keep `biome.json` identical in both.

## Daily routine

Use `/daily-challenge` at the start of each hackathon day and `/new-case` to run a case end to end. In short: read `private/BACKLOG.md` and the day's challenge, pick the smallest increment that meets it, build one testable slice, get it reviewed, record the entry in `docs/decision-log.md`, and push all three repositories.

## Style

- Plain English in docs, commit messages and posts. Short sentences.
- No attribution trailers in commits or PRs.
- Keep it lean: plain TypeScript scripts, no agent frameworks or orchestration platforms.
