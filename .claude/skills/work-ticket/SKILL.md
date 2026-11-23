---
name: work-ticket
description: Work one ticket end to end - read it from GitHub Issues, branch, build under the project's rules, open a PR with the ticket link and acceptance criteria, save Qodo's review, check every criterion on the running app, and fix what's confirmed. Use when the owner says "work ticket #N", "take the next ticket", or names tickets to work through in order.
---

# Work one ticket

Arguments: a repo key from `factory.json` and a ticket number, e.g. `target 4` or `faultforge 3`. One ticket at a time, in the order the owner gave.

**Repo settings come from `factory.json`, never from memory:** `github` (owner/name), `path` (local checkout), `guard` (`lab` or `reviewed`), `check` (must pass before every commit), `start` (how to run it for a live check, or null), `tickets` (required sections), `board` (tracked on the project board), and `evidence` (where saved reviews and transcripts go). Below, `<github>`, `<path>`, `<check>` and so on mean that repo's values. Read them, with the shared `evidence` folder, with `node -e 'const f=require("./factory.json"); console.log(JSON.stringify({...f.repos["<key>"], evidence: f.evidence}, null, 2))'`. Paths are relative to this repo.

Read `CLAUDE.md` first. In the target, also follow its `AGENTS.md`. This skill is for ordinary work. Planted-bug cases use `/new-case`.

In an interactive session, every `gh` call uses the owner's one GitHub token, exported as `GH_TOKEN` from the token file whose location is kept in the agent's memory, outside this repo. Never print it, and never write its location into a repo file. In an unattended factory run (`FAULTFORGE_FACTORY_RUN` is set) the keys are already in the environment: `gh` and `review:wait` pick them up by themselves. Don't look for a token file, and never name, read, print or export a key. Every write to a `reviewed` repo goes through one door, `npm run target:post` ([docs/target-door.md](../../../docs/target-door.md)), run on its own from this repository's root: issues, comments, PRs, closing a PR and pushing a branch. Write the title and body to files first, then pass the files: `npm run target:post -- pr-create --head <branch> --title-file <f> --body-file <f>`, `npm run target:post -- push --branch <branch>`. The door checks the exact text it sends, and exits 2 with the reason if anything would give the lab away. The guard refuses every other write to a reviewed repo (`gh issue`/`gh pr` writes, `gh api` writes, `curl` and the like, `git push`) without reading it. Reads (`gh pr view`, `gh api` GETs, `git fetch`, `git log`) and commits in its checkout work as usual. Commands for a reviewed repo still run on their own, never chained with commands for another repo.

## 1. Read the ticket

In an interactive session:

```bash
gh issue view <N> --repo <github>
```

- Check it's ready: `npm run ticket:ready -- <key> <N>`. It needs every section in `tickets.sections`, a checklist in `tickets.checklist`, and no open blockers.
- If it isn't ready, **stop**. Tell the owner exactly what the command reported, and don't start until the ticket is fixed. Don't fill the gap yourself and carry on.
- If `board` is true, move it to **In progress** on the project board. Repos with `board: false` stay off it, so a `reviewed` repo never links back here.

In an unattended factory run (`FAULTFORGE_FACTORY_RUN` is set), the runner has already checked readiness, snapshotted the ticket and claimed it. Read the ticket from the snapshot file, whose path the runner's instructions give (it is also `$FAULTFORGE_TICKET_FILE`; echo that one variable if you must, but never list the environment, which the policy blocks), and from nothing else: `gh issue view`, `gh api` on issues and `gh search` are blocked for this ticket. Skip `ticket:ready` (it reads the live ticket), and skip the board move (a write the runner's audit can't see; `gh project` writes are blocked in a run). The runner labels the ticket and reports on it.

## 2. Branch and build

