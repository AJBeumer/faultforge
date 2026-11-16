/**
 * After the agent stops, the runner compares the files that decide whether the check passes between the commit
 * the run started from and the head of the pull request it delivered (#341). The policy hook reads command text,
 * and the agent can build a command at run time that no text rule can read; a weakened check (a changed Vitest,
 * Biome or TypeScript config, a `package.json` script, the check workflow, or the check's own scripts) would then
 * still look green. Looking at the result, whatever made it, catches that.
 *
 * Which files count is per repo in `factory.json` (`checkFiles`): `files` is a regular expression for files
 * compared whole, `scripts` one for `package.json` files compared by their `scripts` field only, so a
 * dependency change still passes. Both are matched against repo-relative paths, ignoring case.
 *
 * The comparison runs on the runner's side, in a fresh git repository with no inherited config, holding only the
 * two commits fetched from GitHub: the run's base (`main` when it started) and `refs/pull/<n>/head`. Never the
 * agent's worktree, whose index, `.git` and config it could have changed.
 *
 * Outcomes, as the run log's `check-files` event gives them:
 * - `unchanged`: no check-defining file changed. The run goes on.
 * - `allowed`: some changed, and the repo owner put the `touches-check` label on the ticket before the agent
 *   started. Recorded with the label's author and time; the run goes on.
 * - `check-weakened`: some changed without that label. The run fails (`agent-needs-help`) with the paths.
 * - `unread`: the runner couldn't compare them (a fetch failed, no base commit, no `checkFiles` setting). The run
 *   fails too: not knowing is never read as "nothing changed".
 */
import { mkdirSync } from "node:fs";
import type { RepoConfig } from "../shared/factory-config.ts";
import { CALL_TIMEOUT_MS } from "../shared/github.ts";
import { LONG_CALL_TIMEOUT_MS } from "./factory-exec.ts";
import type { IssueEvent } from "./factory-settle.ts";
import type { Logger, TickDeps, Workspace } from "./factory-tick-deps.ts";
import { gitIsolated, removeTrustedCheckout } from "./trusted-checkout.ts";

/** The label the owner sets on a ticket that is meant to change a check-defining file. */
export const TOUCHES_CHECK = "touches-check";

export type CheckFilesConfig = NonNullable<RepoConfig["checkFiles"]>;

/** What the runner read: the two commits and the check-defining paths that differ, or why it couldn't. */
export type CheckFilesReading = { base: string; head: string; changed: string[] } | { error: string };

/** The `scripts` field of a `package.json` text, in a form that compares equal for the same scripts in any
 * key order. A file that is missing or doesn't parse gets a marker of its own, so it never equals a real one. */
export function scriptsOf(text: string | null): string {
  if (text === null) return "(no file)";
  try {
    const scripts = (JSON.parse(text) as { scripts?: unknown } | null)?.scripts;
    if (scripts === undefined) return "(no scripts)";
    if (scripts === null || typeof scripts !== "object" || Array.isArray(scripts)) return JSON.stringify(scripts);
    const entries = Object.entries(scripts as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return JSON.stringify(entries);
  } catch {
    return "(not JSON)";
  }
}

/**
 * The check-defining paths among `differing` (every path that differs between the two commits, added and
 * removed ones included). A `scripts` path counts only when its `scripts` field differs; `read` gives a file's
 * text at a commit, or null when it isn't there.
 */
export function changedCheckFiles(
  config: CheckFilesConfig,
  differing: string[],
  read: (side: "base" | "head", path: string) => string | null,
): string[] {
  const whole = new RegExp(config.files, "i");
  const scripts = new RegExp(config.scripts, "i");
  const changed: string[] = [];
  for (const path of [...new Set(differing)].sort()) {
    if (scripts.test(path)) {
      if (scriptsOf(read("base", path)) !== scriptsOf(read("head", path))) changed.push(path);
    } else if (whole.test(path)) changed.push(path);
  }
  return changed;
}

/**
 * Who put `touches-check` on the ticket, and when, if it is on now, the repo owner added it, and that was before
 * the agent started (`before`). The agent works as the owner's login, so a label added during the run could be
 * its own; the audit flags that change too. Null otherwise.
 */
export function touchesCheckLabel(
  events: IssueEvent[],
  owner: string,
  before: string,
): { by: string; at: string } | null {
  const last = events
    .filter((e) => (e.event === "labeled" || e.event === "unlabeled") && e.label?.name === TOUCHES_CHECK)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .pop();
  if (!last || last.event !== "labeled") return null;
  const by = last.actor?.login ?? "";
  if (by.toLowerCase() !== owner.toLowerCase()) return null;
  if (!(Date.parse(last.created_at) < Date.parse(before))) return null;
  return { by, at: last.created_at };
}

export type CheckFilesOutcome = "unchanged" | "allowed" | "check-weakened" | "unread";

/** A path as it may appear in a ticket comment: plain path characters only, in a code span. */
const shown = (path: string) => `\`${path.replace(/[^\w./-]/g, "?")}\``;

/** The outcome, the run log's `check-files` event, and the problems that fail the run (none when it goes on). */
export function checkFilesVerdict(
  reading: CheckFilesReading,
  label: { by: string; at: string } | null,
): { outcome: CheckFilesOutcome; event: Record<string, unknown>; problems: string[] } {
  if ("error" in reading) {
    return {
      outcome: "unread",
      event: { outcome: "unread", error: reading.error },
      problems: [`the runner couldn't compare the files that decide the check (${reading.error})`],
    };
  }
  const { base, head, changed } = reading;
  if (!changed.length) return { outcome: "unchanged", event: { outcome: "unchanged", base, head }, problems: [] };
  if (label) {
    return {
      outcome: "allowed",
      event: { outcome: "allowed", base, head, changed, label: TOUCHES_CHECK, ...label },
      problems: [],
    };
  }
  return {
    outcome: "check-weakened",
    event: { outcome: "check-weakened", base, head, changed },
    problems: [
      `check-weakened: it changes the files that decide the check (${changed.map(shown).join(", ")}) and the ticket has no \`${TOUCHES_CHECK}\` label from the owner`,
    ],
  };
}

/**
 * The step itself, as `checkRun` (`factory-tick-run.ts`) takes it before a PR can count as delivered: reads the
 * changes, reads the ticket's label from its events when anything changed, logs `check-files`, and returns the
 * problems that fail the run. Events that can't be read count as no label.
 */
export function checkFilesProblems(
  deps: Pick<TickDeps, "checkFiles" | "events">,
  ws: Workspace,
  ticket: { repoKey: string; github: string; number: number },
  pr: number,
  head: string | undefined,
  owner: string,
  agentStarted: string,
  log: Logger,
): string[] {
  let reading: CheckFilesReading;
  try {
    reading = deps.checkFiles(ws, ticket.repoKey, pr, head);
  } catch (error) {
    reading = { error: error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error) };
  }
  let label: { by: string; at: string } | null = null;
  if (!("error" in reading) && reading.changed.length) {
    try {
      label = touchesCheckLabel(deps.events(ticket.github, ticket.number), owner, agentStarted);
    } catch (error) {
      log("error", { message: `couldn't read the ticket's labels: ${error instanceof Error ? error.message : error}` });
    }
  }
  const verdict = checkFilesVerdict(reading, label);
  log("check-files", { pr, ...verdict.event });
  return verdict.problems;
}

