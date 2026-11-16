# FaultForge: instructions for coding agents

FaultForge plants known bugs in a small target codebase, has Qodo review them as ordinary pull requests, and scores each review against a private answer key. The integrity of every result depends on the reviewer never getting a hint. Treat the rules below as hard constraints.

Each rule below is one short bullet. Where a rule needs more explanation, the bullet links to a page under `docs/rules/` that has it. The linked pages are part of these rules. The [docs start page](docs/README.md) maps everything else.

## Three repositories

`faultforge` (this one, public), `faultforge-target` (`../faultforge-target`, public, reviewed by Qodo) and `faultforge-private` (`./private`, private, git-ignored here). What each one holds and never holds: [docs/rules/three-repos.md](docs/rules/three-repos.md).

- The target never holds any mention of FaultForge, planted bugs, cases, proof tests or the answer key. This repo never holds the answer key, raw evidence or unreleased templates.
- `private/` is its own git repository. Commit and push it after every case. Never add it to this repo.
- Always use `git -C <path>` for git commands, so a commit can't land in the wrong repository.
- **Links go one way.** Name target work here as plain text ("target 3"), never as a link. [Why](docs/rules/three-repos.md).
- Every write to the target goes through one door: `npm run target:post -- <kind> ...`, run on its own from this repo's root, with the title and body in files. [Details](docs/rules/guard.md).
- The guard hook refuses every other write aimed at the target. If it blocks something, use the door or reword it. Don't work around it. Run target-repo actions in their own command, never chained with work in this repo. [Details](docs/rules/guard.md).

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

The plan itself is public (`docs/CHARTER.md`, version 2.3), including Devil's Advocate and the arbiter. What stays private is what would let a reviewer, or a reader, know the answer before the review.

## Templates

- Write new templates and their proof tests in `private/templates/<id>/`. Copy one to `templates/seed/` only after its case is adjudicated. Held-back benchmark templates are published only with the final report.
- `npm run inject` looks in `private/templates/` first, then `templates/seed/`. It refuses branch names or commit messages that give the case away.

## Tickets

All FaultForge work is planned as GitHub Issues on `AJBeumer/faultforge`. The full rules: [docs/rules/tickets.md](docs/rules/tickets.md).

- Every ticket states its **Result** and a **Done when** checklist that can be checked without judgement calls. Use the issue form.
- Work one ticket at a time, in the order the owner gives. The PR says `Closes #N`, and ticks only criteria that were actually verified.
- Public tickets follow the decision-log rules above: never name an unreviewed case, an unreleased template, or what a planned bug will be.
- Target tickets read like any project's tickets. Every case PR links a target ticket that describes the intended change, never the bug.
- Use `/work-ticket` for ordinary tickets.

## Commands

```bash
npm run check                                        # typecheck, lint (Biome) and tests
npm run format                                       # apply Biome's formatting and safe fixes
npm run inject -- --template <id> --target ../faultforge-target --case FF-NNNN
cd ../faultforge-target && npm run check             # same three checks in the target
```

Run `npm run check` before every commit, in this repo and in the target (planted-bug branches excepted: the inject command validates those). Don't commit or push if a check fails. Both repos share the same Biome settings; keep `biome.json` identical in both.

## Daily routine

Use `/daily-challenge` at the start of each hackathon day, `/work-ticket` for each ticket, and `/new-case` to run a case end to end. In short: read `private/BACKLOG.md` and the day's challenge, pick the smallest increment that meets it, build one testable slice, get it reviewed, record the entry in the decision log (the current week's file under `docs/decisions/`), and push all three repositories.

## Code layout

The full rules and the reasons: [docs/rules/code-layout.md](docs/rules/code-layout.md).

- A unit test sits next to the code it tests, as `<name>.test.ts` in the same folder.
- Tests must pass on Linux (CI) and Windows. Build expected paths with `resolve()` or `join()`. A red Windows job is a real bug to fix, never waved through.
- A slow or end-to-end test lives under `packages/<package>/test/` and runs with `npm run test:integration`, never in `check`.
- A helper two scripts need lives in a named module, never as a copy in each script.
- No module may pass 400 lines. Split it along its seams.
- Every script documents its exit codes in its header comment, and each code means one thing.

## Style

- The house rules in `AGENTS.md` apply to all work in this repository. Check your own work against them; don't assume the reviewer will.
- Plain English in docs, commit messages and posts. Short sentences.
- No attribution trailers in commits or PRs.
- Keep it lean: plain TypeScript scripts, no agent frameworks or orchestration platforms.
