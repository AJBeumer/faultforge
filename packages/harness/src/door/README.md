# door

The one way to write to a reviewed repository: `npm run target:post -- <kind> ...` checks the exact
text it sends, and the guard lets nothing else write there.

- `target-post.ts`: the kinds, the checks on the text, and the send. `target-post-push.ts`: a push.
- `target-post-run.ts`: during a factory run, the kinds the agent may use.
- `target-post-cli.ts`: the entry, run with plain `node`.

These files are among the guard's own files (`.claude/hooks/self/own-files.ts`): a session can't change them in
the checkout the guard runs from. They import only each other, `shared/neutral.ts`, and two hook modules.

Entry points: `npm run target:post` (`target-post-cli.ts`).

Uses: `shared`.
