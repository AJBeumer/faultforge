/**
 * Checks that the answer key and the audit log are still append-only, and that every amendment in
 * them is sound.
 *
 *   npm run ledger:check
 *
 * Runs `ledgerProblems` (see `ledger.ts`) on both files, then asks the private repo's git history,
 * including merge commits, and its uncommitted state, whether any commit (or anything not yet
 * committed) removed or changed a line of either file: every commit may only add lines. That history can
 * itself be squashed or rewritten, so it then checks each commit `npm run ledger:anchor` recorded in this
 * repo's `docs/ledger-anchors.txt` (`ledger-anchor.ts`): each must still be an ancestor of the private HEAD,
 * and both files at it must be the start of today's. Last, it recomputes the `inputHash` of every
 * tool-written injection and verdict event (`ledger-hashes.ts`): a template, proof or saved review changed
 * after its event is reported.
 *
 * It only reads: git's output is streamed through a private temporary folder outside the repository
 * (`git-stream.ts`), so the private repository is left exactly as it was.
 *
 * Exit codes: 0 both files are sound; 1 problems found, listed on stdout; 2 a file or the private
 * repo's git history could not be read.
 *
 * An unexpected error, even while loading, is 2 too: `npm run ledger:check` runs `ledger-check-cli.ts`.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { eachGitLine, ownRepoRoot } from "./git-stream.ts";
import { ledgerProblems, ledgerProblemsIn, readAuditLog } from "./ledger.ts";
import { ANCHORS_FILE, anchorProblems, LEDGER_FILES as FILES } from "./ledger-anchor.ts";
import { readEventProblems } from "./ledger-append.ts";
import { hashProblems } from "./ledger-hashes.ts";
import { savedReviewsDir } from "./saved-review.ts";
import { privateDir } from "./templates.ts";

const DIFF_HEADER = /^(diff --git|index |--- |\+\+\+ )/;

/**
 * How a unified diff breaks "only appended", read one line at a time so a diff of any size is never held
 * (AUD-N6): `removed` when a hunk removes or changes a line, `inserted` when an added line is followed by an
 * old one, in its hunk or a later hunk of the same file, so it went in before the end (AUD-M10). Header lines
 * carry no content. One removal is not a change: a last line that had no line break ("\ No newline at end of
 * file") shown as removed and added back unchanged, which is how git shows lines appended after it (Qodo on
 * PR 286). Any other removal is, as is that one when the line comes back different, or doesn't.
 */
export class AppendOnlyScanner {
  private inHunk = false;
  private added = false;
  private inserted = false;
  private removed = false;
  /** A removed line not yet judged: it may be a last line without a line break, about to come back. */
  private pending: string | null = null;
  private pendingHadNoBreak = false;

  /** A pending removal that didn't come back unchanged is a removal. */
  private settlePending(): void {
    if (this.pending !== null) this.removed = true;
    this.pending = null;
  }

  line(line: string): void {
    if (this.removed) return;
    if (line.startsWith("diff --git")) {
      this.settlePending();
      this.inHunk = false;
      this.added = false;
      return;
    }
    if (line.startsWith("@@")) {
      this.settlePending();
      if (this.added) this.inserted = true;
      this.inHunk = true;
      return;
    }
    if (DIFF_HEADER.test(line) || !this.inHunk) return;
    if (line.startsWith("\\")) {
      if (this.pending !== null) this.pendingHadNoBreak = true;
      return;
    }
    if (line.startsWith("-")) {
      this.settlePending();
      this.pending = line.slice(1);
      this.pendingHadNoBreak = false;
    } else if (line.startsWith("+")) {
      if (this.pending !== null && this.pendingHadNoBreak && line.slice(1) === this.pending) this.pending = null;
      else if (this.pending !== null) this.settlePending();
      else this.added = true;
    } else if (line.startsWith(" ")) {
      this.settlePending();
      if (this.added) this.inserted = true;
    }
  }

  result(): "removed" | "inserted" | undefined {
    this.settlePending();
    return this.removed ? "removed" : this.inserted ? "inserted" : undefined;
  }
}

