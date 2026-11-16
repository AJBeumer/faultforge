/**
 * The factory runner's own writes on a ticket: its comments and its label moves (#345). A ticket in a reviewed repo
 * gets them through the door (`target-post.ts`), which checks the exact text and label names it sends, the same way
 * as every other write there. Only a ticket of any other repo, the lab's own, gets them with `gh` straight away.
 *
 * Which repo is reviewed comes from two lists, either one enough: the guard's (`reviewedRepos`, which always holds
 * the target, whatever `factory.json` says) and the caller's (the factory config's repos marked reviewed). So a
 * config that forgot to mark a repo can't send raw text to the target.
 */
import { reviewedRepos } from "../../../.claude/hooks/shared/repos.ts";
import { ExternalCallError, gh as labGh } from "./github.ts";
import { type Gh, type Post, SendFailed, sendPost } from "./target-post.ts";

export interface TicketWriter {
  /** Posts `body` as a comment on the ticket. Throws when it wasn't sent, or the door refused it. */
  comment(github: string, number: number, body: string): void;
  /** Adds every label in one edit. */
  addLabels(github: string, number: number, labels: string[]): void;
  /** Removes one label. A failed call throws an `ExternalCallError`, so a label already gone can be told apart. */
  removeLabel(github: string, number: number, label: string): void;
}

export interface TicketWriteDeps {
  /** gh for a lab ticket, with github.ts's time limit and error shape. */
  gh?: (...args: string[]) => string;
  /** gh for the door; by default the door's own. */
  door?: Gh;
  /** The reviewed repos as the guard reads them; by default from factory.json. */
  guardReviewed?: string[];
  /**
   * The run's runner key while a factory run is marked active (`target-post-run.ts`, #347): the door then takes a
   * comment or label move only with it. Read at each write, since the run is marked after the writer is made.
   */
  runnerKey?: () => string | undefined;
  /** The run marker to read instead of the fixed one: for tests. */
  runMarker?: string;
}

/** A writer for tickets, routing a reviewed repo's writes through the door. `reviewed` adds the config's own list. */
export function ticketWriter(reviewed: string[], deps: TicketWriteDeps = {}): TicketWriter {
  const guarded = deps.guardReviewed ?? reviewedRepos(process.env.FAULTFORGE_CONFIG).map((r) => r.github);
  const isReviewed = (github: string) =>
    [...guarded, ...reviewed].some((repo) => repo.toLowerCase() === github.toLowerCase());
  const gh = deps.gh ?? labGh;
  /** Sends through the door; a failed send becomes the same error a lab ticket's gh call would throw. */
  const door = (post: Post, label: string) => {
    try {
      sendPost(post, {
        ...(deps.door ? { gh: deps.door } : {}),
        ...(deps.runMarker ? { runMarker: deps.runMarker } : {}),
        runnerKey: deps.runnerKey?.(),
      });
    } catch (error) {
      if (error instanceof SendFailed) throw new ExternalCallError(label, error.cause ?? error);
      throw error;
    }
  };
  return {
    comment(github, number, body) {
      if (isReviewed(github)) door({ kind: "issue-comment", repo: github, number, body }, "gh issue");
      else gh("issue", "comment", String(number), "--repo", github, "--body", body);
    },
    addLabels(github, number, labels) {
      if (isReviewed(github)) door({ kind: "label", repo: github, number, add: labels }, "gh issue");
      else gh("issue", "edit", String(number), "--repo", github, ...labels.flatMap((l) => ["--add-label", l]));
    },
    removeLabel(github, number, label) {
      if (isReviewed(github)) door({ kind: "label", repo: github, number, remove: [label] }, "gh api");
      else gh("api", "-X", "DELETE", `repos/${github}/issues/${number}/labels/${encodeURIComponent(label)}`);
    },
  };
}
