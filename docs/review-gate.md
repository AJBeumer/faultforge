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
which adds that tree to git's object store and nothing else. It does not block a commit, and nothing runs
it automatically any more (see below).

## What the saved evidence shows (14 November)

Every saved local review was read with the gate's own rules (#254).

| Saved local reviews | Checkpoint kept | Coverage complete | Finding list complete | Covers a tree |
|---|---|---|---|---|
| 5 from the Qodo toolbox CLI (12 November) | yes | yes | yes | yes |
| 12 from `review:local` (the API key) | no, `checkpoint_unavailable` | yes | no | no |
| 17 others from Day 8 experiments | no (`checkpoint_unavailable` or `superseded`) | yes | no | no |

So Qodo's "finding list complete" flag follows whether it kept a checkpoint for the review. The API key that
`review:local` uses has never got one. That is a measured pattern, not a documented rule: Qodo doesn't say
what the flag means, and we have not tested it further. Testing it means sending new reviews to Qodo, which
is the owner's decision.

What follows from it:

- **No `review:local` run has ever been accepted**, by the gate or by `review:local` itself (it ends with
  exit 3 for the same reason). Only reviews made with the toolbox CLI with a checkpoint have covered a tree.
- **The gate still refuses those runs.** Treating a review that Qodo marks as incomplete as complete would
  be a guess about what Qodo meant. When the gate says "not covered" for such a review, it now gives Qodo's
  reason (`checkpoint_unavailable: it kept no checkpoint`), not "incomplete coverage", because the coverage
  was complete.

## The warning after a commit was retired

From #184 to #254, a Claude Code hook (`.claude/hooks/review-gate-note.ts`) ran `review:gate` after every
commit made through Claude Code in this repository. It showed a note when no finished local review had seen
the committed files. It never blocked anything.

It was removed (#254) because it told nobody anything. Agents can only make local reviews with
`review:local`, and the gate has never accepted one of those. The toolbox CLI that can make an acceptable
review is the owner's to run. So the note appeared after every commit, whether or not a review had run. A
warning that always fires carries no information, and it teaches people to ignore warnings.

The `review:gate` command stays. It is still the way to check a commit by hand against a saved toolbox
review. If a way is found for `review:local` to get a checkpoint, wire the gate in again, and this time as a
git pre-commit hook, which sees what is really staged. A Claude Code hook runs before the command and can't
see what `git commit -a` will stage.
