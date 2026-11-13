import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { baseTreeTelltales } from "./base-tree.ts";

function repoWith(files: Record<string, string>): { dir: string; head: string } {
  const dir = mkdtempSync(join(tmpdir(), "base-tree-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
  git("init", "--quiet", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  git("add", ".");
  git("commit", "--quiet", "-m", "base");
  return { dir, head: git("rev-parse", "HEAD") };
}

describe("baseTreeTelltales (#224, audit H-4)", () => {
  it("is empty for a tree of ordinary files, the repository's own name included", () => {
    const { dir, head } = repoWith({ "README.md": "# faultforge-target\n\nA booking API.\n", "a.ts": "export {};\n" });
    expect(baseTreeTelltales(dir, head)).toEqual([]);
  });

  it("names each file whose text or path gives the lab away", () => {
    const { dir, head } = repoWith({
      "README.md": "This is the codebase FaultForge exercises.\n",
      "ledger-notes.md": "ordinary text\n",
      "a.ts": "export {};\n",
    });
    expect(baseTreeTelltales(dir, head)).toEqual(["README.md: names the lab", "ledger-notes.md: mentions the ledger"]);
  });
});
