# Day 6 evidence: method, written before the answers

Date: 11 November 2026. Local checkout: faultforge `main` at `0b84165`. Tool: Qodo Agentic Toolbox CLI 2.2.0, skill `qodo-codebase-wisdom`, read-only `qodo read` gateway only. No write tool is called on any PR. The target repository is not queried today.

Every answer from the remote tools is treated like a reviewer finding: it is a claim until it is checked against the local checkout at the same commit. Each claim gets one row in `claims.md`: the claim, its remote source (tool, path, line), the local check, and a verdict: **verified**, **wrong**, or **unverifiable**. The headline number of the day is the verified rate.

## Step 2 questions (explore the project)

- Q1. Where does a factory run decide whether a ticket may start, and where does it stop for the owner?
- Q2. Which harness scripts call GitHub through their own `gh` wrapper, rather than a shared module?
- Q3. What reads `factory.json`, and what would a change to its shape affect?
- Q4. How does a run's evidence reach the private repository, and what stops anything else from going there?
- Q5. How many places resolve the private directory (`FAULTFORGE_PRIVATE_DIR`) on their own?
- Q6. What in the repository checks Qodo's configuration against the saved snapshot today, and when does it run?
- Q7. What is the recent change history of `factory-tick.ts` (the module the open refactor tickets touch)?

## Step 3 questions (triage the backlog)

For each open ticket, the question is the same: is the work already delivered, partly delivered, or not started, judged by whether the files, scripts and behaviours the ticket names exist on `main`? The eleven week-1 tickets come first because the Day 3 to 5 work may have delivered them.

## Step 4

The ticket the triage selects is investigated with the challenge's own prompt: fit with the current project, reusable code, affected components, alternatives, source references, verified facts separated from assumptions, open decisions.

## What is not in scope

Qodo's pull-request tools (`similar`, `stats`, `review-history`, `by-file`) have answered `MT-UPSTREAM-DOWN` since 9 November for every entrant; a probe at the start of the day is recorded in `probes.md`. History questions use `list-commits`, `get-commit` and `blame` instead.

## Note on the raw files

The files under `raw/` are the tool outputs with the trailing `trace <id>` line removed and pretty-printed by the repository formatter (Biome), which changes whitespace only. The content is as received.
