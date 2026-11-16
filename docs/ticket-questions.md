# Questions before the build

A gap in a ticket becomes a guess in the code, and then a finding in review. So before the factory
builds a ticket, it checks the ticket for open questions and asks the owner first.

## What happens

1. The owner adds `ready-for-agent`. The runner checks the ticket as before: only the owner's
   text, every required section, no open blocker.
2. The runner claims the ticket, builds the run's workspace, and starts a **read-only agent** on
   the ticket's text. It may read the repository. It has three tools, Read, Glob and Grep, and no
   other: no shell, no edit, no network tool, and no GitHub token.
3. The agent answers with the questions a builder would have to guess at: a choice the ticket
   leaves open, where two reasonable builders would build different things. At most five. No
   questions is the usual answer.
4. **With questions**, the runner posts one comment. Each question has two to four lettered
   choices and one marked as recommended, with a reason. The ticket gets `needs-owner-answer`, and
   nothing is built.
5. **With none**, the build starts as it always did. The run log says "no open questions".

## Answering

Reply in one comment, such as `1a, 2b`, or `agree` to take every recommended answer, and add
anything else the builder should know. Then add `ready-for-agent` again.

The builder reads the questions and the reply as part of the ticket. This is the one runner
comment a builder ever reads, and only after the owner has replied to it. Every other runner
comment stays out of the builder's instructions, because it can quote an earlier agent.

A ticket is asked **once**. If the owner adds the label again without replying, the build starts:
that is the owner's answer too. There is no thread.

## When the check itself fails

The agent's answer is data. It must fit [`schemas/clarify.v1.json`](../schemas/clarify.v1.json).
A reply with no answer, an answer that doesn't fit, an agent that ran out of time or could not
start: each ends the run as `agent-needs-help`, and nothing is built. A failed check is never read
as "no questions".

The agent's words are made plain before they reach the comment, so they can't mention anyone,
link, or pass for one of the runner's own marks.

## Measuring it

```
npm run clarify:measure
```

The step is checked against an answer key. A fixed set of made-up tickets, half with one known gap
and half complete, is kept in private storage with the words a question about each gap would
hold. The set is private because the agent reads the repository: a key in a public file is a key
it could find. The command runs the real step on each ticket and counts two things: gaps it asked
about, and complete tickets it left alone. A ticket it could not check counts as neither.

Results are in the [decision log](decision-log.md).
