/**
 * Which ticket a factory tick takes, and whether it may start (`factory-tick.ts`, steps 2 and 3): every
 * ticket labelled `ready-for-agent` that no run is working on, and for the one picked, the first reason it
 * is turned away, if any: a label someone other than the owner added, ticket text someone else wrote, or a
 * ticket that isn't ready.
 */
import type { FactoryConfig } from "./factory-config.ts";
import { type Candidate, LABELS, lastLabelled } from "./factory-settle.ts";
import type { TickDeps } from "./factory-tick-deps.ts";
import { provenanceProblems } from "./ticket-snapshot.ts";

/** Every open ticket labelled `ready-for-agent`, in every repo, with who added the label and when. */
export function readyCandidates(factory: FactoryConfig, deps: Pick<TickDeps, "labelled" | "events">): Candidate[] {
  const candidates: Candidate[] = [];
  for (const [repoKey, repo] of Object.entries(factory.repos)) {
    // Still agent-working after recovery: a live run's, here or in the other mode, even with a leftover
    // ready-for-agent beside it. Never picked again (Qodo on PR 268).
    const busy = new Set(deps.labelled(repo.github, LABELS.working).map((t) => t.number));
    for (const issue of deps.labelled(repo.github, LABELS.ready)) {
      if (busy.has(issue.number)) continue;
      const added = lastLabelled(deps.events(repo.github, issue.number), LABELS.ready);
      if (!added) continue;
      candidates.push({
        repoKey,
        github: repo.github,
        number: issue.number,
        title: issue.title,
        labelledAt: added.at,
        labelledBy: added.by,
      });
    }
  }
  return candidates;
}

/** How a ticket that won't run is turned away: the outcome logged, the label added, and the comment. */
export interface TurnAway {
  outcome: "refused" | "not-ready";
  add: string[];
  body: string;
  detail: Record<string, unknown>;
}

/**
 * The first reason the picked ticket may not start, or null. Checked in this order, and each only once the
 * one before passed: who added the label, who wrote, edited and commented on the ticket, and its readiness.
 */
export function admissionRefusal(pick: Candidate, deps: Pick<TickDeps, "snapshot" | "ready">): TurnAway | null {
  const owner = pick.github.split("/")[0] ?? "";
  if (pick.labelledBy.toLowerCase() !== owner.toLowerCase()) {
    return {
      outcome: "refused",
      add: [],
      body: `Not started. The \`${LABELS.ready}\` label was added by ${pick.labelledBy}, and only the repository owner can start an agent run. The label has been removed.`,
      detail: { reason: `label added by ${pick.labelledBy}, not the owner ${owner}` },
    };
  }

  const authors = provenanceProblems(deps.snapshot(pick.github, pick.number).provenance, owner);
  if (authors.length) {
    return {
      outcome: "refused",
      add: [],
      body: `Not started. An agent run follows this ticket's text, so only a ticket written, edited and commented on by the repository owner can start one (${authors.join("; ")}). The label has been removed.`,
      detail: { reason: authors.join("; ") },
    };
  }

  const readiness = deps.ready(pick.repoKey, pick.number);
  if (readiness.problems.length) {
    return {
      outcome: "not-ready",
      add: [LABELS.help],
      body: `Not started: this ticket isn't ready yet.\n\n${readiness.problems.map((p) => `- ${p}`).join("\n")}\n\nFix the ticket and add \`${LABELS.ready}\` again.`,
      detail: { problems: readiness.problems },
    };
  }
  return null;
}
