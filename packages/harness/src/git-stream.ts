/**
 * Runs a git command whose output can be any size and hands it back one line at a time, without ever holding
 * all of it (AUD-N6). `execFileSync` buffers the whole output under a fixed `maxBuffer` and `timeout`; a
 * history that only grows will one day pass both. Here git writes to a temporary file and the file is read
 * in chunks, so memory stays bounded by the longest line and there is no size ceiling. Synchronous, so its
 * callers stay synchronous.
 *
 * The temporary file lives inside the repository's own git folder, never the shared system temp folder: the
 * output can be the private answer key's history, and a run that is killed before it cleans up must not leave
 * that anywhere it wasn't already (Qodo on PR 280). Leftovers from such a run are removed by the next one.
 */
import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readdirSync, readSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

const CHUNK = 1024 * 1024;
const PREFIX = "line-stream-";
const STALE_MS = 60 * 60 * 1000;

/** The repository's git folder (`.git`, or a worktree's own folder under it). */
export function gitDirOf(repoRoot: string): string {
  const result = spawnSync("git", ["-C", repoRoot, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`not a git repository: ${repoRoot}: ${String(result.stderr).trim()}`);
  return result.stdout.trim();
}

/** Removes temporary folders an earlier, killed run left in `gitDir`, once they are an hour old. */
function sweep(gitDir: string, now: number): void {
  for (const name of readdirSync(gitDir)) {
    if (!name.startsWith(PREFIX)) continue;
    const path = join(gitDir, name);
    try {
      if (now - statSync(path).mtimeMs > STALE_MS) rmSync(path, { recursive: true, force: true });
    } catch {
      // Another run may be removing it at the same moment.
    }
  }
}

/** Calls `onLine` with each line git prints (without its line break). Throws when git fails, with its stderr. */
export function eachGitLine(
  repoRoot: string,
  args: string[],
  onLine: (line: string) => void,
  now: number = Date.now(),
): void {
  const gitDir = gitDirOf(repoRoot);
  sweep(gitDir, now);
  const dir = mkdtempSync(join(gitDir, PREFIX));
  const file = join(dir, "out");
  try {
    const out = openSync(file, "w", 0o600);
    let result: ReturnType<typeof spawnSync>;
    try {
      result = spawnSync("git", ["-C", repoRoot, ...args], { stdio: ["ignore", out, "pipe"], encoding: "utf8" });
    } finally {
      closeSync(out);
    }
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`git ${args[0]} exited ${result.status}: ${String(result.stderr).trim()}`);

    const input = openSync(file, "r");
    try {
      const decoder = new StringDecoder("utf8");
      const buffer = Buffer.alloc(CHUNK);
      let rest = "";
      for (;;) {
        const read = readSync(input, buffer, 0, CHUNK, null);
        if (read === 0) break;
        const lines = (rest + decoder.write(buffer.subarray(0, read))).split("\n");
        rest = lines.pop() ?? "";
        for (const line of lines) onLine(line);
      }
      rest += decoder.end();
      if (rest) onLine(rest);
    } finally {
      closeSync(input);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
