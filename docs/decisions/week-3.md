# Decision log, week 3 (16 to 22 November)

Part of the [decision log](../decision-log.md). Entries are copied verbatim, in order.

## 16 November: Qodo configuration v11, web search off

Recorded before any case runs under it.

- **Web search is off.** The 15 November entry listed web search during review as the one channel verified open: a review could search the public web, this repository included. The owner switched it off at workspace level. Qodo's settings then showed it off for this repository and for `faultforge-target`, with no override for either. The screenshots are in private storage. A separate Qodo workspace for this repository was the other option. It was not chosen, because it would leave this repository public and searchable, and the trial ends this week.
- **4 new rules, scoped to this repository only.** Qodo wrote them by itself from this repository's `CLAUDE.md` after PR 351 described the door for target writes, and they are active. The rules that reach the target are unchanged, compared by id, name, content, state, scope and severity. `qodo:check` matches v11.
- **The 15 November unexplained rules, likely explained.** These 4 rules were created hours after Qodo's settings showed "auto-approve rules from repository files" off, and they are active anyway. So Qodo activates rules it imports from repository files even with that setting off. That is the likely route for the 7 charter rules recorded as unexplained. It is observed behaviour, not documented.
- **Comparability.** Every case so far ran with web search on. Cases under v11 are reported as their own group, never pooled with earlier results.

## 16 November: a layout a person can work in, and Qodo configuration v12

The eighth independent re-grade scored Maintainability 6. The owner decided that maintainability comes before further security work, with no change to behaviour.

- **Docs (#354, PR 357).** A start page, `docs/README.md`, maps every doc. The charter and this log are split into short pages, the README is under 100 lines, and `CLAUDE.md` keeps each hard rule as one bullet with a link to the page that explains it. Content was moved, not reworded, and a word-for-word comparison is in the PR. `docs:check` now holds every page to 150 lines, checks every link, and checks that the start page links every doc.
- **Hooks (#355, PR 358).** The guard's modules sit in folders by job, with a one-page map. Test files are named for the behaviour they test rather than the audit round that found it. Dependencies on the harness go through one bridge module. Hook code may not grow past 7,001 lines without a reviewed change to that budget.
- **Harness (#356, PR 359).** 223 files in one folder became 17 area folders, each with a short README. The areas depend on each other in one direction.
- **Tests.** Every test that existed before still exists, under the same title. The two PRs added 11 tests for the new structure (3,072 to 3,083).
- **Qodo configuration v12.** Qodo changed its own rules for this repository after the charter and `CLAUDE.md` were restructured. It removed the 8 rules it had written from the charter and 2 from `CLAUDE.md`, reworded 5, and set one muted rule active again. Nobody on the project made these changes. The rules that reach the target are unchanged, web search stays off, and `qodo:check` matches v12. No case ran under v11, so no result is affected. It is the third time a rule for this repository became active without anyone approving it.