/** `AppendOnlyScanner` over a whole diff held as text. */
export function appendOnlyBreak(diffText: string): "removed" | "inserted" | undefined {
  const scanner = new AppendOnlyScanner();
  for (const line of diffText.split("\n")) scanner.line(line);
  return scanner.result();
}

const BREAK_WORDS = { removed: "removed or changed a line", inserted: "inserted a line before the end" };

/**
 * Problems from a file's git history and working tree: one entry per commit (including a merge's own
 * resolution, via `-m`) whose diff for `relPath` removed or changed a line, or added one before the end,
 * instead of only appending, plus one entry if the working tree or index holds such a change uncommitted.
 * `--follow` so a rename doesn't hide older history.
 */
export function appendOnlyProblems(repoRoot: string, relPath: string): string[] {
  ownRepoRoot(repoRoot);
  const problems: string[] = [];

  let headExists: boolean;
  try {
    execFileSync("git", ["-C", repoRoot, "rev-parse", "--verify", "--quiet", "HEAD"], { encoding: "utf8" });
    headExists = true;
  } catch {
    headExists = false; // no commit yet, so no committed history to have broken the rule
  }

  if (headExists) {
    // `-m` shows a merge once per parent, one right after another. A merge of two branches that each appended
    // puts one side's lines before the other's against one parent, but is a plain append against the other:
    // two appends meeting, not an insertion. So a commit is an insertion only when it inserts against every
    // parent it is shown against; a removal against any parent is always a problem (Qodo on PR 269).
    // Read as a stream, one line at a time, and judged as each commit ends: neither the history nor one
    // commit's diff is ever held, so there is no size or time ceiling to outgrow (AUD-N6, Qodo on PR 280).
    let sha: string | null = null;
    let breaks: ("removed" | "inserted" | undefined)[] = [];
    let scanner: AppendOnlyScanner | null = null;
    const endDiff = () => {
      if (scanner) breaks.push(scanner.result());
      scanner = null;
    };
    const endCommit = () => {
      endDiff();
      if (sha === null) return;
      const broken = breaks.includes("removed")
        ? "removed"
        : breaks.length > 0 && breaks.every((b) => b === "inserted")
          ? "inserted"
          : undefined;
      if (broken) problems.push(`${relPath}: commit ${sha} ${BREAK_WORDS[broken]}`);
      breaks = [];
    };
    try {
      eachGitLine(repoRoot, ["log", "--no-color", "--follow", "-p", "-m", "--", relPath], (line) => {
        if (line.startsWith("commit ")) {
          const next = (line.match(/^commit ([0-9a-f]+)/)?.[1] ?? "unknown").slice(0, 12);
          if (next !== sha) endCommit();
          else endDiff();
          sha = next;
          scanner = new AppendOnlyScanner();
        }
        scanner?.line(line);
      });
    } catch (error) {
      throw new Error(`git log failed for ${relPath}: ${(error as Error).message}`);
    }
    endCommit();

    const uncommitted = new AppendOnlyScanner();
    try {
      eachGitLine(repoRoot, ["diff", "--no-color", "HEAD", "--", relPath], (line) => uncommitted.line(line));
    } catch (error) {
      throw new Error(`git diff failed for ${relPath}: ${(error as Error).message}`);
    }
    const broken = uncommitted.result();
    if (broken) problems.push(`${relPath}: uncommitted changes ${BREAK_WORDS[broken]}`);
  }

  return problems;
}

/**
 * Problems with the anchors file itself, in the public repository that holds it: it must be committed there,
 * and its history and working copy may only add lines. An anchor replaced by a line naming a rewritten
 * private HEAD would otherwise pass every other check (Qodo on PR 286).
 */
