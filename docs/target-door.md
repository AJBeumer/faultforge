# One door to the reviewed repository

Every write to the reviewed repository (`faultforge-target`, any repo marked `"guard": "reviewed"` in `factory.json`) goes through one command:

```bash
npm run target:post -- <kind> [options]
```

| Kind | Options | What it sends |
|---|---|---|
| `issue-create` | `--title-file <f> --body-file <f>` | a new issue |
| `issue-edit` | `--number <n>`, `--title-file` and/or `--body-file` | a changed issue |
| `issue-comment` | `--number <n> --body-file <f>` | a comment on an issue |
| `pr-create` | `--head <branch> [--base main] --title-file <f> --body-file <f>` | a new PR |
| `pr-edit` | `--number <n>`, `--title-file` and/or `--body-file` | a changed PR |
| `pr-comment` | `--number <n> --body-file <f>` | a comment on a PR |
| `pr-close` | `--number <n> --body-file <f>` | closes the PR with that comment |
| `push` | `--branch <name> [--checkout <path>]` | the branch's commit, never forced |
`--repo owner/name` picks a reviewed repo when there is more than one. Run it on its own, from the lab's root.

## What it checks

It reads its text only from files, and checks the exact text it sends, each piece on its own: the giveaway words (`neutral.ts`), the id of a template still in private storage, and words addressed to Qodo. A head or base branch must be a plain branch of the reviewed repo. A push checks the branch name and, for every commit the remote doesn't have yet (asked of the remote itself), its author, committer and message, and the path and content of every file it touches. It pushes only to a github.com URL of the reviewed repo, and refuses when git's config rewrites remote URLs.

Exit codes: 0 sent; 1 usage; 2 refused, nothing sent; 3 `gh` or `git` failed after the checks (check GitHub before retrying).

`case:ticket` and `case:pr` send through the same module (`packages/harness/src/target-post.ts`), and so does the factory's runner for its comments and label moves on a reviewed repo's ticket (`ticket-write.ts`, #345). Its agent pushes and opens its PR with `npm run target:post`, like anyone else.

### During a factory run

While a factory run is active, the door sends only `push`, `pr-create` and `pr-edit` (#347). Every other kind (commenting on a PR, closing one, writing an issue, moving a label) is refused with exit 2, whoever calls the door and however: `npm run target:post`, `node` on the door's file, or code that imports it and calls `main` or `sendPost`. The check is in `sendPost` itself (`packages/harness/src/target-post-run.ts`), which every send goes through. The list lives in one place, `AGENT_DOOR_KINDS` in that file, which the door, the policy hook and the agent's prompt all read.

A run is active while its marker file exists. The runner writes it just before the agent starts and removes it when the tick ends. Its path is fixed and never comes from the environment: `/tmp/faultforge-factory-run.json` on Linux, `.faultforge-factory-run.json` in the user's profile folder on Windows. It holds the run's id, the runner's pid and the SHA-256 of a random runner key. The key stays in the runner's memory and is never written to a file or given to the agent. The runner's own comments and label moves (`ticket-write.ts`) pass the key, so they still go. A marker the door can't read counts as a run, and the door refuses.

What holds where:

- **In Actions (CI)** the guarantee is the operating system's. The agent runs as its own user, `ffagent`. The marker belongs to the runner's user, with mode 0644, in `/tmp`, whose sticky bit lets only a file's owner remove or rename it. So the agent can't remove, move or edit the marker, and it can't read the runner's memory, where the key is.
- **On the owner's PC (local mode)** there is no sandbox, and the guarantee is weaker. The agent runs as the owner, so it could delete the marker before it calls the door. The door still refuses every call made while the marker is there; the policy hook's first word and the run's audit are what stand guard beyond that.

In both modes the gate covers calls through the door. Code that skips the door and writes with `gh` or `git` directly is the guard's to refuse (below).

The policy hook keeps a short first layer: it refuses `npm run target:post -- <kind>` with a kind other than the three written out, so the agent hears early. It doesn't try to read every spelling; the door does the enforcing.

Outside a run the owner's door commands are unaffected. A local run that was killed outright can leave its marker behind: the door then refuses the owner's comments too, and says where the marker is. Remove it by hand, or the next run replaces it.

The module has one kind the command doesn't take: `label`, which only the runner uses, so a run's agent can't move a ticket's labels itself. It adds labels in one edit, then removes each other one. A label name is checked like any text, and must also be one plain line of at most 50 characters with no comma (gh would split it into two labels). A label post can't add and remove the same label.

## What the guard does

The Claude Code guard (`.claude/hooks/guard-target.ts`) lets a command that is exactly `npm run target:post -- …` through without reading it: one line, plain arguments, from the lab's root, with `package.json` running `node packages/harness/src/target-post-cli.ts` for it and no `pre` or `post` script, and no `.npmrc` setting that changes how scripts run. The door's files, and everything they import, are among the guard's own files (`guard-self.ts`), which a session can't change in the checkout the guard runs from. It refuses every other write aimed at a reviewed repo without reading what it would say: `gh issue` and `gh pr` writes, any `gh` call that isn't a known read, `gh api` with a method or a field, `curl`, `wget` or `Invoke-WebRequest` with a body, MCP tools that aren't reads, and `git push` from or to the checkout. A write whose destination it can't read (a shell variable, a script) is refused too. Reads (`gh pr view`, `gh api` GETs, `git fetch`, `git log`) and commits in the checkout work as usual.

The target's own git hooks (`pre-commit`, `commit-msg`, `pre-push`, installed by `npm run guard:install`) stay as a second layer: they run on the door's push too.
