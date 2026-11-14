/**
 * Runs a git command whose output can be any size and hands it back one line at a time, without ever holding
 * all of it (AUD-N6). `execFileSync` buffers the whole output under a fixed `maxBuffer` and `timeout`; a
 * history that only grows will one day pass both. Here git writes to a temporary file and the file is read
 * in chunks, so memory stays bounded by the longest line and there is no size ceiling. Synchronous, so its
 * callers stay synchronous.
 *
 * The temporary file lives in a folder of its own under the system temp folder, made with mode 0700 and the
 * file with 0600, so only this user can read it: the output can be the private answer key's history. It is
 * never inside the repository being read, so a check such as `ledger:check` writes nothing there. The folder is
 * removed when the call ends, and a folder an earlier, killed run left behind is removed by the next run once
 * it is an hour old.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

const CHUNK = 1024 * 1024;
/** The name every temporary folder starts with, so a later run can find a killed run's leftovers. */
export const TEMP_PREFIX = "faultforge-git-lines-";
const STALE_MS = 60 * 60 * 1000;

/** Removes temporary folders an earlier, killed run left in `tempRoot`, once they are an hour old. */
function sweep(tempRoot: string, now: number): void {
  for (const name of readdirSync(tempRoot)) {
    if (!name.startsWith(TEMP_PREFIX)) continue;
    const path = join(tempRoot, name);
    try {
      if (now - statSync(path).mtimeMs > STALE_MS) rmSync(path, { recursive: true, force: true });
    } catch {
      // Another run may be removing it at the same moment, or it belongs to another user.
    }
  }
}

/** `repoRoot` itself when it is the root of its own git repository; throws otherwise, saying which. */
export function ownRepoRoot(repoRoot: string): string {
  let toplevel: string;
  try {
    toplevel = execFileSync("git", ["-C", repoRoot, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    throw new Error(`${repoRoot} is not inside a git repository: ${(error as Error).message}`);
  }
  // Real paths on both sides: a Windows temp folder can be given by its short 8.3 name (RUNNER~1) while git
  // reports the long one, and a symlinked folder (macOS /tmp) differs the same way. Same folder, same answer.
  if (realpathSync.native(toplevel) !== realpathSync.native(repoRoot)) {
    throw new Error(`${repoRoot} is not the root of its own git repository (git found ${toplevel} instead)`);
  }
  return toplevel;
}

/** Calls `onLine` with each line git prints (without its line break). Throws when git fails, with its stderr. */
export function eachGitLine(
  repoRoot: string,
  args: string[],
  onLine: (line: string) => void,
  now: number = Date.now(),
  tempRoot: string = tmpdir(),
): void {
  sweep(tempRoot, now);
  const dir = mkdtempSync(join(tempRoot, TEMP_PREFIX));
  try {
    // mkdtemp already makes it 0700 on POSIX; said again so it never depends on that.
    chmodSync(dir, 0o700);
    const file = join(dir, "out");
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
