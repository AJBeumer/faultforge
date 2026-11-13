/**
 * The audit after the agent stops: what actually changed while it ran (each repo's `main`, the owner's
 * checkouts, the guardrail files, comments, reviews and ticket changes), whatever its commands looked like.
 * Split from factory-tick.ts (#227).
 */
import type { FactoryConfig } from "./factory-config.ts";
import { git } from "./factory-exec.ts";
import type { Candidate, IssueEvent, Workspace } from "./factory-tick.ts";
import { fingerprints, PRIVATE_KEY, type RunMode } from "./factory-workspace.ts";
import { gh, ghAll, ghApiJson } from "./github.ts";

export interface WindowActivity {
  /** Comments on any issue or PR, and inline review comments, by the agent's login. */
  comments: { user: string; created_at: string; url: string }[];
  /** Events on the ticket, such as labels or closing. */
  ticketEvents: IssueEvent[];
  /** Submitted PR reviews (approve, request changes, comment), which leave no comment of their own. */
  reviews?: { user: string; created_at: string; url: string }[];
}

/**
 * Things the agent's GitHub identity did during the run that only the runner or the owner may do: a
 * comment anywhere (a reply to a review finding, a PR comment) or a change to the ticket. The agent
 * runs as the owner, so anything by that login inside the agent's window counts.
 */
export function windowProblems(activity: WindowActivity, login: string, from: string, to: string): string[] {
  // GitHub records whole seconds and the run records milliseconds: widen the window to whole seconds,
  // so an action in the same second as the agent's start or end still counts.
  const start = Math.floor(Date.parse(from) / 1000) * 1000;
  const end = Math.ceil(Date.parse(to) / 1000) * 1000;
  const inWindow = (at: string) => Date.parse(at) >= start && Date.parse(at) <= end;
  const mine = (user: string | undefined) => user?.toLowerCase() === login.toLowerCase();
  const problems: string[] = [];
  for (const c of activity.comments) {
    if (mine(c.user) && inWindow(c.created_at)) problems.push(`a comment was posted during the run (${c.url})`);
  }
  for (const r of activity.reviews ?? []) {
    if (mine(r.user) && inWindow(r.created_at)) problems.push(`a PR review was submitted during the run (${r.url})`);
  }
  for (const e of activity.ticketEvents) {
    if (inWindow(e.created_at))
      problems.push(`the ticket was changed during the run (${e.event} by ${e.actor?.login ?? "?"})`);
  }
  return problems;
}

/**
 * Pulls from a `sort=updated&direction=desc` listing, newest first, no older than `cutoffMs` (epoch
 * ms). `fetchPage` returns one page (1-based) or `[]` past the end. Stops as soon as a page holds a
 * pull older than the cutoff, since every pull after it, on this page or any later one, is older
 * still: the audit reads every pull in its own run window without reading a repo's whole history.
 */
export function pullsSince<P extends { updated_at: string }>(cutoffMs: number, fetchPage: (page: number) => P[]): P[] {
  const out: P[] = [];
  for (let page = 1; ; page++) {
    const batch = fetchPage(page);
    if (!batch.length) return out;
    for (const pull of batch) {
      if (Date.parse(pull.updated_at) < cutoffMs) return out;
      out.push(pull);
    }
  }
}

/** What actually changed while the agent ran (`TickDeps.audit`): anything here is a stop for the owner. */
export function auditRun(
  factory: FactoryConfig,
  privateRepo: string,
  mode: RunMode,
  ws: Workspace,
  ticket: Candidate,
  from: string,
  to: string,
): string[] {
  const problems: string[] = [];
  for (const [key, repo] of Object.entries(factory.repos)) {
    const now = gh("api", `repos/${repo.github}/commits/main`, "--jq", ".sha").trim();
    const before = ws.mainAtStart[key] ?? "";
    if (now !== before) problems.push(`main of ${key} moved (${before.slice(0, 7)} → ${now.slice(0, 7)})`);
  }
  // The agent may commit evidence to its private branch, but only the runner pushes it, after this audit.
  const privateNow = git(privateRepo, "ls-remote", "origin", "refs/heads/main").split(/\s/)[0] ?? "";
  const privateBefore = ws.mainAtStart[PRIVATE_KEY] ?? "";
  if (privateNow !== privateBefore)
    problems.push(`main of the private repo moved (${privateBefore.slice(0, 7)} → ${privateNow.slice(0, 7)})`);
  const after = fingerprints(factory, privateRepo, mode, ws.lab);
  for (const [what, value] of Object.entries(ws.fingerprints)) {
    if (after[what] !== value) problems.push(`${what} changed during the run`);
  }
  type Comment = { user?: { login: string }; created_at: string; html_url: string };
  const comments = Object.values(factory.repos).flatMap((repo) =>
    ["issues/comments", "pulls/comments"].flatMap((kind) =>
      ghAll<Comment>(`repos/${repo.github}/${kind}?since=${from}&per_page=100`).map((c) => ({
        user: c.user?.login ?? "",
        created_at: c.created_at,
        url: c.html_url,
      })),
    ),
  );
  const ticketEvents = ghAll<IssueEvent>(`repos/${ticket.github}/issues/${ticket.number}/events?per_page=100`);
  // Submitted reviews (approve, request changes) leave no comment: read them from every PR touched since.
  // The pulls endpoint has no `since`, so page through it by hand and stop once a page is older than
  // the window, instead of reading (or silently capping at) the repo's whole pull-request history.
  type Pull = { number: number; updated_at: string };
  type Review = { user?: { login: string }; submitted_at?: string; html_url: string };
  const cutoffMs = Math.floor(Date.parse(from) / 1000) * 1000;
  const reviews = Object.values(factory.repos).flatMap((repo) =>
    pullsSince<Pull>(cutoffMs, (page) =>
      ghApiJson<Pull[]>(`repos/${repo.github}/pulls?state=all&sort=updated&direction=desc&per_page=50&page=${page}`),
    )
      .flatMap((pull) => ghAll<Review>(`repos/${repo.github}/pulls/${pull.number}/reviews?per_page=100`))
      .filter((r) => r.submitted_at)
      .map((r) => ({ user: r.user?.login ?? "", created_at: r.submitted_at ?? "", url: r.html_url })),
  );
  const owner = ticket.github.split("/")[0] ?? "";
  return [...problems, ...windowProblems({ comments, ticketEvents, reviews }, owner, from, to)];
}
