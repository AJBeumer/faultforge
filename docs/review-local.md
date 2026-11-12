# Reviewing uncommitted changes before you commit

```bash
npm run review:local -- faultforge
npm run review:local -- target --isolated
npm run review:local -- faultforge --timeout 15
```

Submits the current working tree's staged, unstaged and untracked changes to Qodo's local review
(`start-pre-pr-review`), polls at the interval Qodo itself returns, and reads the result back once
it's done. Before anything is sent, the split of the working tree — which paths are staged, unstaged
or untracked, and how many of each — is written next to the saved review, so answering "what was
uncommitted when this ran" never needs a session transcript. Every raw answer (the submission, each
poll, each result chunk) is saved under `private/raw-artifacts/local-reviews/<operation id>/` as it
arrives, never only after the run finishes.

Each finding is printed with its file, lines, category and severity, and labelled from the review's
own `finding_state`: "new" when this run introduced it, "carried over" otherwise. A carried-over
finding is not independent evidence that this run's change has a problem — it may be the same finding
a different, unrelated change surfaced earlier from the same working folder.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Completed; no open action-required finding |
| 1 | Completed; at least one open action-required finding |
| 2 | Could not run (no uncommitted change to review, a transport failure, the operation failed or timed out, the result didn't verify) |
| 3 | Never a clean result: Qodo skipped the review, its coverage was incomplete, the finding list was not reported complete, or a changed file never reached it (listed in `split.json` and the run output) |

A skipped or partial review is never reported as exit 0: zero findings from a review that didn't
really run proves nothing.

## When to use `--isolated`

Qodo keys a local review's open findings by the working folder it was run from, not by the change
reviewed. Run it twice from the same checkout — once on a planted bug, once on an unrelated clean
change — and the second run's answer can include the first run's finding, carried forward, looking
like independent agreement when it is the same finding repeated. This surfaced on 12 November: a
batch of local reviews run one after another from one checkout carried a finding from an earlier case
onto later, unrelated ones.

`--isolated` reviews the same staged, unstaged and untracked changes from a fresh temporary git
worktree instead of the current one, and removes the worktree once the review is done. A fresh
worktree has never been reviewed before, so it cannot carry an earlier run's open finding forward.
Use it whenever a result needs to stand on its own — comparing a local review against a known answer,
reviewing several unrelated changes in a row from the same checkout, or any other case where an
earlier finding quietly carrying over would make the comparison meaningless. For an ordinary
review-before-you-commit on a branch nobody else has reviewed yet, the plain (non-isolated) run is
enough.
