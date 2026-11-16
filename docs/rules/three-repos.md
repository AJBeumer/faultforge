# Three repositories

Part of the [rules for coding agents](../../CLAUDE.md). Each rule is one short bullet there; this page has the detail.

| Repo | Visibility | Holds | Never holds |
|---|---|---|---|
| `faultforge` (this one) | public | harness, adjudicated templates, docs and charter, work tickets (Issues), sanitized results | answer key, raw evidence, unreleased templates |
| `faultforge-target` (`../faultforge-target`) | public, reviewed by Qodo | the booking API and its ordinary tests | any mention of FaultForge, planted bugs, cases, proof tests or the answer key |
| `faultforge-private` (`./private`, git-ignored here) | private | answer key, audit events, case records, raw evidence, unreleased templates, `BACKLOG.md` for anything that would reveal them | — |

- `private/` is its own git repository. Commit and push it after every case. It must never be added to this repo.
- **Links go one way.** This repo's issues, PRs and commit messages may name target work as plain text ("target 3"), never as a link (`faultforge-target#3` or an issue/PR URL). GitHub would show "mentioned in faultforge#N" on the target's timeline, where Qodo reads it. Files such as the decision log may link to the target, because files don't create those events. The guard hook enforces this.
- `private/` is a separate repository inside this folder, and the shell's working directory can carry over between commands. Always use `git -C <path>` for git commands, so a commit can't land in the wrong repository.
