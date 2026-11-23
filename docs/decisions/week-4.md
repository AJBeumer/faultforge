# Decision log, week 4 (23 to 29 November)

Part of the [decision log](../decision-log.md). Entries are copied verbatim, in order.

## 23 November: Ponytail in interactive sessions only

The owner asked to include Ponytail (github.com/DietrichGebert/ponytail, MIT), a Claude Code plugin that adds "write the least code that fully works" rules to every prompt and every subagent, plus review and audit skills.

- **Where it runs.** Interactive Claude Code sessions in this repository, from 23 November. It is installed at local scope (the git-ignored `.claude/settings.local.json`), version 5.3.3, commit `ebd8654`. The agent read its hooks at that commit before the install: they send nothing over the network unless a webhook is set (none is), write their own state files on the owner's machine, and run `git ls-files`.
- **Where it does not run.** The factory is unchanged. Its workspaces live outside this repository, and the user settings it reads do not enable the plugin. The target repository never gets it, because its rules in the target would change what Qodo reads during a review.
- **Where it may run later, measured first.** Ticket #431 builds the same tickets with and without Ponytail in the factory, pre-registered. Ticket #432 scores Ponytail's review skill as a second reviewer on reviewer test v1's held-out answer key. Neither changes the factory or the gate before its result says keep.
- **Comparability.** Work built in sessions from today onward was written with Ponytail loaded. No case result depends on that: Qodo's configuration and the target are unchanged. Where Ponytail's rules and this repository's house rules disagree, `CLAUDE.md` and `AGENTS.md` win.
