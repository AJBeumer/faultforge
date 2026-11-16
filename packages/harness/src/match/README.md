# match

The fixed match rule: a finding is a catch only if it names the injected file, overlaps the injected lines,
and describes the right kind of problem.

- `match-rule.ts`: the rule as code. Never loosened or tightened after seeing results.
- `match.ts`: applies it to a saved review for one case.

Entry points: `npm run match` (`cli/match-cli.ts` loads `match.ts`).

Uses: `shared`.