- Start from an up-to-date `main`. One branch per ticket, named after the change (`cancel-booking`), never after the ticket number.
- Write a test for every criterion, plus at least one failure case.
- `<check>` must pass before committing, and CI runs it again on the PR. Run it on its own, never piped into another command: a pipe hides its exit code.
- **For a `lab` repo, get both operating systems green before the PR sees a commit:** commit, then `npm run ci:wait -- <key> --timeout 9` (nine minutes, so it ends before the Bash tool's ten and removes its scratch branch itself). It pushes the commit to a scratch branch with no PR, waits for the Linux and Windows checks, prints each job and deletes the branch. Exit 0: push to the PR's branch. Exit 1: a job failed; fix it and run it again. Exit 2: it couldn't tell. Qodo reviews pull requests only, so this costs no review round, and a push to a PR does. Do it before the first push and before every later one. A `reviewed` repo is written through the door only, so `ci:wait` refuses there.
- In a `reviewed` repo, editing `AGENTS.md` or `INVARIANTS.md` changes Qodo's rules: that's a new configuration version. Record it in the decision log and snapshot it.

## 3. Open the PR

The title is the commit message. For a `reviewed` repo, push and open it through the door (above): `npm run target:post -- push --branch <branch>`, then `npm run target:post -- pr-create --head <branch> --title-file <f> --body-file <f>`. The body must give the reviewer the request alongside the change:

```markdown
Closes #N

Ticket: <link>

## Acceptance criteria and results
| Criterion | Result |
|---|---|
| <copied from the ticket> | <what you observed> |

## Must not break
| Item | How checked |
|---|---|
| <copied from the ticket> | <what you observed> |

## What changed
## How I checked it
```

Fill the Result column only with what you actually observed. Leave it blank until step 5.

## 4. Save Qodo's review straight away

Qodo rewrites its review comment in place after every push, so the first version is lost if you wait. Start `review:wait` straight after every push, with the commit you just pushed:

```bash
npm run review:wait -- <key> <pr> --commit $(git -C <path> rev-parse HEAD)
```

It waits until the PR's head is that commit (right after a push GitHub can still show the old one), then until Qodo's API says the review of that commit is complete. On the way it saves every version of Qodo's comments, from every page of both comment feeds, plus the raw API answer and a `review.json` record, under `<evidence>/reviews/<key>-pr<pr>/`. It needs `QODO_KEY_FILE` (or `QODO_API_KEY`) and `GH_TOKEN`. Exit codes: 0 complete, 1 not complete in time or the head never became that commit, 2 couldn't run, 3 Qodo skipped the review (zero findings then does not mean clean).

## 5. Check the behaviour, not just the tests

A clean review doesn't mean the ticket is done.

- If `start` is null, check the delivered behaviour directly instead: run the command, the hook, or the script the ticket is about, with real input, and record what happened.
- Otherwise, first make sure `start.port` is free (`netstat -ano | grep ":<port> .*LISTENING"`). A leftover server answers just as convincingly as the new one.
- Run `PORT=<port> <start.command>` in `<path>`, in the background, and wait until `<start.health>` answers. Before checking anything, confirm the `pid` in the server's log is the process that owns the port.
- Check every criterion and at least one edge or failure case with real requests. Show that a refused request left state unchanged by reading it back.
- Save the transcript to `<evidence>/day-NN/<key>-ticket-<N>-live-check.txt` and put the results in the PR table.
- Stop the server with its whole process tree. Windows: `taskkill //PID <pid> //T //F`. Linux, where factory runs happen: `pkill -TERM -P <pid>; kill <pid>`, the children first, then the parent. Stopping the background task only ends `npx` and leaves Node listening.

## 6. Act on the findings

The quality gate in `factory.json` says which findings must be fixed and which are only listed for the owner ([docs/quality-gate.md](../../../docs/quality-gate.md)). `npm run gate:check -- <key> <pr>` applies it to the saved review of the PR's head. The task is done only when it exits 0.

For each Qodo finding the gate says to fix:

- **Prove it first with the `prove-finding` skill**, on a throwaway export of the reviewed commit: `git -C <repo> archive <sha> | tar -x -C <scratch folder>`, then `npm ci --ignore-scripts --no-audit --no-fund` there (never without `--ignore-scripts`: the reviewed code's install scripts must not run on this machine), and copy this checkout's `.claude/skills/prove-finding/` into it. Then let the verifier decide, run from this repository's root: `npm run proof:verify -- --commit <sha> --file <path> --lines <start>-<end> --bundle <bundle> --out <evidence>/proofs/<key>-pr<pr>-<n>`, adding `--repo ../faultforge-target` for a target PR. Exit 0 (certificate): fix it, keep the proof test next to the code, and link the certificate in the PR description. Otherwise (`disproven`, `inconclusive`, or no certificate): say so in the PR description with the bundle; the finding stays open and the owner decides. Never click Dismiss and never reply to Qodo.
- Leave a finding the gate only flags unchanged, and list it in the PR description under "Flagged for the owner".
- Push, save the new review (step 4), and repeat the checks the fix touches.
- Note anything the review missed or raised that didn't matter.

Then decide, with the owner, whether the evidence calls for:

- a rule to add or clarify (`AGENTS.md` / `CLAUDE.md`), with its own ticket
- a repeatable task worth a skill
- context the reviewer was missing

## When the guard hook blocks a command

Nothing in that command ran, including the parts before the blocked write. Check what was actually posted or written before reporting it as done. If the block was right, reword. If it was a false positive, write a test for it and fix the hook in its own ticket; don't work around it.

## 7. Finish

- Tick only the ticket criteria you verified.
- Commit the saved evidence to `private/`.
- The owner merges. After the merge, update `main` locally and delete the branch.
- Record what happened for the day's decision-log entry: what was delivered, what Qodo found, what was confirmed, what changed.
