# Blind review of PR 149 (stale premise gate)

Reviewed: `pr-147.diff` against ticket `ticket-premise-gate.md`, with `ticket-ready.ts`, `factory-tick.ts`, `factory-config.ts` and `factory.json` on branch `stale-premise-gate` read for the call sites. No tests run, no other reviewer's output seen.

## Findings

### 1. Premises are checked against the owner's live checkouts, not `main` (must fix)
- File/line: `packages/harness/src/ticket-ready.ts`, diff lines 481-486 and 497-500 (`checkoutOf` defaults to `resolve(LAB_ROOT, path)`; siblings likewise).
- Trigger: `factory:tick` picks up a ticket while the lab checkout is on a feature branch (today: `stale-premise-gate`, which adds `ticket-premises.ts`) or while `../faultforge-target` is on a case branch, or either has uncommitted or untracked files.
- What goes wrong: the ticket says every item is checked "against `main`" and "in the checkout at `main`", and the runner then builds in fresh worktrees from `origin/main` (`factory-tick.ts` header, line 1558). The gate reads whatever is on disk: a file that exists only on the owner's branch passes the gate and the agent then starts on a `main` that lacks it (the exact failure the ticket exists to prevent); a file deleted on the owner's branch but present on `main` is reported stale. The result also varies with the owner's working state, so a "ready" verdict is not reproducible.
- Fix: read `main` rather than the working tree, e.g. `git -C <checkout> ls-tree -r --name-only origin/main` for the file index and `git show origin/main:<path>` for `package.json` and source files, or run the check inside the run's worktrees after they are created.

