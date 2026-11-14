/**
 * Keeps the logs of a CI factory run that never saved them itself: a job cancelled or timed out mid-run, or
 * a tick that crashed before its last copy. The workflow runs it in an `if: always()` step after the tick
 * (AUD-M19), so the transcript, the record a stopped run needs most, is no longer lost with the VM.
 *
 *   npm run factory:keep -- --branch unsaved-<Actions run id>
 *
 * A run counts as saved when its live log has a `saved` event after its last other event (`cleanup` and
 * `kept` aside): the tick logs `saved` only after the push of its final copy. Each run that isn't saved has
 * its event log and transcript committed, from a fresh worktree of the private repo's `main`, to a branch of
 * their own, never to `main`. The transcript goes to the private repo only: the workflow's public artifact
 * still holds the event log alone. Only counts and the branch are printed, never a path or file name.
 *
 * Exit codes: 0 nothing needed keeping, or every unsaved run was pushed to the branch; 1 there were unsaved
 * runs and the push failed (their logs are still in the runs folder); 2 it couldn't run (a bad command line,
 * no private checkout).
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadFactory } from "./factory-config.ts";
import { git, gitLong } from "./factory-exec.ts";
import { evidenceDir, ROOT, runsDir } from "./paths.ts";

/** Events logged after the final copy is pushed: they say nothing about whether the run was saved. */
const AFTER_SAVE = new Set(["saved", "cleanup", "kept"]);

/** True when the log's `saved` event comes after every other event that matters. */
export function wasSaved(log: string): boolean {
  const events = log
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return String(JSON.parse(line).event ?? "");
      } catch {
        return "(unreadable)";
      }
    });
  const lastSaved = events.lastIndexOf("saved");
  if (lastSaved < 0) return false;
  return events.slice(lastSaved + 1).every((event) => AFTER_SAVE.has(event));
}

/** The files to keep from the runs folder: each unsaved run's event log and, when there is one, its transcript. */
export function unsavedFiles(names: string[], read: (name: string) => string): string[] {
  const logs = names.filter((n) => n.endsWith(".jsonl") && !n.endsWith(".agent.jsonl"));
  return logs
    .filter((name) => !wasSaved(read(name)))
    .flatMap((name) => {
      const transcript = name.replace(/\.jsonl$/, ".agent.jsonl");
      return names.includes(transcript) ? [name, transcript] : [name];
    });
}

function main() {
  let branch: string;
  try {
    const { values } = parseArgs({ args: process.argv.slice(2), options: { branch: { type: "string" } } });
    if (!values.branch || !/^[\w.-]+$/.test(values.branch)) throw new Error("--branch <name> is required");
    branch = values.branch;
  } catch (error) {
    console.error(`usage: npm run factory:keep -- --branch <name>   (${(error as Error).message})`);
    process.exit(2);
  }
  const runs = runsDir();
  const names = existsSync(runs) ? readdirSync(runs) : [];
  const keep = unsavedFiles(names, (name) => readFileSync(join(runs, name), "utf8"));
  if (!keep.length) {
    console.log("factory:keep: every run in the runs folder saved its own log; nothing to keep.");
    return;
  }
  const privateRepo = join(ROOT, "private");
  if (!existsSync(join(privateRepo, ".git"))) {
    console.error("factory:keep: no private checkout to keep the logs in.");
    process.exit(2);
  }
  const into = relative(privateRepo, evidenceDir(loadFactory())).replace(/\\/g, "/");
  const tree = mkdtempSync(join(tmpdir(), "factory-keep-"));
  try {
    gitLong(privateRepo, "fetch", "--quiet", "origin", "main");
    gitLong(privateRepo, "worktree", "add", "--detach", tree, "origin/main");
    const dir = resolve(tree, into, "factory-runs");
    mkdirSync(dir, { recursive: true });
    for (const name of keep) copyFileSync(join(runs, name), join(dir, name));
    git(tree, "add", "-A");
    git(tree, "commit", "--quiet", "-m", `Factory: logs of ${keep.length} file(s) the run didn't save`);
    gitLong(tree, "push", "--quiet", "origin", `HEAD:refs/heads/${branch}`);
    console.log(
      `factory:keep: ${keep.length} file(s) from unsaved runs pushed to the private repo's ${branch} branch.`,
    );
  } catch (error) {
    console.error(`factory:keep: couldn't push the unsaved logs: ${(error as Error).message.split("\n")[0]}`);
    process.exitCode = 1;
  } finally {
    try {
      git(privateRepo, "worktree", "remove", "--force", tree);
    } catch {
      rmSync(tree, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
