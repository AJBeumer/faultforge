# Integration tests

Tests that need more than the code under test: a checkout of the target, a network, a real process, or more
than a few seconds. They run with `npm run test:integration`, not with `npm test` or `npm run check`, so the
fast checks stay fast. Unit tests stay next to the code they test, as `<name>.test.ts` under `src/`.

Tests that need the target expect a checkout of `faultforge-target` next to this repository. Those that need
the private evidence expect `private/`. Each skips itself when what it needs is missing. CI runs them on Linux
and Windows, with the target checked out next to this repository (the `integration` job in
`.github/workflows/check.yml`). That job isn't one of the checks `main` requires.

The layout rules are in `CLAUDE.md`, under "Code layout".