### 2. The "introduces" window does not stop at a line break, so premises after any "new"/"adds" line are silently skipped (must fix)
- File/line: `packages/harness/src/ticket-premises.ts`, diff line 238 (`INTRODUCES = /\b(?:new|...|writes?)\b[^`.]*$/i`) and 265-266.
- Trigger: a Notes list such as `- Adds a dry-run flag` followed by `- Reads \`src/gone.ts\` for the list`, or prose like "In the new runner, `src/old.ts` is read". List items rarely end in a period, so nothing between "Adds"/"new" and the token breaks the match.
- What goes wrong: `src/gone.ts` is classified as introduced and never checked. A false negative is exactly the case the gate exists for, and it is invisible: the ticket is reported ready.
- Fix: stop the window at a newline and at sentence ends: `[^`.\n;:]*$`, and consider limiting the look-back to the current list item.

### 3. `node:fs`-style module specifiers are classified as npm scripts and reported stale (must fix)
- File/line: `packages/harness/src/ticket-premises.ts`, diff line 235 (`SCRIPT = /^[a-z][\w-]*:[a-z][\w-]*$/`) and 250.
- Trigger: a harness ticket that says "use `node:fs` instead of `fs`", or names `node:child_process`, `node:path`; equally any GitHub search qualifier in backticks such as `is:open`, `state:open`, `label:ready-for-agent`.
- What goes wrong: `stale premise: node:fs (script) not found` makes a correct ticket not ready, the runner relabels it `agent-needs-help`, and the owner has to edit wording to get past the gate. Node builtins are routine vocabulary in this codebase's tickets, so this will fire.
- Fix: exclude known non-script prefixes (`node:`, `is:`, `label:`, `state:`, `repo:`, `sort:`), or only treat `a:b` as a script premise when `a` is itself a script prefix that exists in `package.json` (`a:*` or `a`).

### 4. `npm run <name> -- <args>` is never checked (should fix)
- File/line: `packages/harness/src/ticket-premises.ts`, diff line 243 (whitespace rejection runs before `NPM_RUN` at line 244).
- Trigger: `npm run inject -- --template x`, `npm run ticket:ready -- faultforge 47`, `npm run check -- --watch`: the forms CLAUDE.md itself uses.
- What goes wrong: after stripping `npm run `, the remainder contains spaces, so `classify` returns null and a script that does not exist (`npm run mutation:check -- --all`) passes the gate. The ticket's Done-when names `npm run <name>` as a required form.
- Fix: test `NPM_RUN` first and return its script; apply the whitespace rejection only to the non-`npm run` branches.

### 5. Built-in, library and non-exported function calls are reported as stale premises (should fix)
- File/line: `packages/harness/src/ticket-premises.ts`, diff lines 234, 249 (`FUNCTION`) and 294-296 (`exportedNames` matches only `export function|const|let`).
- Trigger: "`existsSync()` is enough", "the hook's `main()` reads stdin", "`gh()` has a 60 s timeout", "`describe()` blocks", "`JSON.parse` ..." (the last is safe only because of the dot).
- What goes wrong: `main` and `gh` in `ticket-ready.ts` are not exported, `existsSync` is Node's, so each yields `stale premise: X (function) not found` and blocks a sound ticket. The test at diff line 132-139 bakes this in (`hidden()` and `fromDependency()` are expected to be stale). The ticket's own "no false alarm on the control" motivation argues against it.
- Fix: also count names declared with `function <name>(` (not only exported) and names imported anywhere in the checkout (`import { ..., name, ... } from`), so library and private helpers that are really in use are not stale; report only names that appear nowhere.

### 6. The file walk throws on a dangling symlink, junction or unreadable directory; in the tick that leaves the ticket pickable forever (should fix)
- File/line: `packages/harness/src/ticket-premises.ts`, diff lines 281-289 (`allFiles` uses `readdirSync` + `statSync`, which follows links).
- Trigger: a dangling symlink or Windows junction anywhere under the lab or target checkout (see the project's own junction note), or a folder the process cannot read; a symlink cycle recurses until stack overflow.
- What goes wrong: `statSync` throws, `premiseProblems` throws, `checkTicket` throws. In `ticket:ready` that is exit 2, which is the documented meaning. In `factory-tick.ts` the `ready` call (line 871) happens before `claimed = pick`, so the catch at line 1014 only writes an `error` log line: no comment, no relabel, the ticket keeps `ready-for-agent`, and every later tick repeats the failure silently.
- Fix: `readdirSync(dir, { withFileTypes: true })`, skip `isSymbolicLink()` entries, and wrap each directory read in try/catch (skip, don't throw); optionally have the tick treat a thrown readiness check as a `needs-help` relabel.

### 7. Bare file names that live under `private/` are always reported stale (should fix)
- File/line: `packages/harness/src/ticket-premises.ts`, diff line 247 (only `private/...` paths are skipped) versus 278 (`private` is skipped in the walk that serves the `file` kind).
- Trigger: a lab ticket that says "append to `BACKLOG.md`", "amend `ground-truth.jsonl`", "read `audit-events.jsonl`": CLAUDE.md names these bare.
- What goes wrong: the path form is skipped by design, but the bare form is indexed from a walk that excludes `private`, so the same file gives `stale premise: BACKLOG.md (file) not found`. Inconsistent with the stated reason for skipping `private/` (it is simply not in a CI checkout), and a false alarm on the owner's machine where it is present.
- Fix: when `<checkout>/private` exists, include it in the bare-name index (it is never read for exports); when it does not, treat a bare name that is also a known private file as skipped, like the path form.

### 8. Other export forms are not recognised (nit)
- File/line: `packages/harness/src/ticket-premises.ts`, diff line 296.
- Trigger: `export default function name`, `export function* gen`, `export { a, b }` or `export { a as b }` at the bottom of a module, `export var`.
- What goes wrong: a real export reads as stale. The repository today uses `export function`/`export const` almost everywhere (three `export class` are the only other form), so the risk is low until a module is written differently.
- Fix: add `default\s+` and `\*?` to the regex and a second pass for `export\s*\{([^}]*)\}` names.

### 9. Export and file-name indexes cover the whole checkout, not the two folders the ticket names (nit)
- File/line: `packages/harness/src/ticket-premises.ts`, diff lines 278-302.
- Trigger: a helper that exists only in a `templates/seed/<id>/` proof test or under `docs/evidence/`, or (via the sibling) in the target's `src/`, named in a lab ticket as if it were a harness helper.
- What goes wrong: the premise passes although the harness does not have it; the ticket's Done-when limits the function check to `packages/harness/src/` and `.claude/hooks/`. Also a larger walk than needed on every run.
- Fix: index exports from the configured folders only (add a `premises.sources` list per repo in `factory.json`, defaulting to those two for the lab).

### 10. Fenced blocks indented inside list items, and `<details>` with attributes, are not stripped (nit)
- File/line: `packages/harness/src/ticket-premises.ts`, diff line 219.
- Trigger: a Notes bullet followed by an indented "  ```" example block (GitHub renders it as code), or `<details open>` / `<details markdown="1">`.
- What goes wrong: the fence regex is anchored at column 0, so the block's contents count as prose; any backtick token inside is checked. Low impact today because tokens inside code blocks rarely carry single backticks.
- Fix: allow leading whitespace before the fence (`^[ \t]*(```|~~~)` with a matching close) and `<details\b[^>]*>` for the open tag.

### 11. Path existence is case-insensitive on the owner's Windows checkout but the ticket targets CI (nit)
- File/line: `packages/harness/src/ticket-premises.ts`, diff line 330 (`existsSync(join(checkout, token))`) versus 332 (`Set.has`, case-sensitive).
- Trigger: `docs/Charter.md` for `docs/CHARTER.md`.
- What goes wrong: passes on NTFS, fails on a Linux CI checkout; and the two kinds disagree with each other on the same machine.
- Fix: resolve path premises through the same file index (`allFiles` relative paths, exact match) instead of `existsSync`.

### 12. "Out of scope" and "Why" sections are scanned as premises (nit)
- File/line: `packages/harness/src/ticket-ready.ts`, diff line 500 (only the first section and the checklist are excluded).
- Trigger: "Out of scope: a `premise:fix` script that rewrites the ticket" or "Why: there is no `docs/premises.md` yet".
- What goes wrong: tokens that the ticket explicitly says do not or will not exist are reported as stale premises.
- Fix: make the excluded sections configurable per repo in `factory.json` (`tickets.deliverables`) and include "Out of scope" by default.

## Not verifiable from the diff
- Done-when item 6 ("run once against the current open tickets, result in the PR") cannot be checked here; the PR text was not in scope.
- The Result says the report names "where it was looked for"; the message format in Done-when item 3 does not include it, and the implementation follows the Done-when. Including the checkouts searched ("not found in faultforge or target") would cost one string change.

## Verdict
The extraction and the per-kind existence checks are cleanly factored, tested with fixtures and wired into both `ticket:ready` and the tick with the exit codes intact, and the sibling-checkout rule is a sensible answer to cross-repo mentions. But the gate does not do what the ticket says in one central respect: it reads the owner's working checkouts, not `main`, while the agent builds from `origin/main`, so the verdict depends on the owner's current branch and can pass a premise that `main` lacks (finding 1). Two more things undercut its reliability as an unattended gate: the "introduces" look-back runs across line breaks and silently drops real premises (finding 2), and plain Node module specifiers like `node:fs` are reported as missing npm scripts (finding 3), which will block ordinary harness tickets. Findings 4 to 7 are smaller false negatives and false positives plus a crash path that leaves a ticket permanently pickable. I would fix 1 to 3 before merging, 4 to 7 soon after, and treat the rest as follow-ups.
