---
name: new-case
description: Run one FaultForge case end to end - plant a validated bug from a template, open a neutral PR on faultforge-target, capture Qodo's review, apply the fixed match rule, get the owner's verdict, and record everything in private storage. Use when the user asks to run, start or create a case (e.g. "run FF-0002 with template X").
---

# Run a FaultForge case

Arguments: template id and case id (e.g. `boundary-off-by-one-v1 FF-0002`). If either is missing, ask. Case ids are sequential: check `private/ground-truth.jsonl` for the last one.

Read `CLAUDE.md` first. Every step below obeys it.

## 1. Preconditions

- `private/` and `../faultforge-target` both have clean working trees, and the target is on `main` and in sync with `origin/main`.
- The template exists in `private/templates/<id>/` (preferred) or `templates/seed/<id>/`, with `template.json` and its proof test.
- Ask the owner to confirm that Qodo → Repositories → Relationships shows **no active relationship** for faultforge-target. Qodo discovers relationships in the background, and an active one lets it read FaultForge during the review. Pass the answer to `case:pr` (section 3) as `--relationships`; it records it in the `pr.opened` event with the configuration version, which `case:review` reads from there.
- Run `npm run qodo:check` from this repository's root, never from `private/` (the script lives in the root `package.json`), with `QODO_KEY_FILE` set. Exit 0: Qodo matches the highest-numbered snapshot in `private/config/qodo-vN/` (rules on every page, review skills, no relationship on the target); the live answers are saved under `private/raw-artifacts/qodo-state/<timestamp>/`, so name that folder in the case record as its `qodo-state`. Exit 1 with a printed list of differences: the reviewer changed; stop and tell the owner. A non-zero exit without that list (npm reporting a missing script, a crash) is a tooling problem, not drift: treat it like exit 2. Exit 2: the check could not run (key, snapshot, API); fix the setup before any case. Never work around a difference by editing the snapshot: that is the owner's decision, recorded in the decision log.
- `inject` picks the branch: the template's `publish.branch` when that name is free, otherwise the base name with the smallest free numeric suffix (`tidy-replay-lookup-2`), checked locally and on origin, and it prints the name it used. Use that name in every later step. Never delete or rename old case branches: they are evidence.

- Run `npm run case:ticket -- --template <id> --case <FF-NNNN> --dry-run` and read the issue text it prints. From configuration v7 every case, control or bug, has a target ticket; section 3 creates it. Stop if the dry run refuses (exit 1: the text would give the case away or links to a GitHub issue or PR).

## 2. Plant and validate

```bash
npm run inject -- --template <id> --target ../faultforge-target --case <FF-NNNN>
```

This writes the ledger entry, an audit event and artefacts under `private/raw-artifacts/<case>/`. If it fails validation, report why and stop. Don't edit the template to force it through without telling the owner.

## 3. Publish the PR

In this order, each command on its own:

1. **Create the target ticket.** `npm run case:ticket -- --template <id> --case <FF-NNNN>`, run in this repository and never chained with a target-repo command. It, the push and the PR need the GitHub token with write access to issues and pull requests (the default `gh` login lacks it). It prints the issue number `<N>`, records a `case.ticket-created` audit event and saves the raw `gh` output. Do this before pushing anything: if it refuses (exit 1), nothing has left the machine. Exit 2 means it could not tell whether the issue was created: check GitHub before retrying, never retry blindly.
2. **Push the branch,** on its own:

```bash
git -C ../faultforge-target push -u origin <branch>
```

3. **Open and record the PR** with `case:pr`, in this repository, never chained with the push. Start with `--dry-run`:

```bash
npm run case:pr -- --case <FF-NNNN> --body "<one plain sentence>" --relationships "<what the owner confirmed>" --dry-run
npm run case:pr -- --case <FF-NNNN> --body "<one plain sentence>" --relationships "<what the owner confirmed>"
```

