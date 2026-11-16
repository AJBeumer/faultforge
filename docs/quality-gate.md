# The quality gate

The factory's rule for when a coding task is done. It says which of the reviewer's findings must be
fixed first, and which only go to the owner.

## The gate

It is data, in the `gate` section of [`factory.json`](../factory.json):

```json
"gate": {
  "fix": ["action_required", "remediation_recommended"],
  "flag": ["informational"],
  "maxRounds": 3
}
```

Qodo's API labels each finding with an `action_level`. Its review comments show the same three
levels as High, Medium and Low.

| Qodo's label | Shown as | The gate says |
|---|---|---|
| `action_required` | High | Fix it. The task is not done while it is open. |
| `remediation_recommended` | Medium | Fix it. The task is not done while it is open. |
| `informational` | Low | Leave the code unchanged. List the finding for the owner. |
| anything else, or no label | | It blocks. Nobody guessed what it means. |

The type of a finding (bug, rule violation, requirement gap) does not change the answer.

## What "fixed" and "wrong" mean

- **Fixed** means Qodo's review of the newest commit no longer lists the finding as open, and the
  pull request's tests fail without its change (`npm run revert:check`). Qodo's own "resolved" mark
  is not enough alone: it follows lines, and has closed findings when lines only moved.
- **Wrong** is the owner's call. An agent that disagrees with a High or Medium finding leaves it
  open, puts its evidence in the pull request, and reports the task as not done. It never
  dismisses a finding and never replies to the reviewer.

## When the task is not done

- A High or Medium finding is open, or a finding has a label the gate doesn't know.
- The saved review is of an older commit than the pull request's head.
- The review didn't finish, or Qodo skipped it.
- More review rounds have run than the gate's `maxRounds`. A round is one pushed commit that Qodo
  reviewed. The runner takes the number from Qodo's own record of the pull request, never from the
  agent, and a record with no countable run blocks too.
- A round closed nothing that had to be fixed. The agent stops itself here; the runner does not check it.

## Who decides

The runner, not the agent. After the agent reports, the runner reads Qodo's review of the pull
request's head from a fresh checkout of `main` and applies the gate itself
(`packages/harness/src/shared/quality-gate.ts`). The agent's report can't change the answer, and a
pull request can't edit the gate that judges it: `factory.json` is one of the files a run may not
change unless the owner allowed it on the ticket.

The agent's instructions are written from the same data, so the gate the agent reads is the gate
the runner applies.

## Checking a pull request by hand

```
npm run review:wait -- faultforge 380 --commit <sha>
npm run gate:check -- faultforge 380
```

`gate:check` reads the saved review and prints every finding under a heading: must fix, unknown
label, flagged for the owner, or closed since an earlier saved review of the same pull request.
It also prints the number of review rounds. Exit codes: 0 the gate is met, 1 it isn't, 2 it
could not be decided, such as when no review of the head is saved.

## Why it lives in `factory.json`

`AGENTS.md` and `CLAUDE.md` are read by Qodo as review rules. A gate written there would change
the reviewer's configuration, and results are only comparable under the same configuration.
`factory.json` is read by the factory and by nothing else.
