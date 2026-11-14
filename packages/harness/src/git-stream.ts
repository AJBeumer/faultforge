/**
 * Runs a git command whose output can be any size and hands it back one line at a time, without ever holding
 * all of it (AUD-N6). `execFileSync` buffers the whole output under a fixed `maxBuffer` and `timeout`; a
 * history that only grows will one day pass both. Here git writes to a temporary file and the file is read
 * in chunks, so memory stays bounded by the longest line and there is no size ceiling. Synchronous, so its
 * callers stay synchronous.
 */
import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

const CHUNK = 1024 * 1024;

/** Calls `onLine` with each line git prints (without its line break). Throws when git fails, with its stderr. */
export function eachGitLine(repoRoot: string, args: string[], onLine: (line: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "git-stream-"));
  const file = join(dir, "out");
  try {
    const out = openSync(file, "w");
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
