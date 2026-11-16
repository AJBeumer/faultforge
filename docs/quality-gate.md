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

## Checking the threshold against known answers

```
npm run gate:replay              # every adjudicated case, for the owner
npm run gate:replay -- --public  # only cases the decision log already names
```

Every adjudicated case has a saved review and a known answer: a planted bug, or a clean control.
`gate:replay` applies the gate to those reviews and says what it would have decided. For a bug the
reviewer caught, it gives the label of the finding that describes the bug, and whether the gate
would have required the fix or called the pull request done with the bug still in it. For every
case it counts the other findings the gate would have made the agent act on.

It compares two thresholds with the same function the runner uses: the saved gate, and the saved
gate with only its first label to fix. The match rule decides which finding describes the bug, and
it is not changed. The command reads only. The results are in the
[decision log](decision-log.md).

## Checking the gate by its outcome

```
npm run gate:trial -- FF-0012 --gate saved
npm run gate:trial -- FF-0012 --gate first-label-only
```

A gate can meet its own rule and still let a defect through. `gate:trial` checks that with tests
the loop never sees.

1. It makes a scratch copy of the reviewed repository at an adjudicated case's base commit and
   applies the case's change, uncommitted. The copy can't push anywhere.
2. Qodo's local review reads the uncommitted change, with the case's ordinary ticket as context.
3. The gate decides. If it is not met, a builder agent gets the ticket, the gate and the findings
   it must act on, and nothing else. It works only in the scratch copy.
4. Steps 2 and 3 repeat until the gate is met or the task is reported not done.
5. Then the case's proof tests run. Neither the reviewer nor the builder saw them.

The record says how the loop ended and what the proofs say:

- **Gate met, defect gone.** The gate did its job.
- **Gate met, defect survived.** An escape: the loop said done with the planted defect still in.
- **Damage.** A proof that passed before the loop fails after it: a fix broke something that worked.
- **Not done.** The loop stopped and said why: the round limit, a round that closed nothing, an
  incomplete review, or a disagreement.

A builder that thinks a finding is wrong must hand in a test that would fail if the finding were
true. If that test passes, the trial stops as "the owner must decide". Without such a test, the
finding just counts as still open.

Only a case the decision log already names can be tried. A trial is not a case: it adds nothing to
the answer key or to a case record, and its results are never pooled with benchmark results.
Nothing is written to the reviewed repository, and no finding is dismissed or answered.

## Why it lives in `factory.json`

`AGENTS.md` and `CLAUDE.md` are read by Qodo as review rules. A gate written there would change
the reviewer's configuration, and results are only comparable under the same configuration.
`factory.json` is read by the factory and by nothing else.