- The title is the template's commit message; the body is your sentence followed by `Closes #<N>` from the case's ticket. The sentence is about the change, never about bugs, tests or reviews. `case:pr` refuses (exit 1) giveaway words, links to an issue or PR, a branch whose pushed head isn't the injected commit, a missing ticket, or a case that already has a PR; nothing has left the machine then.
- It checks that the template and proofs are still the ones the case was planted from, runs the Qodo configuration check itself (with `QODO_KEY_FILE` set) and refuses unless Qodo matches its snapshot, records that version and the folder the check saved, checks the opened PR's head against the answer key, and appends the `pr.opened` event itself. Never type that event by hand.
- Exit 2 means it couldn't finish: an earlier attempt's marker exists, `gh` failed, or the opened PR's head is wrong. Check GitHub before anything else; never retry blindly.
- If `gh` lacks permission, give the owner the compare link (`https://github.com/AJBeumer/faultforge-target/compare/main...<branch>?expand=1`), the title and the body, and stop: the owner decides how the event gets recorded.
- Not a draft. No reviewers, labels or assignees.

## 4. Capture the review

```bash
npm run review:wait -- target <pr> --commit <injectionCommit> --timeout 25
npm run case:review -- <FF-NNNN>
```

- `review:wait` waits until the PR head is the injection commit and Qodo's review of it is complete, saving every version of Qodo's comments and its raw API answer under `private/raw-artifacts/reviews/target-pr<pr>/`. Exit 0 complete; 1 not complete in time, or the head moved; 2 could not run, or a complete save of that commit already exists (a save is evidence and is never overwritten; an unfinished one is kept under another name when you wait again); 3 Qodo skipped the review (zero findings then does **not** mean clean).
- `case:review` appends the `review.recorded` event `case:build` needs, from that save: the PR, the review comment's URL and time, the configuration version from `pr.opened`. It refuses a save for another commit or PR, and a case that already has the event (exit 1). Run it whatever `review:wait` said: an inconclusive case needs its review stage too.
- Any review by another bot (e.g. Copilot) is saved but doesn't count. Note who posted first.

## 5. Match and verdict

```bash
npm run verdict -- <FF-NNNN>
```

`verdict` prints every finding against the fixed rule (same file as the injection, overlapping lines, a kind term from the template's `match.kindTerms` in its title, summary or category) and asks the owner, on a terminal, for the verdict and a judgement of every other finding. It appends one `case.adjudicated` event; nothing is written until every question is answered.

- A bug case: `detected`, `missed` or `review incomplete`. An answer the rule contradicts is recorded only after the owner confirms it.
- A control: `clean` when Qodo raised nothing, `false alarm` when it raised something on the harmless change (each finding judged), `review incomplete` when the review didn't finish. A finding judged real refuses the verdict: the control wasn't clean.
- When the saved review didn't finish, only `review incomplete` is offered.
- If a finding describes a real problem the ledger doesn't list, try to reproduce it with a small test before believing it. If it holds, record it as collateral, and propose an append-only ledger amendment.
- Don't decide the verdict alone: `verdict` asks the owner.

## 6. Build the record

```bash
npm run case:build -- <FF-NNNN> --save
```

`case:build` builds the record from the answer key, the audit events and the saved review, checks it against the schema and for private text, prints it, and with `--save` writes it to `private/cases/<FF-NNNN>.json` itself. Never copy a record by hand. It refuses (exit 2) when the saved review, the template or the answer-key entry changed after the verdict, when a final verdict stands on a review that didn't finish, or when `private/cases/` already holds a different record: report it to the owner, never work around it. `private/cases/<FF-NNNN>.overlay.json` is only for prose no event holds; a case with none needs no overlay. Publishing (`--write`, into `examples/`) stays behind the owner's go-ahead.

## 7. Close out

- Never click **Dismiss** on a Qodo finding and never chat with Qodo on a case PR. Qodo's PR history indexing learns from both, which would bias later cases.
- Give the owner a neutral closing comment for the PR ("Closing without merging…", describing the review's point as an ordinary code issue). They close the PR.
- Commit and push `private/`: `Add <case>: <template id>, <verdict>`.
- Add the result to today's entry in `docs/decision-log.md`, then commit and push FaultForge.
- If the template is now adjudicated and not held back for the benchmark, ask whether to copy it to `templates/seed/`.
- Tick off related items in `private/BACKLOG.md`.
