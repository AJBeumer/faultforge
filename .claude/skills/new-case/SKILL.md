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
- Ask the owner to confirm that Qodo → Repositories → Relationships shows **no active relationship** for faultforge-target. Qodo discovers relationships in the background, and an active one lets it read FaultForge during the review. Record the answer in the case record (`review.relationships`). Also record the Qodo configuration version.
- Run `npm run qodo:check` from this repository's root, never from `private/` (the script lives in the root `package.json`), with `QODO_KEY_FILE` set. Exit 0: Qodo matches the highest-numbered snapshot in `private/config/qodo-vN/` (rules on every page, review skills, no relationship on the target); the live answers are saved under `private/raw-artifacts/qodo-state/<timestamp>/`, so name that folder in the case record as its `qodo-state`. Exit 1 with a printed list of differences: the reviewer changed; stop and tell the owner. A non-zero exit without that list (npm reporting a missing script, a crash) is a tooling problem, not drift: treat it like exit 2. Exit 2: the check could not run (key, snapshot, API); fix the setup before any case. Never work around a difference by editing the snapshot: that is the owner's decision, recorded in the decision log.
- The template's `publish.branch` doesn't already exist locally or on GitHub. If it does, stop and ask for a new branch name. Don't delete old case branches: they are evidence.

## 2. Plant and validate

```bash
npm run inject -- --template <id> --target ../faultforge-target --case <FF-NNNN>
```

This writes the ledger entry, an audit event and artefacts under `private/raw-artifacts/<case>/`. If it fails validation, report why and stop. Don't edit the template to force it through without telling the owner.

## 3. Publish the PR

```bash
git -C ../faultforge-target push -u origin <branch>
gh pr create --repo AJBeumer/faultforge-target --base main --head <branch> --title "<commit message>" --body "<one plain sentence>"
```

- The title equals the commit message. The body is one ordinary sentence about the change, never about bugs, tests or reviews.
- If `gh pr create` fails with a permission error, give the owner the compare link (`https://github.com/AJBeumer/faultforge-target/compare/main...<branch>?expand=1`), the title and the body, and wait for the PR number.
- Not a draft. No reviewers, labels or assignees.
- Record the PR: append an audit event `pr.opened` with the PR number and head commit, and check that the head commit equals the ledger's `injectionCommit`.

## 4. Capture the review

Wait for Qodo's "Code Review by Qodo" comment (usually 1 to 3 minutes; give up after 15 and record `review incomplete`). Then save raw output:

```bash
D=private/raw-artifacts/<case>
gh api repos/AJBeumer/faultforge-target/issues/<n>/comments > $D/qodo-issue-comments.raw.json
gh api repos/AJBeumer/faultforge-target/pulls/<n>/reviews   > $D/pr-reviews.raw.json
gh api repos/AJBeumer/faultforge-target/pulls/<n>/comments  > $D/pr-review-comments.raw.json
```

- Check that the review references the ledger's `injectionCommit`.
- Any review by another bot (e.g. Copilot) is saved but doesn't count. Note who posted first.
- Once the Day 2 capture script exists, use it instead of these commands.

## 5. Match

For each Qodo finding, take its file and line range (from the "Fix Focus Areas" in its agent prompt if there are no inline comments). Apply the fixed rule: same file as `injectedFile`, lines overlap `injectedLines`, description matches the ledger's `defectClass` or invariant. Report the result per criterion.

- If a finding describes a real problem the ledger doesn't list, try to reproduce it with a small test before believing it. If it holds, record it as collateral, and propose an append-only ledger amendment.
- Don't decide the verdict alone.

## 6. Owner's verdict

Show the owner: the finding(s), the match per criterion, any collateral, and the timing. Ask them to confirm `detected`, `missed` or `review incomplete`. Only after they confirm:

- write `private/cases/<case>.json` (same shape as `FF-0001.json`) with `human.disposition` and `status: complete`
- append a `case.adjudicated` audit event

## 7. Close out

- Never click **Dismiss** on a Qodo finding and never chat with Qodo on a case PR. Qodo's PR history indexing learns from both, which would bias later cases.
- Give the owner a neutral closing comment for the PR ("Closing without merging…", describing the review's point as an ordinary code issue). They close the PR.
- Commit and push `private/`: `Add <case>: <template id>, <verdict>`.
- Add the result to today's entry in `docs/decision-log.md`, then commit and push FaultForge.
- If the template is now adjudicated and not held back for the benchmark, ask whether to copy it to `templates/seed/`.
- Tick off related items in `private/BACKLOG.md`.
