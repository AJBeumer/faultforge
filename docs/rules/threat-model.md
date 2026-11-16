# What the guard protects against

Part of the [rules for coding agents](../../CLAUDE.md). This page says what the guard is for, what it isn't
for, where it is known to fall short, and what backs it up.

## What it is for

A result only counts if Qodo, the reviewer, never gets a hint about a planted bug. The danger we design for
is an accident: an AI agent doing normal work puts a hint where Qodo reads it. That means the target's
branch names, commit messages and files, its pull requests and their comments, its tickets, and links from
this repository that show up on the target's timeline.

The guard ([`guard-target.ts`](../../.claude/hooks/guard-target.ts)) is a Claude Code hook. It reads every
command and file edit an agent makes, before it runs. It lets one command write to the target, the door
(`npm run target:post`), and refuses every other write it sees aimed there. It also refuses many commands
whose destination it can't read. [The door and the guard](guard.md) has the detail.

## What it isn't for

It isn't a defence against a deliberate attacker with a shell on the owner's machine. Someone who sets out
to get past it can: edit their own settings, use another clone, or spell a command so no reader can follow
it. FaultForge is a hackathon entry with one person working on it, and that person runs every case.

The guard reads command text. It can't know what a script will do once it runs. That is why the layers
below exist.

## Known gaps

These are the classes of bypass the latest independent re-grade found. Each needs a spelling or a step
that normal work doesn't produce. That is why each is accepted rather than closed.

| Gap | What gets past | Why it is accepted |
|---|---|---|
| Shell expansions | A repo name built with an expansion the guard doesn't evaluate, such as `${IFS}`. | Normal work names a repo plainly. |
| Percent-encoded URLs | A target URL with escaped letters, such as `%2D` for `-`. | Same: no tool writes a URL that way unasked. |
| Arithmetic repo ids | A numeric repository id worked out at run time, such as `$((…))`. | Same. |
| Home config files | A write to `~/.bashrc` or `~/.claude/settings.json` that changes what later commands do, or turns hooks off. | It changes the owner's own machine, outside every repository. In a factory run the policy hook refuses edits outside the run's folder. |
| gh extensions | `gh <extension>` runs code the guard can't read. | An extension has to be installed first, on purpose. |
| `NODE_OPTIONS` on the door | Code loaded into the door's own Node process through `NODE_OPTIONS` already set in the environment. | It has to be set up on purpose. A factory run's agent starts with an allow-listed environment that doesn't hold it. |
| Plain-English hints | A hint that uses no giveaway word. The word list checks words, not meaning. | No word list can read meaning. Case text comes from templates written to describe the change only, and the owner reads every case PR. |
| A push from another clone | The target's git hooks live in this checkout's `.git` folder. A push from another clone of the target doesn't run them. | Normal work uses this checkout and the door. |

## The layers behind it

No layer is complete on its own. Each one catches some of what the others miss.

1. **The door** ([`target-door.md`](../target-door.md)). `npm run target:post` checks the exact text it
   sends: giveaway words, private template ids and words addressed to Qodo. For a push it checks the branch
   name and every new commit's author, message, file paths and content.
2. **The target's git hooks** (`pre-commit`, `commit-msg`, `pre-push`, installed by `npm run guard:install`).
   They run the same content checks inside git for commits and pushes made in this checkout of the target,
   whatever started them: an agent, a script or the door. A push from another clone skips them.
3. **The factory sandbox and run policy** ([`factory-trigger.md`](../factory-trigger.md)). In GitHub Actions
   the agent runs as its own user, with network access only to an allow-list of hosts. In every factory
   run, the policy hook limits what the agent may do, and the runner audits what changed after it stops.
4. **`npm run qodo:check`.** It compares Qodo's rules, review skills and the target's relationships with a
   recorded snapshot in private storage. `case:pr` runs it before every case PR, and every factory tick runs
   it before the agent starts. A difference stops the case or the run.
5. **The owner.** The owner reads every case PR, confirms every verdict, and closes the PR without merging.
6. **A check of the target itself.** An integration test in CI
   ([`neutral-target.integration.test.ts`](../../packages/harness/test/neutral-target.integration.test.ts))
   reads every tracked file, commit message and branch name in the target for giveaway words. It finds a
   leak after the fact, not before.
