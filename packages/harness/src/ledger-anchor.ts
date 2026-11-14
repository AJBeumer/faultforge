/**
 * Anchors the private repository's history in this public one, so a squashed or rewritten private history
 * can't pass as append-only (AUD-M11). `ledger:check` reads each commit's diff to see that the answer key and
 * the audit log only ever grew; a history squashed or rebuilt from scratch has no old diffs left to read.
 *
 *   npm run ledger:anchor
 *
 * Appends one line to `docs/ledger-anchors.txt`: today's date (UTC) and the private repository's HEAD commit
 * id, `YYYY-MM-DD <40 hex>`. Nothing else: not a line count or a size, which would tell a reader how many
 * cases, held-out ones included, the answer key holds. When HEAD is already the last anchor it adds nothing.
 * It only reads the private repository. Commit the file in this repository afterwards, so the anchor is
 * public and dated by this repository's own history.
 *
 * `anchorProblems` is what `ledger:check` runs: each anchored commit must still be in the private
 * repository, be an ancestor of its HEAD, and hold, for both files, a version that is the start of today's
 * (line by line, so today's may only have added lines after it). A file the anchored commit doesn't hold is
 * the empty start of any file.
 *
 * Exit codes: 0 the anchor was recorded, or HEAD is already the last anchor; 2 the private repository's HEAD,
 * or the anchors file, could not be read or written. `npm run ledger:anchor` runs `ledger-anchor-cli.ts`, so
 * an unexpected error, even while loading, is 2 too.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { eachGitLine, LineReader, ownRepoRoot } from "./git-stream.ts";
import { ROOT } from "./paths.ts";
import { privateDir } from "./templates.ts";

/** The two append-only files in private storage. */
export const LEDGER_FILES = ["ground-truth.jsonl", "audit-events.jsonl"] as const;

/** Where the anchors live, in this (public) repository. */
export const ANCHORS_FILE = join(ROOT, "docs", "ledger-anchors.txt");

const ANCHOR_LINE = /^(\d{4}-\d{2}-\d{2}) ([0-9a-f]{40})$/;

export interface Anchor {
  date: string;
  commit: string;
}

/** The anchors in `path`, in file order, and a problem for each line that isn't one. A missing file is a problem. */
export function readAnchors(path: string): { anchors: Anchor[]; problems: string[] } {
  if (!existsSync(path)) return { anchors: [], problems: [`${path}: no anchors file`] };
  const anchors: Anchor[] = [];
  const problems: string[] = [];
  const lines = readFileSync(path, "utf8").replace(/\r/g, "").split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const [i, line] of lines.entries()) {
    const m = ANCHOR_LINE.exec(line);
    if (m) anchors.push({ date: m[1] as string, commit: m[2] as string });
    else problems.push(`${path}: line ${i + 1} is not "YYYY-MM-DD <commit id>"`);
  }
  return { anchors, problems };
}

function git(repoRoot: string, ...args: string[]) {
  return spawnSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
}

/**
 * Whether the file at `commit` is the start of the file today, line by line (line endings aside). Both are
 * read one line at a time, side by side, so neither is ever held whole (Qodo on PR 286).
 */
function isStartOfToday(privateRoot: string, commit: string, file: string): boolean {
  const path = join(privateRoot, file);
  const today = existsSync(path) ? new LineReader(path) : null;
  let same = true;
  try {
    eachGitLine(privateRoot, ["show", `${commit}:${file}`], (line) => {
      if (same && today?.next()?.replace(/\r$/, "") !== line.replace(/\r$/, "")) same = false;
    });
  } finally {
    today?.close();
  }
  return same;
}

/**
 * Problems with each anchored commit in `anchorsPath`, checked against the private repository at `privateRoot`.
 * Each anchor costs one read of both files as they were then; the anchors are few (one a day at most).
 */