export function anchorsFileProblems(anchorsPath: string): string[] {
  if (!existsSync(anchorsPath)) return []; // `anchorProblems` reports a missing file.
  const folder = dirname(resolve(anchorsPath));
  const top = spawnSync("git", ["-C", folder, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (top.status !== 0) return [`${anchorsPath}: not in a git repository, so its history can't be checked`];
  const repoRoot = top.stdout.trim();
  const relPath = relative(realpathSync.native(repoRoot), realpathSync.native(resolve(anchorsPath)))
    .split(sep)
    .join("/");
  // In HEAD itself: a file only staged would have no history, and every line of it would read as added (Qodo on PR 286).
  const committed = spawnSync("git", ["-C", repoRoot, "cat-file", "-e", `HEAD:${relPath}`], { encoding: "utf8" });
  if (committed.status !== 0) return [`${relPath}: not committed, so an anchor in it could be changed unseen`];
  return appendOnlyProblems(repoRoot, relPath);
}

/**
 * Every problem with the private ledger: unsound amendments, any non-append-only history, any anchored
 * commit that today's history no longer holds or no longer extends, or an anchors file that was changed
 * other than by adding lines (`anchorsPath`, AUD-M11), and any tool's `inputHash` that no longer recomputes
 * from today's template, proofs or saved review (AUD-M26).
 */
export function ledgerCheckProblems(privateRoot: string, anchorsPath?: string): string[] {
  const problems: string[] = [];
  for (const file of FILES) {
    problems.push(...ledgerProblems(join(privateRoot, file)));
    problems.push(...appendOnlyProblems(privateRoot, file));
  }
  if (anchorsPath !== undefined)
    problems.push(...anchorsFileProblems(anchorsPath), ...anchorProblems(privateRoot, anchorsPath));
  // Every event readable as an event: the lenient check every shape on disk passes (AUD-M5).
  const auditPath = join(privateRoot, FILES[1] as string);
  if (existsSync(auditPath)) {
    for (const event of readAuditLog(auditPath)) {
      const problem = readEventProblems(event);
      if (problem) problems.push(`${FILES[1]}: ${problem}`);
    }
  }
  const env = { ...process.env, FAULTFORGE_PRIVATE_DIR: privateRoot };
  problems.push(
    ...hashProblems(
      {
        groundTruthPath: join(privateRoot, FILES[0] as string),
        auditEventsPath: join(privateRoot, FILES[1] as string),
        reviewsDir: savedReviewsDir(env),
      },
      env,
    ),
  );
  return problems;
}

/**
 * What `verdict`, `case:review`, `case:build` and `inject` check before they read or write the files: unsound
 * amendments, and for a file at the root of its own git repository (the private repository holds both there),
 * any commit or uncommitted change that removed or changed a line (#224). A file elsewhere, such as a test's
 * scratch copy, has no history of its own to check. Never throws: what it can't check is a problem too.
 */
export function ledgerProblemsWithHistory(paths: string[]): string[] {
  let problems: string[];
  try {
    problems = ledgerProblemsIn(paths);
  } catch (e) {
    return [`the files can't be read: ${e instanceof Error ? e.message : String(e)}`];
  }
  for (const path of paths.filter((p) => existsSync(p))) {
    const root = dirname(resolve(path));
    // Only "not a git repository" means there is no history to check. Anything else (git missing or failing,
    // a folder inside another repository instead of at its own root) is a problem, never a silent skip, as
    // `npm run ledger:check` would refuse it too (Qodo on PR 232).
    const probe = spawnSync("git", ["-C", root, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
    if (probe.status !== 0 && /not a git repository/i.test(probe.stderr ?? "")) continue;
    try {
      problems.push(...appendOnlyProblems(root, basename(path)).map((p) => `${path}: ${p}`));
    } catch (e) {
      problems.push(`${path}: its history can't be checked: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return problems;
}

/** The command: `ledger-check-cli.ts` runs it, so an unexpected error, even while loading, is exit 2. */
export function main(): number {
  const root = privateDir();
  let problems: string[];
  try {
    problems = ledgerCheckProblems(root, ANCHORS_FILE);
  } catch (error) {
    console.error(`[ledger:check] could not read a file or the private repo's history: ${(error as Error).message}`);
    return 2;
  }
  if (problems.length) {
    console.log(`[ledger:check] problems found:\n${problems.map((p) => `- ${p}`).join("\n")}`);
    return 1;
  }
  console.log("[ledger:check] both files are sound: amendments check out, history is append-only");
  return 0;
}
