# 12. Evaluation methodology

Part of the [FaultForge charter](../CHARTER.md), version 2.3.

This is the project's credibility backbone. The scorecard stays honest when results disappoint.

## Ground truth and labelling

- The invariant is specified before injection. Each mutation is validated against the correct and defective variants.
- The answer key is private and unavailable to the reviewer and challenger.
- **Match rule, fixed before data collection:** a finding counts as a detection when it names the injected file, overlaps the injected line range, and its title, summary or category contains one of the kind terms its template declared before the case ran (`match.kindTerms`). A generic warning is not a detection. Criteria are never loosened after seeing results. The owner's verdict, recorded with its reason, is the check that the finding describes the right kind of problem.
- Findings outside the injected range, and all findings on control changes, are adjudicated by a human. Unadjudicated findings are reported as unresolved, never as false positives.
- Clean control changes are included from week one. Precision cannot be estimated without them.

## Core measurements

| Measurement | Definition |
|---|---|
| Seeded recall | Detected injected defects / valid injected defects evaluated |
| Finding precision | Adjudicated true-positive findings / all adjudicated findings |
| Retained precision | True-positive findings retained after the challenger / all retained adjudicated findings |
| Wrongly suppressed | True-positive findings the challenger marked disproven. The key safety metric |
| Inconclusive rate | Challenges ending inconclusive / challenges run |
| Review variance | Differences in findings across repeated reviews of an identical diff |

Also, where practical: outcomes per defect class and template, reproduction rate, time and cost per case, and the share of cases eligible for automatic suppression.

## Distinctions that must survive into the report

- Recall and precision have different denominators. Say which.
- Recall is recall on the seeded benchmark, not on all possible defects.
- A missed injection says nothing about the truth of Qodo's other findings on that PR.
- A test that fails on the defective variant and passes on the correct one supports a reproduced defect. The challenger must still connect it to the specific finding.
- Run failures, rate limits, and partial coverage stay visible.

## Contamination controls

Rotate defect classes, templates, files, functions, surrounding code, ordering, and control changes. Keep held-out templates unused by any rule proposal. Record template id, tool configuration, review path, snapshot, and date privately so results can be stratified. Distinguish repeated-template cases from held-out cases. Do not claim generalization from a small or repeatedly exposed sample.

## Reporting standard

Never publish illustrative or simulated percentages as results. Publish raw counts, denominators, definitions, dates, configuration versions, and caveats. If the sample is too small for a meaningful percentage, present counts and case studies.

Blank report structure, no fabricated data:

| Metric | Qodo alone | With Devil's Advocate |
|---|---:|---:|
| Valid injected cases evaluated | TBD | same set |
| Injected defects detected | TBD | unchanged by design |
| Adjudicated finding precision | TBD | TBD |
| Genuine findings wrongly suppressed | n/a | TBD |
| Inconclusive challenges | n/a | TBD |
| Median review or challenge time | TBD | TBD |
