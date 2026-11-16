# Code layout

Part of the [rules for coding agents](../../CLAUDE.md). Each rule is one short bullet there; this page has the detail.

- A unit test sits next to the code it tests, as `<name>.test.ts` in the same folder (`packages/harness/src/`, `.claude/hooks/`). It runs with `npm test` and in `npm run check`.
- Tests must pass on Linux (CI) and Windows (the owner's machine). Build expected paths with `resolve()` or `join()`, never compare against a bare POSIX literal such as `"/repo/x"`, and don't assume `/` separators, drive letters or hard links across drives. CI is the authority: Check runs on both, and the `protect-main` ruleset requires both jobs, so a red Windows job is a real portability bug to fix in the test or the code, never waved through because Linux is green. When only a local run disagrees with a green CI, trust CI and look for something specific to your machine.
- A slow or end-to-end test, one that needs a checkout of the target, a network, a real process or more than a few seconds, lives under `packages/<package>/test/`. It runs with `npm run test:integration`, never in `check`. Template proof tests are neither: they run only through `npm run inject`.
- A helper two scripts need lives in a named module (`neutral.ts`, `factory-config.ts`), never as a copy in each script.
- A module over 400 lines is split along its seams. No module may pass 400 lines; `module-size.test.ts` checks it.
- Every script documents its exit codes in its header comment, and each code means one thing.
- Why colocated and not a mirrored `tests/` tree: in TypeScript with Vitest the test moves with its file, imports stay short, and a missing test is visible in the folder listing. A mirrored tree is a Java and Python convention that duplicates every path and breaks on every move. `factory.json`'s `tests` pattern names both places, so `revert:check` recognises them.
