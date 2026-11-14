/**
 * Runs a git command whose output can be any size and hands it back one line at a time, without ever holding
 * all of it (AUD-N6). `execFileSync` buffers the whole output under a fixed `maxBuffer` and `timeout`; a
 * history that only grows will one day pass both. Here git writes to a temporary file and the file is read
 * in chunks (`LineReader`, which reads any file that way), so memory stays bounded by the longest line and
 * there is no size ceiling. Synchronous, so its callers stay synchronous.
 *
 * The temporary file lives in a folder of its own under the system temp folder, made with mode 0700 and the
 * file with 0600, so only this user can read it: the output can be the private answer key's history. It is
 * never inside the repository being read, so a check such as `ledger:check` writes nothing there. The folder is
 * removed when the call ends. Its name carries the process id, so a later run removes a folder an earlier run
 * left behind only once that process is gone and the folder is an hour old, never one still in use.
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
/** The name every temporary folder starts with, followed by its process id and a dash. */
export const TEMP_PREFIX = "faultforge-git-lines-";
const STALE_MS = 60 * 60 * 1000;

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

/** Whether process `pid` is still running (a process of another user counts as running). */
export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Removes temporary folders an earlier, killed run left in `tempRoot`: only once the process named in the
 * folder's name is gone and the folder is an hour old. A folder whose name carries no process id is left alone.
 */
function sweep(tempRoot: string, now: number, running: (pid: number) => boolean): void {
  for (const name of readdirSync(tempRoot)) {
    if (!name.startsWith(TEMP_PREFIX)) continue;
    const pid = Number(name.slice(TEMP_PREFIX.length).split("-")[0]);
    if (!Number.isInteger(pid) || pid <= 0 || running(pid)) continue;
    const path = join(tempRoot, name);
    try {
      if (now - statSync(path).mtimeMs > STALE_MS) rmSync(path, { recursive: true, force: true });
    } catch {
      // Another run may be removing it at the same moment, or it belongs to another user.
    }
  }
}

/** A file's lines, one at a time (without line breaks), read in chunks: never the whole file at once. */
export class LineReader {
  private readonly fd: number;
  private readonly buffer = Buffer.alloc(CHUNK);
  private readonly decoder = new StringDecoder("utf8");
  private lines: string[] = [];
  private at = 0;
  private rest = "";
  private ended = false;

  constructor(path: string) {
    this.fd = openSync(path, "r");
  }

  /** The next line, or undefined after the last one. */
  next(): string | undefined {
    while (this.at >= this.lines.length && !this.ended) {
      const read = readSync(this.fd, this.buffer, 0, CHUNK, null);
      if (read === 0) {
        this.ended = true;
        const last = this.rest + this.decoder.end();
        this.lines = last ? [last] : [];
      } else {
        this.lines = (this.rest + this.decoder.write(this.buffer.subarray(0, read))).split("\n");
        this.rest = this.lines.pop() ?? "";
      }
      this.at = 0;
    }
    return this.at < this.lines.length ? this.lines[this.at++] : undefined;
  }

  close(): void {
    closeSync(this.fd);
  }
}

/** Calls `onLine` with each line git prints (without its line break). Throws when git fails, with its stderr. */
export function eachGitLine(
  repoRoot: string,
  args: string[],
  onLine: (line: string) => void,
  now: number = Date.now(),
  tempRoot: string = tmpdir(),
  running: (pid: number) => boolean = isRunning,
): void {
  sweep(tempRoot, now, running);
  const dir = mkdtempSync(join(tempRoot, `${TEMP_PREFIX}${process.pid}-`));
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

    const reader = new LineReader(file);
    try {
      for (let line = reader.next(); line !== undefined; line = reader.next()) onLine(line);
    } finally {
      reader.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
