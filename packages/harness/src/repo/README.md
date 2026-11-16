# repo

Checks on the repository as a whole, and the test launcher.

- `vitest-run.ts`: starts Vitest for `npm test` and `npm run test:integration`.
- `sources.ts`: the harness's own source files, for the tests that read them as text.
- The tests here check rules no single module owns: module size, exit codes, the layout and area order
  (`layout.test.ts`), shared helpers, gh calls, the README, the workflows and public text.

Entry points: `npm test` and `npm run test:integration` (`vitest-run.ts`).

Uses: no other area.
