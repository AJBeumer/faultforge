# Decision log, week 3 (16 to 22 November)

Part of the [decision log](../decision-log.md). Entries are copied verbatim, in order.

## 16 November: Qodo configuration v11, web search off

Recorded before any case runs under it.

- **Web search is off.** The 15 November entry listed web search during review as the one channel verified open: a review could search the public web, this repository included. The owner switched it off at workspace level. Qodo's settings then showed it off for this repository and for `faultforge-target`, with no override for either. The screenshots are in private storage. A separate Qodo workspace for this repository was the other option. It was not chosen, because it would leave this repository public and searchable, and the trial ends this week.
- **4 new rules, scoped to this repository only.** Qodo wrote them by itself from this repository's `CLAUDE.md` after PR 351 described the door for target writes, and they are active. The rules that reach the target are unchanged, compared by id, name, content, state, scope and severity. `qodo:check` matches v11.
- **The 15 November unexplained rules, likely explained.** These 4 rules were created hours after Qodo's settings showed "auto-approve rules from repository files" off, and they are active anyway. So Qodo activates rules it imports from repository files even with that setting off. That is the likely route for the 7 charter rules recorded as unexplained. It is observed behaviour, not documented.
- **Comparability.** Every case so far ran with web search on. Cases under v11 are reported as their own group, never pooled with earlier results.
