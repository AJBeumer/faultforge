# 19. Risks

Part of the [FaultForge charter](../CHARTER.md), version 2.3.

| Risk | Mitigation |
|---|---|
| Scope grows into three projects | One vertical slice at a time. Arbiter is a function, Debate Chamber is static, rule engine is a PR generator |
| Qodo local review is gated or output differs | Day 2 gate. PR-comment fallback. Path labelled per case |
| Trial ends or quota runs out before Day 30 | Confirm at signup. Budget calls. Cache raw results. Never invent missing ones |
| Qodo changes under the benchmark | Record date and version per case. Stratify. Freeze configuration per benchmark version |
| Review non-determinism | Measure variance on Day 2. Report it. Repeat key cases |
| Challenger dismisses real defects | Evidence requirements, inconclusive by default, human gate, wrongly-suppressed metric |
| Test does not exercise the alleged failure | Validate preconditions, affected path, state assertions, correct-versus-defective behaviour. Qodo reviews the test |
| Ground truth leaks | Separate repositories and private storage. No template ids or confessions in PR context |
| Repetition inflates detection | Rotate templates, locations, classes, controls. Tag repeats and hold-outs |
| Solo adjudication bias | Fixed match rule before data. Every adjudication logged with rationale |
| Sample too small | Raw counts, narrow claims, case studies |
| Sandbox runs untrusted generated code | Disposable isolated runner, resource and network limits, no credentials |
| Rule changes teach the answers | Human-reviewed scoped proposals, held-out checks, no automatic deployment |
| Daily challenges divert effort | Protocol above. Rescope optional work before core integrity |
| Generic mutations on unfamiliar code change nothing observable | Compile check, test-based validation, challenger reproduction. Unconfirmed defects excluded from every rate |
| Replay looks staged | Only the Qodo call is substituted, output is labelled, and numbers must match the published report |
| Audit costs users review quota | `--budget` cap, sampling, cost estimate before running |
| Judges cannot run it | Browse needs a browser, replay needs no Qodo account, Codespace verified on a clean machine before submission |
