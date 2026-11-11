# Planted premises: does Codebase Wisdom catch a ticket's stale assumption?

Run on 11 November 2026 against `AJBeumer/faultforge` at `d9cbe5f` (the revision Qodo's mirror served, checked with `list-commits` before and by every report). The answer key, the match rule and the method were committed to private storage at 18:29 local time, before any investigator started (private commit `5349a68`); [key.json](key.json) is a copy of that file.

## Why this experiment

Day 6 asks "investigate the ticket's assumptions before the factory builds". Every entrant, including this lab in the morning, did that once, by hand, on one ticket, and reported what they found. FaultForge's method is different: plant a known defect, let the tool look, score against the key. Here the defect is a false premise in a ticket, the kind #4 had (a client script that had been superseded, a snapshot two versions old).

## Design

Four tickets in the project's issue form ([tickets/](tickets/)). Three carry one planted premise each, of a different kind. The fourth is a control with only true premises, to count false alarms. Every ticket also contains true premises, listed in the key.

| id | kind | the false claim in the Notes | the truth at `d9cbe5f` |
|---|---|---|---|
| W-1 | deleted file | "extend the existing `vitest.config.test.ts` at the repository root" | deleted in `1f247d1` on 10 November |
| W-2 | helper moved | "copy the `PRIVATE_DIR` line from `inject.ts`" | `inject.ts` imports `privateDir()` from `templates.ts` since `7cc72cb`, 10 November |
| W-3 | component that never existed | "validated with ajv against `ticket-schema.json`" | no such file; sections are parsed by a regex and listed in `factory.json` |
| W-0 | control | none | all three stated premises are true |

**Investigator.** One fresh Claude Code subagent per ticket, run in parallel, with no access to this session, the key or the local checkout. Each got only the ticket text, the challenge's own prompt and the Qodo CLI read commands, and was limited to `qodo read codebase …` on this repository, at most 25 calls. No local file reads, no git, no `gh`, no other repository. The unit under test is the tool and the agent driving it, as a Qodo review is the model and its pipeline together.

**Match rule** (from the key, fixed before any run): a *catch* states that the planted premise does not hold, names the actual state and cites a path or line from a Qodo read; a *partial* rejects the premise without the right reality or without a citation; a *miss* accepts it or leaves it out; a *false alarm* marks a listed true premise as false.

## Result

| id | verdict | the report's evidence ([reports/](reports/)) | false alarms | calls used |
|---|---|---|---|---|
| W-1 | **catch** | "No such file": `find --glob "**/vitest.config*"` returned one entry; no test loads the config. Found the deleting commit `1f247d1` and its reason through `get-commit`. | 0 | 22 (2 CLI flag errors) |
| W-2 | **catch** | "`inject.ts:68` is `const PRIVATE_DIR = privateDir();`", imported at line 39; `blame` dates it to `7cc72cb`; the quoted expression lives at `templates.ts:16`. | 0 | 23 |
| W-3 | **catch** | "No such file": `find **/ticket*` and `find **/*schema*`; `ticket-ready.ts` imports no ajv; sections come from `factory.json:12-14`. | 0 | 25 (2 CLI flag errors) |
| W-0 | control | all three true premises marked "holds" (one with a correct caveat: the section name "depends on" is hard-coded, not read from `factory.json`). | 0 | 25 (2 CLI flag errors) |

**3 of 3 planted premises caught, 0 partial, 0 misses, 0 false alarms across 4 tickets.**

Every citation that decides a verdict was checked against the local checkout at the same commit: the one `vitest.config*` file, `inject.ts:39,68`, `templates.ts:14-17`, the absence of any `ticket-schema.json`, `factory.json:13-14,30-31`, `ticket-ready.ts:34-37`, and the message of `1f247d1`. All hold.

## Beyond the key

Each report found one real problem that was not planted and that the ticket's author (this session) did not know:

- **W-1:** the ticket's first criterion is worded so that today's config would fail it: the unit project's *include* does match `packages/*/test/`, and only the *exclude* keeps those files out (`vitest.config.ts:30-31`). The report also found that a root-level test file had been tried and reverted before (`1f247d1`), that `tsconfig.json` would not typecheck it, and that a test-only PR makes `revert:check` exit 2.
- **W-2:** three places still build the private path by hand (`factory-tick.ts:1384,1466`, `rules-propose.ts:173`), so "the folder the harness will use" overstates what a script built on `privateDir()` can promise.
- **W-3:** the form's `required: true` is enforced only in the web form; `gh issue create` bypasses it, so the readiness check is the real gate.
- **W-0:** the ticket's own proposed rule ("first line only") would not have fixed the case it was written for, because #4's note was on the same line as "None.", and its third test case contradicts the rule. The report proposed two narrower rules instead. This is the ticket I would have handed the factory.

## Tool observations

Measured on the way, not claims about the tool in general:

- `get-pr` with `--include-diff false` failed in all four reports with "too many arguments", and `--include-diff=false` with "unknown option". No report could read a pull request's review threads; three had wanted to.
- `grep --path-glob "packages/harness/src/**/*.ts"` returned empty for a pattern that a glob-free grep then found (W-0, calls 4 and 7). `**/*.md` did not cover root-level files (W-1, W-3).
- `list-prs` answers of 90 to 170 KB were persisted to a local file by the CLI, with only a 2 KB preview inline. No investigator opened the file.
- The pull-request group (`similar`, `review-history`, `stats`) was not used; it had answered `MT-UPSTREAM-DOWN` all day, as recorded in [../probes.md](../probes.md).

## Caveats

- One run per ticket, one investigator model, one repository, three planted premises. This is a first measurement, not a benchmark.
- The repository contains its own Day 6 report, which names where `privateDir()` lives. The W-2 investigator read that file as well as the code. Its deciding citations are code lines and a blame, which the file does not give, but the hint existed. No published file mentions the W-1 or W-3 premises.
- The investigator's report format asked for a premise table with "holds / does not hold / could not check". That instruction is part of the unit under test; a looser prompt might score differently.
- The deleting commit of W-1's file has a message that explains the deletion. A silent deletion would be a harder case.

## What this changes

The three stale premises are exactly the kind #4 carried this morning, and they were caught at a cost of about 25 read calls per ticket with no human in the loop. That makes a pre-build premise check a factory step, not a Day 6 ritual: a ticket's named files, helpers and scripts can be checked before the runner starts the agent. It is proposed as a ticket, not built here.
