/**
 * The git-level guard keeps a reviewed repo's history (re-grade 3): a pre-push that deletes a ref, or moves one
 * to a commit that doesn't contain what the remote holds, is refused, whatever started the push.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempRepo } from "./fixtures.ts";
import { check, HISTORY, historyProblem } from "./git-guard.ts";

const ZERO = "0".repeat(40);

/** A clone whose `origin/main` is one commit ahead of where it started, and a rewritten commit beside it. */
function diverged() {
  const repo = tempRepo(true);
  const base = repo.git("rev-parse", "HEAD").trim();
  writeFileSync(join(repo.dir, "a.md"), "One\n");
  repo.git("add", "a.md");
  repo.git("commit", "-q", "-m", "Add a");
  repo.git("push", "-q", "origin", "main");
  const pushed = repo.git("rev-parse", "HEAD").trim();
  repo.git("reset", "-q", "--hard", base);
  writeFileSync(join(repo.dir, "b.md"), "Two\n");
  repo.git("add", "b.md");
  repo.git("commit", "-q", "-m", "Add b");
  const rewritten = repo.git("rev-parse", "HEAD").trim();
  repo.git("reset", "-q", "--hard", pushed);
  writeFileSync(join(repo.dir, "c.md"), "Three\n");
  repo.git("add", "c.md");
  repo.git("commit", "-q", "-m", "Add c");
  const forward = repo.git("rev-parse", "HEAD").trim();
  return { ...repo, pushed, rewritten, forward };
}

const line = (local: string, remote: string, ref = "refs/heads/main") => `refs/heads/main ${local} ${ref} ${remote}\n`;

describe("a push to a reviewed repo keeps its history (re-grade 3)", () => {
  it("refuses a non-fast-forward update, and names no ref", () => {
    const { dir, pushed, rewritten } = diverged();
    const found = check("pre-push", dir, "origin", line(rewritten, pushed, "refs/heads/x-secret-v1"));
    expect(found?.where).toBe(HISTORY);
    expect(found?.reasons.join(" ")).toMatch(/rewrites a ref/);
    expect(found?.reasons.join(" ")).not.toMatch(/secret/);
  });

  it("refuses a deletion, as `--delete` or `:main` sends it", () => {
    const { dir, pushed } = diverged();
    expect(check("pre-push", dir, "origin", `(delete) ${ZERO} refs/heads/main ${pushed}\n`)?.reasons).toEqual([
      "deletes a ref",
    ]);
  });

  it("refuses when the remote's commit isn't here to compare", () => {
    const { dir, forward } = diverged();
    expect(
      historyProblem(dir, [{ localSha: forward, remoteRef: "refs/heads/main", remoteSha: "1".repeat(40) }]),
    ).toMatch(/fetch first/);
  });

  it("allows a fast-forward, a new branch and a push of what the remote already has", () => {
    const { dir, pushed, forward } = diverged();
    expect(check("pre-push", dir, "origin", line(forward, pushed))).toBeUndefined();
    expect(check("pre-push", dir, "origin", line(forward, ZERO, "refs/heads/tidy-list"))).toBeUndefined();
    expect(check("pre-push", dir, "origin", line(pushed, pushed))).toBeUndefined();
  });
});
