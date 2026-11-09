# Does a house rule change the review? A before-and-after measurement

**Date:** 9 November 2026 (Day 5). **Reviewer:** Qodo, automatic PR review.
**Rule under test:** `AGENTS.md` rule 1, "Evidence capture is fail-safe and complete" (adopted in #91, ticket #79).

## Method

Four small diffs. Three re-create past, fixed mistakes the rule covers, by reverting their fixes
in plausible refactor form; one is a compliant control. Each was opened as an ordinary-looking PR
twice:

- **Before:** while Qodo had no rules for this repository (configuration v5; checked through the
  API and saved first). Branches off `main` at `a34772b`.
- **After:** with the rule active and snapshotted as configuration v6. Branches off `main` at
  `ee66e09` — necessarily a later baseline, because an in-repo rule only exists once its merge is
  in `main`. The diffs themselves are byte-identical (the saved patches applied cleanly to both
  baselines).

Fresh branch names the second time, no ticket links while reviews ran. Every review was captured
with `review:wait` (completion judged by Qodo's API state, not its comment), all eight PRs were
closed without merging, and their saved reviews were moved out of the folder the evidence table
reads, so the factory never learns from planted regressions. The fixed match question per diff:
did any finding name the changed behaviour?

## Results

| Diff (what was planted) | Before: v5, no rule | After: v6, rule active |
|---|---|---|
| A. Pagination dropped in the gh helper (re-creates the Day 3 "later pages disappear" bug) | **Caught.** "Long pull requests lose review evidence" — Bug, action_required, standard review (#87) | **Caught.** "Later Qodo comments go unsaved" — Bug, action_required, standard (#92) |
| B. Raw API snapshot saved only after parsing (re-creates "failed reviews leave no raw evidence") | **Caught.** "Failed review polls lose raw diagnostics" — Bug, remediation_recommended, Observability, standard (#88) | **Caught.** "Raw Qodo response is lost when the answer fails to parse" — **Rule violation**, **action_required**, Reliability, standard (#93) |
| C. Inline-comment endpoint dropped from the poll (re-creates "inline review comments are not saved") | **Caught.** "Inline Qodo comments are no longer saved while waiting" — Bug, remediation_recommended, lite (#89) | **Caught.** "Review evidence drops Qodo's inline comments from the saved capture" — **Rule violation**, **action_required**, Correctness, lite (#94) |
| D. Control: an elapsed-time line, tested | **No capture-class finding.** One fair nit (the elapsed figure includes post-review work) — Bug, remediation_recommended, lite (#90) | **Same single nit**, same label and severity, no rule finding (#95) |

## Reading

- **The rule did not rescue catches.** Qodo caught all three planted regressions without it. On
  this evidence, the rule's effect is not "catch more".
- **The rule changed the verdicts.** Diffs B and C were re-labeled from Bug to **Rule violation**
  and escalated from remediation_recommended to **action_required**. B's category moved from
  Observability to Reliability, matching the derived rule "Persist raw external evidence before
  parsing it"; C's finding text cites the rule's own success example and the PR that fixed the
  original bug. A reviewer deciding what blocks a merge sees a different answer under the rule.
- **Diff A escalated nothing** — it was already action_required before the rule — and Qodo did not
  link it to the derived "read every page" rule. One clause of the rule went unused where it
  applied; recorded as-is.
- **No false positive on the control.** The compliant diff got the same single nit in both arms,
  never a rule flag. Within this sample, the rule's attention cost on correct code is zero.

## Limitations

- Qodo chooses the review depth per PR (standard or lite); depth is recorded but not controlled.
  It chose the same depth for each diff in both arms.
- The after-arm reviews the same diffs the before-arm did, in the same repository; the reviewer
  may carry memory of the earlier PRs. That favours "caught" equally in both arms, so label and
  severity changes stay comparable, but the after-arm's catches are not independent evidence.
- The two arms branch from different `main` commits (unavoidable for an in-repo rule, see Method);
  the diffs are identical, the surrounding files differ by the adopted rule text and the Day 4/5
  tooling.
- Four diffs are a small sample. This measures direction, not a rate.
- The arms ran under configurations v5 and v6; the rule is the only intended difference, and the
  target repository's 19 rules were verified unchanged, field by field, on both sides.
