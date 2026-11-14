/**
 * The ledger's history check on a synthetic private repo with many commits and a history whose `git log -p`
 * is larger than the old 64 MB buffer (AUD-N6): it reads it as a stream, finds the one bad commit, and
 * still passes a clean history.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { eachGitLine } from "../src/git-stream.ts";
import { appendOnlyProblems } from "../src/ledger-check.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * A repo whose `log.jsonl` gets `commits` appends, one commit each, through `git fast-import` (fast, however
 * many). `removeAt` drops the first line in that commit; `bigLast` appends that many bytes in the last one.
 */
function repo(commits: number, opts: { removeAt?: number; bigLast?: number } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "ledger-history-"));
  dirs.push(dir);
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  const lines: string[] = [];
  const parts: Buffer[] = [];
  for (let i = 1; i <= commits; i++) {
    lines.push(`{"n":${i}}`);
    if (i === opts.removeAt) lines.shift();
    if (i === commits && opts.bigLast) {
      const line = `{"pad":"${"x".repeat(990)}"}`;
      for (let b = 0; b < opts.bigLast; b += line.length + 1) lines.push(line);
    }
    const content = Buffer.from(`${lines.join("\n")}\n`);
    const message = `append ${i}\n`;
    parts.push(
      Buffer.from(
        `commit refs/heads/main\ncommitter T <t@example.com> ${1_700_000_000 + i} +0000\ndata ${Buffer.byteLength(message)}\n${message}M 100644 inline log.jsonl\ndata ${content.length}\n`,
      ),
      content,
      Buffer.from("\n"),
    );
  }
  execFileSync("git", ["-C", dir, "fast-import", "--quiet"], { input: Buffer.concat(parts), maxBuffer: 1 << 30 });
  execFileSync("git", ["-C", dir, "checkout", "-q", "main"]);
  return dir;
}

describe("the ledger history check reads history as a stream (AUD-N6)", () => {
  it("passes a clean history of many commits", () => {
    expect(appendOnlyProblems(repo(1500), "log.jsonl")).toEqual([]);
  }, 120_000);

  it("finds the one commit that removed a line among many", () => {
    const problems = appendOnlyProblems(repo(1500, { removeAt: 777 }), "log.jsonl");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/log\.jsonl: commit [0-9a-f]{12} removed or changed a line/);
  }, 120_000);

  it("reads a history whose log is larger than the old 64 MB buffer", () => {
    const dir = repo(50, { bigLast: 70 * 1024 * 1024, removeAt: 20 });
    let bytes = 0;
    eachGitLine(dir, ["log", "--no-color", "-p", "--", "log.jsonl"], (line) => {
      bytes += line.length + 1;
    });
    expect(bytes).toBeGreaterThan(64 * 1024 * 1024);
    const problems = appendOnlyProblems(dir, "log.jsonl");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("removed or changed a line");
  }, 300_000);
});
