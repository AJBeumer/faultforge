/**
 * The ticket as the agent will read it, taken from every page GitHub gives, and who wrote, edited, renamed
 * and commented on it: only the owner's text may become the agent's instructions. Split from
 * factory-tick.ts (#227).
 */
import { isRunnerComment } from "./factory-comments.ts";
import { gh } from "./github.ts";

export interface Provenance {
  author: string;
  /** Everyone who edited the ticket's body. */
  editors: string[];
  /** Everyone who commented on it. */
  commenters: string[];
  /** Everyone who edited one of its comments: a comment's text is theirs too. */
  commentEditors?: string[];
  /** Parts that couldn't be read completely, such as a comment with more edits than one page. */
  incomplete?: string[];
  /** Everyone who changed the title. */
  renamers?: string[];
}

/**
 * Why a ticket's text can't be trusted as the agent's instructions, or an empty list. The label shows
 * the owner chose the ticket, not who wrote what the agent will read.
 */
export function provenanceProblems(p: Provenance, owner: string): string[] {
  const others = (logins: string[]) => [...new Set(logins.filter((l) => l.toLowerCase() !== owner.toLowerCase()))];
  const problems: string[] = [];
  if (others([p.author]).length) problems.push(`written by ${p.author}`);
  if (others(p.editors).length) problems.push(`edited by ${others(p.editors).join(", ")}`);
  // The title reaches the agent's instructions too, and a rename isn't a body edit (#215).
  if (others(p.renamers ?? []).length) problems.push(`renamed by ${others(p.renamers ?? []).join(", ")}`);
  if (others(p.commenters).length) problems.push(`commented on by ${others(p.commenters).join(", ")}`);
  const commentEditors = others(p.commentEditors ?? []);
  if (commentEditors.length) problems.push(`a comment edited by ${commentEditors.join(", ")}`);
  if (p.incomplete?.length) problems.push(`not fully readable: ${p.incomplete.join(", ")}`);
  return problems;
}

/** The ticket as the agent will read it, and who wrote each part. */
export interface TicketSnapshot {
  /** Title, body and every comment, as one Markdown text. */
  text: string;
  provenance: Provenance;
  /** Who edited the body and how many edits each comment has: an edit undone later still shows here. */
  history?: string;
}

/**
 * Why the ticket can't be trusted after the run: anything changed since the snapshot the agent worked
 * from, or someone else's text is now on it. Empty when it is exactly as it was.
 */
export function ticketChangeProblems(before: TicketSnapshot, after: TicketSnapshot, owner: string): string[] {
  const problems = provenanceProblems(after.provenance, owner).map((p) => `the ticket is now ${p}`);
  if (after.text !== before.text) problems.push("the ticket's text changed during the run");
  else if ((after.history ?? "") !== (before.history ?? "")) {
    problems.push("the ticket was edited during the run, even though its text is back as it was");
  }
  return problems;
}

type Who = { login?: string } | null;
type Page<T> = { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: T[] };
type SnapshotComment = {
  author: Who;
  body: string;
  createdAt: string;
  userContentEdits: { totalCount: number; nodes: { editor: Who }[] };
};
/** One GraphQL answer for the issue: its title, body and author, plus the one paged field asked for. */
export type IssuePage = { title: string; body: string | null; author: Who; [field: string]: unknown };
/** Fetches one page of `field` (`userContentEdits` or `comments`) after `cursor`, or the first page. */
export type SnapshotField = "userContentEdits" | "comments" | "timelineItems";
export type FetchIssuePage = (field: SnapshotField, cursor: string | null) => IssuePage;

/** Every node of a paged field, following GitHub's cursors until it says there is no next page. */
export function allPages<T>(field: SnapshotField, fetch: FetchIssuePage): { issue: IssuePage; nodes: T[] } {
  const nodes: T[] = [];
  let cursor: string | null = null;
  let issue: IssuePage;
  const seen = new Set<string>();
  do {
    issue = fetch(field, cursor);
    const page = issue[field] as Page<T>;
    nodes.push(...page.nodes);
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    // A cursor that doesn't move would loop for ever: treat it as an error, never as the end.
    if (cursor !== null) {
      if (seen.has(cursor)) throw new Error(`GitHub repeated the ${field} cursor ${cursor}`);
      seen.add(cursor);
    }
  } while (cursor !== null);
  return { issue, nodes };
}

/**
 * The ticket's snapshot from GitHub's pages: the text the agent will read, who wrote and edited each
 * part, and its edit history. The history catches an edit that was later undone, which leaves the
 * text and the authors unchanged.
 */
export function buildSnapshot(fetch: FetchIssuePage): TicketSnapshot {
  const login = (who: Who) => who?.login ?? "(deleted user)";
  const edits = allPages<{ editor: Who }>("userContentEdits", fetch);
  const comments = allPages<SnapshotComment>("comments", fetch).nodes;
  const renamers = allPages<{ actor?: Who }>("timelineItems", fetch).nodes.map((n) => login(n.actor ?? null));
  const { issue } = edits;
  // The runner's own comments are left out of the text: it posts as the owner, and a stop comment can quote
  // an earlier agent's reason or a review finding's title, which must never come back as the owner's
  // instructions on a retry (AUD-M21). They still count for who commented, and for the history.
  const text = [
    `# ${issue.title}`,
    "",
    issue.body ?? "",
    ...comments
      .filter((c) => !isRunnerComment(c.body))
      .flatMap((c) => ["", "---", `Comment by ${login(c.author)}, ${c.createdAt}:`, "", c.body]),
  ].join("\n");
  const history = JSON.stringify({
    body: edits.nodes.map((n) => login(n.editor)),
    comments: comments.map((c) => ({ at: c.createdAt, edits: c.userContentEdits.totalCount })),
    renames: renamers.length,
  });
  return {
    text,
    history,
    provenance: {
      author: login(issue.author),
      editors: edits.nodes.map((n) => login(n.editor)),
      commenters: comments.map((c) => login(c.author)),
      commentEditors: comments.flatMap((c) => c.userContentEdits.nodes.map((n) => login(n.editor))),
      incomplete: comments
        .filter((c) => c.userContentEdits.totalCount > c.userContentEdits.nodes.length)
        .map((c) => `the edits of a comment from ${c.createdAt}`),
      renamers,
    },
  };
}

/** The ticket's snapshot, read live from GitHub's GraphQL API, every page of it. */
export function ghSnapshot(github: string, number: number): TicketSnapshot {
  const [owner, name] = github.split("/");
  const pageInfo = "pageInfo { hasNextPage endCursor }";
  const parts = {
    userContentEdits: `userContentEdits(first: 100, after: $after) { ${pageInfo} nodes { editor { login } } }`,
    comments: `comments(first: 100, after: $after) { ${pageInfo} nodes { author { login } body createdAt userContentEdits(first: 100) { totalCount nodes { editor { login } } } } }`,
    timelineItems: `timelineItems(itemTypes: [RENAMED_TITLE_EVENT], first: 100, after: $after) { ${pageInfo} nodes { ... on RenamedTitleEvent { actor { login } } } }`,
  };
  return buildSnapshot((field, cursor) => {
    const query = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
          repository(owner: $owner, name: $name) { issue(number: $number) { title body author { login } ${parts[field]} } } }`;
    const args = ["api", "graphql", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `name=${name}`];
    args.push("-F", `number=${number}`, ...(cursor ? ["-f", `after=${cursor}`] : []));
    return JSON.parse(gh(...args)).data.repository.issue;
  });
}
