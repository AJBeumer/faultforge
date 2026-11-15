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

During a factory run the agent may use only `push`, `pr-create` and `pr-edit` (#347). The factory policy hook refuses every other kind, so commenting on a PR, closing one and writing issues stay with the owner and the runner. The list lives in one place, `AGENT_DOOR_KINDS` in `.claude/hooks/factory-policy-door.ts`, which the policy and the agent's prompt both read. Outside a run the owner's door commands are unaffected.

The module has one kind the command doesn't take: `label`, which only the runner uses, so a run's agent can't move a ticket's labels itself. It adds labels in one edit, then removes each other one. A label name is checked like any text, and must also be one plain line of at most 50 characters with no comma (gh would split it into two labels). A label post can't add and remove the same label.

## What the guard does

The Claude Code guard (`.claude/hooks/guard-target.ts`) lets a command that is exactly `npm run target:post -- …` through without reading it: one line, plain arguments, from the lab's root, with `package.json` running `node packages/harness/src/target-post-cli.ts` for it and no `pre` or `post` script, and no `.npmrc` setting that changes how scripts run. The door's files, and everything they import, are among the guard's own files (`guard-self.ts`), which a session can't change in the checkout the guard runs from. It refuses every other write aimed at a reviewed repo without reading what it would say: `gh issue` and `gh pr` writes, any `gh` call that isn't a known read, `gh api` with a method or a field, `curl`, `wget` or `Invoke-WebRequest` with a body, MCP tools that aren't reads, and `git push` from or to the checkout. A write whose destination it can't read (a shell variable, a script) is refused too. Reads (`gh pr view`, `gh api` GETs, `git fetch`, `git log`) and commits in the checkout work as usual.

The target's own git hooks (`pre-commit`, `commit-msg`, `pre-push`, installed by `npm run guard:install`) stay as a second layer: they run on the door's push too.
