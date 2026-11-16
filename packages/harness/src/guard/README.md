# guard

Installs the git-level guard: the pre-commit, commit-msg and pre-push hooks that run
`.claude/hooks/git-guard.ts` in the lab, the private checkout and each reviewed checkout.

- `guard-install.ts`: writes the hooks and the setting that names the guard.

Entry points: `npm run guard:install` (`cli/guard-install-cli.ts`).

Uses: `shared`.