const COMMIT = /^[0-9a-f]{40}$/i;
const NO_OBJECT = /^0+$/;

/**
 * Each differing path's object id on each side, from `git diff --raw --no-abbrev -z`: records of
 * `:<mode> <mode> <id> <id> <status>` and the path, each ending in NUL. An all-zero id means the file isn't on
 * that side (added or removed). Throws on output it can't read, so the caller fails closed.
 */
export function rawDiff(output: string): Map<string, { base: string | null; head: string | null }> {
  const parts = output.split("\0");
  const blobs = new Map<string, { base: string | null; head: string | null }>();
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const fields = (parts[i] ?? "").replace(/^\s*:/, "").split(" ");
    const path = parts[i + 1] ?? "";
    const [base, head] = [fields[2] ?? "", fields[3] ?? ""];
    if (fields.length < 5 || !path || !/^[0-9a-f]+$/i.test(base) || !/^[0-9a-f]+$/i.test(head)) {
      throw new Error(`couldn't read git's list of changed files near "${parts[i]}"`);
    }
    blobs.set(path, { base: NO_OBJECT.test(base) ? null : base, head: NO_OBJECT.test(head) ? null : head });
  }
  // Whole records leave one empty string after the last NUL; anything else is a record cut off.
  if (parts.length % 2 !== 1 || parts.at(-1) !== "") throw new Error("git's list of changed files ended early");
  return blobs;
}

/**
 * Reads the check-defining changes of pull request `pr` against `base`, in a new repository at `dir` fetched
 * from `remoteUrl`, and removes `dir` again. `verified` is the commit the runner verified (the agent's last
 * push); without one, the PR's ref as GitHub shows it now. Never throws: a failure is the reading's `error`.
 */
export function readCheckFiles(
  config: CheckFilesConfig | undefined,
  remoteUrl: string,
  base: string | undefined,
  pr: number,
  verified: string | undefined,
  dir: string,
): CheckFilesReading {
  if (!config) return { error: "factory.json has no checkFiles setting for this repo" };
  if (!base || !COMMIT.test(base)) return { error: "no commit id for main when the run started" };
  if (verified !== undefined && !COMMIT.test(verified)) return { error: "the verified head isn't a commit id" };
  try {
    mkdirSync(dir, { recursive: true });
    const git = (args: string[], timeout = CALL_TIMEOUT_MS) => gitIsolated(dir, dir, args, timeout);
    git(["init", "-q"]);
    git(["fetch", "-q", "--no-tags", "--depth=1", remoteUrl, verified ?? `refs/pull/${pr}/head`], LONG_CALL_TIMEOUT_MS);
    const head = git(["rev-parse", "--verify", "FETCH_HEAD^{commit}"]);
    git(["fetch", "-q", "--no-tags", "--depth=1", remoteUrl, base], LONG_CALL_TIMEOUT_MS);
    git(["cat-file", "-e", `${base}^{commit}`]);
    const blobs = rawDiff(git(["diff", "--raw", "--no-abbrev", "--no-renames", "-z", base, head]));
    // A side's object id is null only where git says the file isn't there. Any failure to read a blob that is
    // there (one too big for the output buffer, say) throws, so the reading is `unread`, never "unchanged".
    const read = (side: "base" | "head", path: string): string | null => {
      const id = blobs.get(path)?.[side];
      return id ? git(["cat-file", "blob", id]) : null;
    };
    return { base, head, changed: changedCheckFiles(config, [...blobs.keys()], read) };
  } catch (error) {
    return { error: error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error) };
  } finally {
    removeTrustedCheckout(dir);
  }
}
