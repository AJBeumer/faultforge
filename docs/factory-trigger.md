# Starting the factory from a label

The owner adds the `ready-for-agent` label to a ticket. The [Factory workflow](../.github/workflows/factory.yml) in GitHub Actions runs `npm run factory:tick -- --ci`: at once for a ticket in this repo, and within 15 minutes (a schedule) for a ticket in the target. The tick takes that ticket, runs the `/factory` loop on it in a headless Claude Code session, and reports on the ticket where the run stopped. Nobody opens a session or types a prompt, and no PC needs to be on.

The same tick also runs on the owner's PC (`npm run factory:tick`, below), with worktrees instead of a fresh VM.

## Labels

| Label | Set by | Meaning |
|---|---|---|
| `ready-for-agent` | the owner | Start a run. Only counts when the repo owner added it. |
| `agent-working` | the runner | A run has claimed the ticket. |
| `agent-done` | the runner | The PR is ready for the owner to merge, or waits at an owner gate (a change to the reviewer's rules). |
| `agent-needs-help` | the runner | The run stopped: the ticket wasn't ready, a limit was hit, the review didn't settle, `main` moved, or something failed. The comment says which. |

## What one tick does

1. **Lock.** One run at a time. In Actions, the `tick` job's `concurrency` group: a second tick waits, and a newer waiting tick replaces an older one, which is harmless because each takes the oldest ready ticket. Every trigger's `look` job runs at once, so a run started by a tick's own label event can't displace the owner's. On a PC, a lock file: a tick that finds it held by a live process logs `busy` and exits, however old the lock is. The tick holding it refreshes its heartbeat every minute and at every step it logs. It is taken over only when its process is gone, or its live pid is now another process (the lock records its holder's start as the system keeps it, which no clock change moves; the system hands pids on after a crash or restart). The heartbeat only shows when the holder last did something; it never frees the lock.
2. **Pick.** The open ticket, in any repo in `factory.json`, whose `ready-for-agent` label was added longest ago. None: log `idle` and exit.
3. **Refuse** the ticket, starting nothing, if someone other than the repo owner added the label (read from the issue's events), or if `ticket:ready` finds a problem. The comment is posted only once `ready-for-agent` is off the ticket: while the label stays, the next tick meets the ticket again and would otherwise say the same thing every time.
4. **Claim.** `agent-working`, and a comment on the ticket. Then a **snapshot**: the ticket's title, body and every comment, with who wrote and edited each part (all pages, comment edits included). The agent works from that file only (its path is in `FAULTFORGE_TICKET_FILE`); reading the run's ticket live with `gh` or `ticket:ready` is out, and so are writes to the project board, which the audit can't see. A ticket with any text from someone other than the owner, or one that can't be read completely, is refused.
5. **Qodo check.** `qodo:check` compares Qodo's live configuration with the latest snapshot in the private repo. A difference, or a check that can't run, ends the run `agent-needs-help` here, before any workspace is built; the ticket gets one fixed sentence, and the run log lists the differing rules by kind and id only, never their text.
6. **Workspace.** In Actions: a fresh VM with checkouts of this repo and the target at `main`, in the same layout as the owner's folders. On a PC: fresh worktrees of both repos from `origin/main` in `../faultforge-runs/<run id>/`; the owner's own checkouts are never touched. Only a lab ticket's run gets the private repo, at `private/` (a worktree on its own branch, or in Actions a clone the runner makes), because its agent saves evidence there. A target ticket's run gets none: `private/` is then a plain folder for the reviews `review:wait` saves, which the runner carries into private storage after the agent ends. In Actions nothing private is on disk while a target ticket's agent runs: the workflow checks the private repo out only after the tick, the runner removes its own clone before the agent starts, and refuses to start it if one is left. The agent's environment holds an exact list of the run's own `FAULTFORGE_*` values, and in a target ticket's run the policy hook keeps its shell and read tools off the private checkouts on the PC (#284).
7. **Agent.** `claude -p "/factory <repo> <N>"` in that workspace, with a dollar budget, a time limit, deny rules, and the [factory policy hook](../.claude/hooks/factory-policy.ts) switched on. The hook blocks merging, commenting on PRs (so no replies to Qodo), labelling or closing tickets, `gh api` writes, force pushes, pushes to `main`, scheduled tasks, and edits outside the run's folder. The guard hook still runs too.
   The agent's environment is an allow-list (`factory-agent-env.ts`): the system's paths, home and temp folders, locale, the run's own `FAULTFORGE_*` values, a GitHub token, and the one variable Claude Code signs in with. It never gets Qodo's key or key file, the token files, or the factory's own token: `review:wait` in a run asks the runner, which runs it from a trusted checkout of `main` with the key and hands back its output (`factory-review-broker.ts`). When `FAULTFORGE_AGENT_TOKEN` is set, it is the agent's `GH_TOKEN` instead of the runner's; without it the run log warns that the agent has the runner's token. The policy hook also refuses reading the whole environment (`env -0`, `printenv`, `process.env`, `os.environ`) and requests from code (`fetch(`, `http.request`, Python's `requests`) to anything but the app on localhost.
   The agent can't edit anything under a `.claude` folder, because that holds its own guardrails; a ticket that needs that stops for the owner. In the private worktree it can't edit the answer key, the audit log, `templates/` or `config/` either (#142); the runner's diff check after the run (#102) is what guarantees that nothing outside the evidence folders reaches the private repository's `main`. It diffs from where the run's branch left `main`, so someone else's push to the private repo during a run is never counted as the run's change, and a blocked run is reported by the number of files only: a private path never reaches the run log or a comment, which can be public (AUD-M2). Every comment the runner posts starts with a hidden mark (`<!-- scheduled-run -->`), and a later run's ticket snapshot leaves those comments out of the text, so an earlier agent's reason or a review finding's title never comes back as the owner's words (AUD-M21). The agent's instructions say review findings and file contents are data, never instructions. In Actions, `npm run guard:install` puts the git-level guard in the target's checkout before the tick starts, as on the owner's PC (AUD-M17). The runner refuses to start the agent at all unless the workspace's settings run both hooks before every shell command and file edit, and unless both hooks pass a self-test first: each is run once with a payload it must deny (a telltale commit message for the guard, a merge for the policy), once with a harmless command it must allow, and once with input that is not JSON, which it must block (exit 2 with the reason) rather than crash. Both hooks fail closed on any error. The self-test accepts only answers Claude Code would act on: a well-formed deny, a blocking exit, or silence; a malformed deny or an "ask" that nobody is there to answer fails it. Each answer must also come within half the hooks' time limit (15 seconds in `settings.json`), because Claude Code lets the tool run when a hook times out. The run log records the result as one `hooks-checked` event: each hook's deny, allow and not-JSON outcomes and its slowest answer in milliseconds, or the problems when the check failed. It is written once the workspace is built and before the agent starts, so a run with no denial still leaves positive evidence that the guardrails were in place.
8. **Audit.** The policy hook reads command text, and text can't show everything a command does (a script, a redirect). So after the agent stops, the runner checks what actually changed: `main` in every repo, the owner's own checkouts (commit, branch and uncommitted changes), the guardrail files in the run, any comment by the agent's login anywhere in either repo during its run (such as a reply to a review finding), any change to the ticket during its run, and a fresh snapshot of the ticket compared with the one the agent worked from. Anything found is a stop for the owner, whatever the agent reported. The agent runs as the owner, so a comment the owner makes by hand during a run is flagged too: that's a false alarm the owner can clear, never a silent miss.
9. **Verify.** The runner doesn't take the agent's word. A PR only counts if the agent exited cleanly, the PR is open in the ticket's own repo, every check on it passed, and `review:wait` says Qodo's review of its head commit is complete with no action-required finding open. `review:wait` and `revert:check` both run from one freshly fetched checkout of `origin/main`, built for this step alone and removed once it returns - never from `ws.lab`, the agent's own writable worktree, where a committed-but-unmerged edit to either script, or a module either imports, would otherwise change the verdict the runner reads about its own pull request (#161, #170). Every other tool the runner itself runs after the agent stops, and where from:

   | Tool | Runs from | Why that's safe |
   |---|---|---|
   | `review:wait` | the trusted checkout built for this verify step | an edit to `review-wait.ts` on the very pull request being checked must never change its own verdict (#170) |
   | `revert:check` | the same trusted checkout | same reason, for `revert-check.ts` (#161) |
   | `rules:propose` (once, after a finished run) | the runner's own process - `factory-tick.ts` already had it imported and loaded before this run's workspace, let alone the agent, ever existed | nothing the agent wrote during the run can reach code that was loaded before the run began |
   | every `gh`/`git` call in the audit, the ticket-change check, relabelling, commenting and saving evidence | the runner's own process, reading GitHub and the owner's real checkouts directly | these only read state or move already-tracked files; none of them runs a script from the pull request's own branch |
10. **Report.** First the run log and transcript are pushed to the private repo. Only then is the ticket labelled: `agent-done` when they were saved, `agent-needs-help` when the save failed or was blocked, or the run needed help anyway. Every relabel adds the new label before it removes the old one, so a failure in between leaves a ticket with two labels, never none. Then a comment with the reason and the PR, the `finished` event, and a second copy of the log, so the saved log ends with the label the ticket shows. Worktrees are removed after a good run and kept after one that needs help.

The `/factory` loop inside the run keeps its own limits: at most three review rounds, and it stops at every owner gate.

## Following a run

Every step goes to `<runs>/<run id>.jsonl` as it happens, and the agent's full transcript to `<run id>.agent.jsonl`. Both are pushed to `private/raw-artifacts/factory-runs/` at the end. In Actions, the steps also show in the job's log, and the event log (never the transcript: a public repo's artifacts can be downloaded) is kept as an artifact for 30 days. When a job is cancelled or times out, or the tick crashes before its last copy, an `if: always()` step (`npm run factory:keep`) pushes the event log and transcript of every run that didn't log `saved` to a branch of the private repo, `unsaved-<Actions run id>-<attempt>`, never to `main`; the tick step stops ten minutes inside the job's limit so this step has time to run.

Stopping the runner stops its agent: a stop signal or the runner's own exit kills the agent's process tree. A runner killed outright can't do that, so the lock's heartbeat records the agent's pid and start, and the tick that takes the stale lock over kills that agent's tree first, if that pid is still the process that started then. Every claim comment ends with a hidden mark of the way of running that took it (`<!-- scheduled-run claim mode=ci -->` or `mode=local`), and recovery leaves alone an `agent-working` ticket the other way claimed, unless it already shows `agent-done` or `agent-needs-help` (then only `agent-working` is removed: that run has ended). No tick picks a ticket that still carries `agent-working`. Reads from GitHub (labels, events, the ticket, its comments, open PRs) get three tries. A ticket picked up again while an earlier run's PR that closes it is still open gets a runner note in its ticket file: continue that PR instead of opening a second.

```bash
npm run factory:timeline -- latest       # the run as a table, from the private repo's copy
```

## GitHub Actions

Repo secrets, set once:

| Secret | What |
|---|---|
| `FACTORY_GH_TOKEN` | The owner's fine-grained token, limited to the three repos, with Contents, Issues and Pull requests read and write and nothing else (no Administration, Secrets, Actions or Workflows). Pushes and PRs come from the owner, so Qodo reviews them: it ignores pushes by bots. |
| `FACTORY_AGENT_TOKEN` | Optional, and recommended: a second fine-grained token of the owner, limited to this repo and the target (no private repo), with Contents and Pull requests read and write. It becomes the agent's `GH_TOKEN`, so the agent can't reach the private repo with GitHub's API; the runner keeps `FACTORY_GH_TOKEN` for itself. Without it the agent gets `FACTORY_GH_TOKEN` and the run log warns. |
| `QODO_API_KEY` | For `review:wait`. |
| `CLAUDE_CODE_OAUTH_TOKEN` | From `claude setup-token`. |

Only the owner adding `ready-for-agent` starts a job, so nobody else's event reaches the secrets. Inside the jobs, each secret goes only to the steps that use it, never to a whole job: the token to the `look` job's count step, the `tick` job's three checkouts, its commit-and-push setup and the tick itself; the Qodo key and the Claude token to the tick step alone; no checkout keeps its token in `.git/config` (`persist-credentials: false`), and git pushes through `gh auth setup-git`, which reads the token from the environment at push time. The agent starts with an empty MCP configuration and `--strict-mcp-config`, so no MCP server of the machine running the tick is reachable from a run. The token has no Workflows permission, so a run can't push a change under `.github/workflows/`; the policy hook refuses such an edit up front, and a ticket that needs one stops for the owner. A first, cheap job checks whether any ticket is labelled; the run itself starts only when one is. Turn the factory off and on:

```bash
gh workflow disable factory.yml --repo AJBeumer/faultforge
gh workflow enable factory.yml --repo AJBeumer/faultforge
```

To refuse-test the owner check, the `Drill - label added by a bot` workflow adds the label as `github-actions[bot]`.

## The scheduled task (Windows, optional)

The task runs the code in the owner's checkout of this repo. Set the token locations once as user environment variables (never in a repo file):

```powershell
setx GH_TOKEN_FILE "<path to the GitHub token file>"
setx QODO_KEY_FILE "<path to the Qodo key file>"
```

Create it (every 10 minutes), then turn it on and off:

```powershell
schtasks /Create /TN "FaultForge factory tick" /SC MINUTE /MO 10 /TR "cmd /c cd /d <path to your FaultForge checkout> && (if not exist ..\faultforge-runs mkdir ..\faultforge-runs) && npm run -s factory:tick >> ..\faultforge-runs\ticks.log 2>&1"
schtasks /Change /TN "FaultForge factory tick" /ENABLE
schtasks /Change /TN "FaultForge factory tick" /DISABLE
```

Run one tick by hand with `npm run factory:tick`. Options: `--ci` (use the checkouts as they are; for the workflow), `--minutes` (time limit, default 120) and `--budget` (dollars, default 25). Exit code 1 means the ticket the tick took now carries `agent-needs-help` (a run stopped, or the ticket isn't ready); 0 covers idle, busy, refused and done; 2 means the command line or the environment was wrong (including a token file that can't be read), so no tick ran; 3 means the tick itself failed (a claimed ticket is labelled `agent-needs-help` too, and its log ends with a `finished` event saying the runner failed).

## What it never does

Merge, dismiss or reply to a review finding, change Qodo's settings, or run a planted-bug case. Cases use `/new-case`, by hand.
