# The hooks

Two Claude Code hooks and one git hook keep hints away from the reviewer. They run before every tool call and
every commit and push, so they fail closed: a hook that can't check refuses.

## Entry points (top level)

| File | Who runs it | What it does |
|---|---|---|
| `fail-closed.ts` | Claude Code, for each hook in `.claude/settings.json` | Runs the hook named after it and passes on only a clean answer. |
| `guard-target.ts` | Claude Code, every session | The guard: no hint reaches a reviewed repo, writes to one go through the door. |
| `factory-policy.ts` | Claude Code, inside a factory run only | What an unattended run may not do. |
| `git-guard.ts` | git, as installed by `npm run guard:install` | The same content checks at commit and push, whoever starts them. |
| `fixtures.ts` | tests | Temp repos, a config pointing at them, and the hooks asked in-process. |

`.claude/settings.json` and the installed git hooks name these files, so they stay where they are. Each entry
point reads the payload, asks the folders below, and answers with one decision.

## Folders

| Folder | What it guards or provides | Add a rule here when it is about |
|---|---|---|
| `shared/` | Hook I/O (`hook-io.ts`), the reviewed repos and how a command or path reaches one (`repos.ts`), and the bridge into the harness (`harness-bridge.ts`). | Which repo a command means; a new harness import (bridge only). |
| `shell/` | Reading a command as the shell would: quotes and heredocs (`scan.ts`), steps and words (`words.ts`), other spellings (`decode.ts`), wildcards (`glob.ts`), paths (`paths.ts`), posted text (`posted.ts`), and code no rule can read (`exec.ts`, `interp.ts`). | A spelling the hooks don't read yet. |
| `target/` | The reviewed repository: the door (`door.ts`), where a command reaches (`reach.ts`, `expand.ts`), what it would post (`posted-files.ts`), pending content read from git (`content.ts`, `pending.ts`), history and whole repos (`history.ts`), case refs (`cases.ts`), file edits, MCP tools and links (`tools.ts`). | What may reach a reviewed repo. |
| `answer-key/` | Private data: private template ids in any post (`private-ids.ts`, `posts.ts`), gists and release assets (`assets.ts`), copies of the answer key, audit log or templates (`copies.ts`). | Something private that must stay private. |
| `factory/` | Run policy: commands (`commands.ts`), files and scripts (`paths.ts`), the private checkouts (`private-checkouts.ts`), the home folder (`home.ts`), the check script (`check-script.ts`), door kinds (`door-kinds.ts`). | What an unattended run may not do. |
| `self/` | Guarding the guard: its own files (`own-files.ts`, `own-files-git.ts`) and git's guard hooks (`git-hooks.ts`). | A way to switch a guard off. |

A rule goes in the module that owns its subject, with its test next to it as `<name>.test.ts`, in a `describe`
named for the behaviour. A new subject gets a new module in the folder above. No module passes 400 lines.

## Which way the imports run

- Entry points import the folders; no folder imports an entry point.
- `shared/` and `shell/` are the base: they import only each other. `factory/` imports only the base.
- `target/`, `answer-key/` and `self/` import the base, and each other where one rule needs another's facts (a
  commit check reads the private ids, a check on the guard's own files reads where git commands run).
- No hook module imports `packages/harness` except `shared/harness-bridge.ts`, which lists each file it uses and
  why. Those files are also the guard's own files and are fingerprinted before a factory run.
- The harness's code imports only `shared/repos.ts` (the reviewed repos) and `answer-key/private-ids.ts` (the
  private template ids its door checks).

`layout.test.ts` checks these directions, the folder map above, the test file names, and the line budget.

## Line budget

The hooks' code (tests and `fixtures.ts` left out) may not grow past `LINE_BUDGET` in `layout.test.ts`. Raising
it is a reviewed change: say in the PR why the code can't be made smaller instead.
