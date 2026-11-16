# shared

What every other area needs, in one place each.

- `paths.ts`: the repo root, private storage, the evidence folders. `factory-config.ts`: reads `factory.json`.
- `templates.ts`: where templates live and what each must declare.
- `neutral.ts`: the giveaway word list. The hooks read it too, through their bridge, so the guard holds it.
- `github.ts`: the one `gh` wrapper, with its time limit and retries. `git-stream.ts`: git output line by line.
- `jsonl.ts`: JSON Lines. `provenance.ts`: the tool name and hashes on every record.
- `cli-entry.ts`: runs a command's body so any error ends as its documented exit code.
- `error-text.ts`, `drive-spelling.ts`, `run-outcome.ts`: small helpers several areas share.

Entry points: none; `npm run` starts nothing here.

Uses: no other area.
