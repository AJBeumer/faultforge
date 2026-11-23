# proof

Findings that carry their own proof: a test and a fix confined to the cited lines, re-run by a verifier that
never trusts the agent's verdict. The skill that writes a proof is `.claude/skills/prove-finding/`.

- `proof-patch.ts`: whether a fix stays inside the cited lines; builds and applies it strictly.
- `proof-verify.ts`: the certificate decision from the runs' facts (pure).
- `proof-run.ts`: exports a commit, runs the test before and after the fix (`npm run proof:verify`).
- `skill-exam.ts`: reads a session's transcript and scores matched pairs (pure).
- `skill-exam-run.ts`: runs the skill blind in fresh sessions on a key of pairs (`npm run skill:exam`).

Entry points: `npm run proof:verify` and `npm run skill:exam` (in `cli/`).

Uses: `shared`, `case`, `factory`.
