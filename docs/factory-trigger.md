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

1. **Lock.** One run at a time. In Actions, the workflow's `concurrency` group: a second trigger waits. On a PC, a lock file: a tick that finds it held by a live process logs `busy` and exits.
2. **Pick.** The open ticket, in any repo in `factory.json`, whose `ready-for-agent` label was added longest ago. None: log `idle` and exit.
3. **Refuse** the ticket, starting nothing, if someone other than the repo owner added the label (read from the issue's events), or if `ticket:ready` finds a problem.
4. **Claim.** `agent-working`, and a comment on the ticket. Then a **snapshot**: the ticket's title, body and every comment, with who wrote and edited each part (all pages, comment edits included). The agent works from that file only; reading the run's ticket live with `gh` is blocked. A ticket with any text from someone other than the owner, or one that can't be read completely, is refused.
5. **Workspace.** In Actions: a fresh VM with checkouts of this repo, the target and the private repo at `main`, in the same layout as the owner's folders. On a PC: fresh worktrees of both repos from `origin/main`, and of the private repo on its own branch, in `../faultforge-runs/<run id>/`; the owner's own checkouts are never touched.
6. **Agent.** `claude -p "/factory <repo> <N>"` in that workspace, with a dollar budget, a time limit, deny rules, and the [factory policy hook](../.claude/hooks/factory-policy.ts) switched on. The hook blocks merging, commenting on PRs (so no replies to Qodo), labelling or closing tickets, `gh api` writes, force pushes, pushes to `main`, scheduled tasks, and edits outside the run's folder. The guard hook still runs too.
   The agent can't edit anything under a `.claude` folder, because that holds its own guardrails; a ticket that needs that stops for the owner. The runner refuses to start the agent at all unless the workspace's settings run both hooks before every shell command and file edit.
7. **Audit.** The policy hook reads command text, and text can't show everything a command does (a script, a redirect). So after the agent stops, the runner checks what actually changed: `main` in every repo, the owner's own checkouts (commit, branch and uncommitted changes), the guardrail files in the run, any comment by the agent's login anywhere in either repo during its run (such as a reply to a review finding), any change to the ticket during its run, and a fresh snapshot of the ticket compared with the one the agent worked from. Anything found is a stop for the owner, whatever the agent reported. The agent runs as the owner, so a comment the owner makes by hand during a run is flagged too: that's a false alarm the owner can clear, never a silent miss.
8. **Verify.** The runner doesn't take the agent's word. A PR only counts if the agent exited cleanly, the PR is open in the ticket's own repo, every check on it passed, and `review:wait` says Qodo's review of its head commit is complete with no action-required finding open.
9. **Report.** `agent-done` or `agent-needs-help`, a comment with the reason and the PR, and the run log pushed to the private repo. Worktrees are removed after a good run and kept after one that needs help.

The `/factory` loop inside the run keeps its own limits: at most three review rounds, and it stops at every owner gate.

## Following a run

Every step goes to `<runs>/<run id>.jsonl` as it happens, and the agent's full transcript to `<run id>.agent.jsonl`. Both are pushed to `private/raw-artifacts/factory-runs/` at the end. In Actions, the steps also show in the job's log, and the event log (never the transcript: a public repo's artifacts can be downloaded) is kept as an artifact for 30 days.

```bash
npm run factory:timeline -- latest       # the run as a table, from the private repo's copy
```

## GitHub Actions

Repo secrets, set once:

| Secret | What |
|---|---|
| `FACTORY_GH_TOKEN` | The owner's fine-grained token, with access to all three repos. Pushes and PRs come from the owner, so Qodo reviews them: it ignores pushes by bots. |
| `QODO_API_KEY` | For `review:wait`. |
| `CLAUDE_CODE_OAUTH_TOKEN` | From `claude setup-token`. |

Only the owner adding `ready-for-agent` starts a job, so nobody else's event reaches the secrets. A first, cheap job checks whether any ticket is labelled; the run itself starts only when one is. Turn the factory off and on:

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
schtasks /Create /TN "FaultForge factory tick" /SC MINUTE /MO 10 /TR "cmd /c cd /d D:\Projects\FaultForge && npm run -s factory:tick >> ..\faultforge-runs\ticks.log 2>&1"
schtasks /Change /TN "FaultForge factory tick" /ENABLE
schtasks /Change /TN "FaultForge factory tick" /DISABLE
```

Run one tick by hand with `npm run factory:tick`. Options: `--ci` (use the checkouts as they are; for the workflow), `--minutes` (time limit, default 120) and `--budget` (dollars, default 25). Exit code 1 means the run needs help; 0 covers idle, busy, refused and done.

## What it never does

Merge, dismiss or reply to a review finding, change Qodo's settings, or run a planted-bug case. Cases use `/new-case`, by hand.
