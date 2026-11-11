# Day 6: ask the codebase before you build

Date: 11 November 2026. Local checkout `main` at `0b84165`. Tool: Qodo Agentic Toolbox CLI 2.2.0 with the `qodo-codebase-wisdom` skill in Claude Code, read-only gateway only. Raw outputs, the pre-registered questions and the claim-by-claim checks are in [evidence/day-06/](evidence/day-06/).

The method is the one FaultForge applies to reviewer findings: every answer from the remote tools is a claim until it is checked against the code at the same commit. **13 of 13 checkable claims were verified, 0 wrong, 1 caveat** ([claims.md](evidence/day-06/claims.md)). All 49 open tickets were triaged, not one ([triage.md](evidence/day-06/triage.md)): one is already delivered (#16), one is half delivered by a later ticket (#62), two are stale in details that would have misled a build (#7, #108), and one is rewritten below (#4).

## Original work order

Ticket: [#4 Check Qodo's setup before each case](https://github.com/AJBeumer/faultforge/issues/4), written 6 November, untouched since. Original wording (kept in full in a collapsed section on the ticket):

> **Result.** One command confirms Qodo matches the saved config.
> **Done when.** Compares rules and skills with the saved snapshot. Fails if any repo is linked to the target. Read-only API calls only. `/new-case` runs it first. Tests for match, changed rule, extra rule.
> **Why.** On Day 2 a push to the target changed Qodo's rules.
> **Notes.** Files: new `packages/harness/src/qodo-check.ts`, script `qodo:check` in `package.json`. Read-only client: `private/qodo-mcp-readonly.mjs` (tools `rules-list`, `review-skills-list`, `cross-repo-overview`). Snapshot: `private/config/qodo-v3/`. Compare by rule id, content and state. Ignore timestamps and counters like `updatedAt`. The key file path comes from `QODO_KEY_FILE`; never print the key.

Proposed implementation: a script that compares the live rule and skill lists with the v3 snapshot, run by the `/new-case` skill before a case.

## What I investigated

**Questions asked** (pre-registered in [00-method.md](evidence/day-06/00-method.md)): what checks Qodo's configuration today and when it runs (Q6); what client code exists for Qodo's API and who uses it; what the snapshot format is; how the factory run is gated and where a pre-run check would go (Q1, Q4); and, across the backlog, which tickets the Day 3 to 5 work had already delivered.

**Useful findings and source references**

- The check exists only as a manual instruction: `.claude/skills/new-case/SKILL.md:17` tells the agent to call the read-only client by hand and compare with the snapshot. No script does it (`package.json` at `0b84165` has no `qodo:check`; no `qodo-check.ts`). The instruction entered the skill on 6 November in commit `bc93dae`, the same day the ticket was written (C6, C7).
- The client the ticket names, `private/qodo-mcp-readonly.mjs`, has since been superseded inside the harness: `packages/harness/src/qodo-api.ts` is a read-only client with an allow-list that already contains exactly the three tools the ticket needs, `rules-list`, `review-skills-list` and `cross-repo-overview` (lines 15-17), plus the key handling the ticket asks for (`QODO_API_KEY` or `QODO_KEY_FILE`, never printed), a 60-second time limit, session recovery, and the raw-body capture that `review:wait` uses to save evidence before parsing (`review-wait.ts:22,431-451`). Reuse is total: the check needs no new client code.
- The snapshot is at v6, not v3: `private/config/qodo-v6/` holds `rules.json` (42 rules, one page), `review-skills-list.json` and `cross-repo-relations.json`. The live rule list is now 57 entries, more than the API's default page of 50: the check must read every page, which is also the first clause of the house rule adopted on Day 5.
- Where a pre-run check belongs: `factory-tick.ts` already runs a hook self-test before a run (`:518`, failure at `:1402`) and records events in the run log; a configuration check sits naturally beside it, and a failure ends the run as `needs-help` like any other pre-run failure (C9, C10).
- The drift the ticket was written to catch happened, and was missed. The check I did by hand this morning found 15 rules Qodo derived from `CLAUDE.md` on 9 November at 18:16Z and 19:16Z, within a minute of two merges to main (PRs 118 and 120), 14 of them active, none adopted through the project's rule pipeline. Every faultforge review from then until 11 November ran under that unrecorded configuration; one saved finding (PR 135) is linked to a derived rule. The 19 target rules were unchanged. Raw state before and after the correction is in private storage (`raw-artifacts/day-06/qodo-state-2026-11-11/`); the decision is in the decision log under 11 November.

**What I checked against the project:** every claim in [claims.md](evidence/day-06/claims.md), by local grep, `sed` on the cited lines, `git log` and `gh`, at the same commit the mirror served (C1). The reuse claim about `qodo-api.ts` was checked by reading the module in full.

**Assumptions I could not verify:** Qodo's pull-request tools (`similar`, `review-history`, `stats`) answered `MT-UPSTREAM-DOWN` all day, as for every Day 6 entrant since 9 November, so no past review suggestion about configuration checks could be searched. History came from `list-commits` and `git log` instead. Whether Qodo offers a way to stop deriving rules from a repository file at all is not documented on the pages I could reach; the toggle in the portal applies to the rules that exist when it is set.

## Resulting decision

**Revised ticket:** [#4, rewritten](https://github.com/AJBeumer/faultforge/issues/4), now "Check Qodo's configuration against the snapshot before every run". The number, the result and the first three criteria stay. What changed:

1. **Scope: before every run, not before each case.** The drift came from ordinary pushes to main, on a day with no case at all. The check runs inside `factory:tick` before the hook self-test, records a `qodo-checked` event in the run log, and ends the run as `needs-help` on any difference. It also runs at the start of each day.
2. **Reuse `qodo-api.ts`** instead of the private script the ticket named. The allow-list, key handling, time limit and raw capture already exist and are tested. The alternative, calling the new toolbox CLI (`qodo read rules list`), was rejected: it is not installed on the CI runner, and the harness already has a client under test.
3. **The current snapshot is the highest-numbered `private/config/qodo-vN/`**, not v3. Nothing else to maintain: a new version is a new folder.
4. **Read every page.** The live list is already longer than one page.
5. **Exit codes mean one thing each** (0 match, 1 difference, 2 unable to check), and the live answers are saved raw before comparing, as `review:wait` does. Both are house rules the ticket predates.
6. **The `.claude/` edits are split out.** The original criterion "`/new-case` runs it first" needs an edit under `.claude/`, which an unattended run may not make (the hook denies it; #142 and #102 both stopped on exactly this). The skill edits are an owner follow-up, so the factory can build the ticket end to end.

**Kept:** read-only calls only; compare by id, content and state while ignoring timestamps; fail when any repository is linked to the target; tests for match, changed rule and extra rule (now also: missing rule, inactive turned active, relationship present, a second page, no snapshot, API error).

**Why rewrite rather than build as written:** the ticket as written would have been built against a client that is no longer the harness's, against a snapshot two versions old, and at a point in the workflow (before a case) that would have missed the drift that actually occurred.

**Remaining questions or blockers**

- Can Qodo stop deriving rules from `CLAUDE.md` altogether? Not answered by the documentation reachable today. Until it is, the check is the defence, and the v6 README's warning stands.
- Rule proposal #136 used evidence partly produced under the drifted configuration; the owner decides it with that known.
- The pull-request history search is still to run once Qodo's tools respond.

## Other outcomes of the triage

- **#16 is delivered** (Day 3, configuration v5). Comment with evidence posted; the owner closes it.
- **#108 corrected** on the ticket: six `gh` call sites, not five (`verdict.ts:202`), and a shared `privateDir()` already exists in `templates.ts:15`, so `paths.ts` should start by moving it, not adding a second resolver.
- **#7 corrected**: an end-to-end inject test belongs in `npm run test:integration`, never in `check`, under the code layout rule written after the ticket.
- **#62 half delivered** by #64 (`revert:check`); suggested rescope on the ticket.
