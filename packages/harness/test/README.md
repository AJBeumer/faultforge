# Integration tests

Tests that need more than the code under test: a checkout of the target, a network, a real process, or more
than a few seconds. They run with `npm run test:integration`, not with `npm test` or `npm run check`, so the
fast checks stay fast. Unit tests stay next to the code they test, as `<name>.test.ts` under `src/`.

The folder is empty until the first such test lands (the end-to-end test for `npm run inject`, #7, is the
first candidate). The layout rules are in `CLAUDE.md`, under "Code layout".