export function anchorProblems(privateRoot: string, anchorsPath: string): string[] {
  const { anchors, problems } = readAnchors(anchorsPath);
  if (!anchors.length) return problems.length ? problems : [`${anchorsPath}: holds no anchor`];
  ownRepoRoot(privateRoot);
  for (const { date, commit } of anchors) {
    const label = `anchor ${commit.slice(0, 12)} (${date})`;
    if (git(privateRoot, "cat-file", "-e", `${commit}^{commit}`).status !== 0) {
      problems.push(
        `${label}: the private repository no longer holds that commit; was its history squashed or rewritten?`,
      );
      continue;
    }
    const ancestor = git(privateRoot, "merge-base", "--is-ancestor", commit, "HEAD");
    if (ancestor.status === 1) {
      problems.push(`${label}: is not an ancestor of the private HEAD; was its history squashed or rewritten?`);
      continue;
    }
    if (ancestor.status !== 0) throw new Error(`git merge-base failed for ${label}: ${ancestor.stderr.trim()}`);
    for (const file of LEDGER_FILES) {
      if (git(privateRoot, "cat-file", "-e", `${commit}:${file}`).status !== 0) continue;
      if (!isStartOfToday(privateRoot, commit, file)) {
        problems.push(`${label}: ${file} then is not the start of ${file} today; a line was removed or changed since`);
      }
    }
  }
  return problems;
}

/**
 * How many commits the private HEAD may run past the last anchor before `ledger:check` warns. Each case adds
 * a few commits (injection, PR, review, verdict, record), so this is about two cases left unanchored.
 */
export const ANCHOR_LAG_LIMIT = 10;

/**
 * A warning when the private HEAD is more than `limit` commits past the last anchor, or none. Only a warning:
 * an unanchored stretch is not yet a broken history, but anything in it could be rewritten unseen. An anchors
 * file that can't be read, or an anchor that isn't an ancestor of HEAD, is `anchorProblems`'s to report.
 */
export function anchorLagWarning(
  privateRoot: string,
  anchorsPath: string,
  limit = ANCHOR_LAG_LIMIT,
): string | undefined {
  if (!existsSync(anchorsPath)) return undefined;
  const last = readAnchors(anchorsPath).anchors.at(-1);
  if (!last) return undefined;
  const count = git(privateRoot, "rev-list", "--count", `${last.commit}..HEAD`);
  if (count.status !== 0) return undefined;
  const behind = Number(count.stdout.trim());
  if (!(behind > limit)) return undefined;
  return `the private HEAD is ${behind} commits past the last anchor (${last.date}), more than ${limit}: run \`npm run ledger:anchor\` and commit the anchor through a PR`;
}

/**
 * Appends today's anchor for the private repository's HEAD to `anchorsPath`, unless HEAD is already the last
 * anchor. Returns the commit and whether a line was added.
 */
export function recordAnchor(
  privateRoot: string,
  anchorsPath: string,
  now: Date = new Date(),
): { commit: string; added: boolean } {
  ownRepoRoot(privateRoot);
  const head = git(privateRoot, "rev-parse", "--verify", "HEAD");
  if (head.status !== 0) throw new Error(`the private repository has no HEAD commit: ${head.stderr.trim()}`);
  const commit = head.stdout.trim();
  const existing = existsSync(anchorsPath) ? readAnchors(anchorsPath) : { anchors: [], problems: [] };
  if (existing.problems.length) throw new Error(existing.problems.join("; "));
  if (existing.anchors.at(-1)?.commit === commit) return { commit, added: false };
  // A file whose last line has no line break gets one first, so two anchors never run together (Qodo on PR 286).
  const text = existsSync(anchorsPath) ? readFileSync(anchorsPath, "utf8") : "";
  const separator = text && !text.endsWith("\n") ? "\n" : "";
  appendFileSync(anchorsPath, `${separator}${now.toISOString().slice(0, 10)} ${commit}\n`);
  return { commit, added: true };
}

/** The command: `ledger-anchor-cli.ts` runs it, so an unexpected error, even while loading, is exit 2. */
export function main(): number {
  try {
    const { commit, added } = recordAnchor(privateDir(), ANCHORS_FILE);
    console.log(
      added
        ? `[ledger:anchor] anchored ${commit} in docs/ledger-anchors.txt; commit that file`
        : `[ledger:anchor] ${commit} is already the last anchor; nothing added`,
    );
    return 0;
  } catch (error) {
    console.error(`[ledger:anchor] could not anchor: ${(error as Error).message}`);
    return 2;
  }
}
