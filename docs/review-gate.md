# review:gate

Says whether the exact files a commit contains were seen by a finished local review. It turns
"review before you commit" from something you remember into something you can check.

```
npm run review:gate -- faultforge                 # what is staged now
npm run review:gate -- faultforge --commit HEAD   # a commit already made
```

## How it works

Qodo's local review records the git tree it reviewed: `meta.checkpoint.tree_sha`, or on a first run
`meta.run.snapshot.tree_sha`. A tree is a hash of every file's content, so two trees are equal only
when every file is identical. A commit made from exactly the files that were reviewed has that same
tree. The command reads the saved reviews under the evidence folder (`private/raw-artifacts/`, at any
depth), takes the tree of the staged files or of the commit you name, and looks for a match.

It was measured once before it was built: Qodo's second local review of ticket #126 recorded tree
`68fc3ac…`, and the first commit of that change has exactly that tree.

## What "covered" means

A saved review recorded this exact tree, and all of these hold: Qodo said its coverage was complete,
it reported its finding list as complete, it did not skip the review, and (when `split.json` sits
beside it) every changed file reached Qodo. These are the same conditions under which `review:local`
itself does not exit 3. A review made for another repository, or against a base commit this checkout
does not have, is ignored, even if the trees are equal. A review that names no repository counts only if its base commit is in this checkout. If `split.json` exists but cannot be read, the review counts as incomplete. If part of the evidence folder cannot be read, "not covered" is exit 2, never an answer. The review can be from any time: if the files are identical, an old review
still saw them.

## What it does not say

- **It does not say the findings were fixed or dismissed.** A covered tree can still have open
  findings. Read the review for that.
- **It does not say the review was a good one.** It says one ran on these files.
- **A review of a pull request is not a local review.** Saves under `reviews/` are never read. Only others that record a tree
  count. A commit that was only reviewed on its pull request shows as not covered.
- **A review that does not say its coverage was complete counts as incomplete.** Silence is not
  coverage.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Covered |
| 1 | Not covered. The output says why, and names the nearest reviewed tree and how old it is. |
| 2 | Could not read the evidence or the tree (a bad option, no such commit, no saved review found) |

## Reading only

The command changes no branch, file, review or label. Reading the staged tree uses `git write-tree`,
which adds that tree to git's object store and nothing else. It does not block a commit. Wiring it
into a hook or a skill is a separate decision.

## The warning after a commit

A hook (`.claude/hooks/review-gate-note.ts`, registered in `.claude/settings.json`) runs after every
`git commit` made in this repository. It runs `review:gate` on the new commit (`--commit HEAD`) and,
when no finished local review saw those exact files, shows a short note to the person and the agent.
It checks the commit that was really made, so `git commit -a`, `git add … && git commit` in one
command and an amend are all judged correctly.

It only warns. It never blocks or undoes a commit, and any failure of the hook ends in silence or a
note. It stays silent for commits in other repositories (`git -C`, `cd`), for dry runs, for
unattended factory runs, and when `FAULTFORGE_GATE=off` is set. A commit that was only reviewed on
its pull request, or a docs-only commit Qodo skips, shows the note too: the note says what it knows.

Blocking a commit would need a git pre-commit hook instead, because a Claude Code hook cannot see
what `git commit -a` will stage. That is a separate decision.
