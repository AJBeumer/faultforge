import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FactoryConfig } from "./factory-config.ts";
import { fingerprints, samePath, teardown, worktreeFor } from "./factory-workspace.ts";
import { git, gitRepo } from "./fixtures/git-repo.ts";
import { ROOT as LAB_ROOT } from "./paths.ts";

/** Only the harness itself: a repo at another path would point teardown at a sibling of the real checkout. */
const FACTORY: FactoryConfig = {
  evidence: "private/raw-artifacts",
  repos: {
    lab: {
      github: "owner/lab",
      path: ".",
      guard: "lab",
      check: "npm run check",
      tests: "\\.test\\.ts$",
      start: null,
      tickets: { sections: ["Result"], checklist: "Result" },
      board: true,
    },
  },
};

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const made: string[] = [];
const scratch = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("worktreeFor", () => {
  it("resolves a repo's configured path from the lab's worktree", () => {
    const lab = join("runs", "r", "faultforge");
    expect(worktreeFor(lab, ".")).toBe(resolve(lab));
    expect(worktreeFor(lab, "../faultforge-target")).toBe(resolve("runs", "r", "faultforge-target"));
  });
});

describe("teardown: removes a run's worktrees, branch and folder, reporting what it couldn't", () => {
  /** A private repo with a run's worktree on its own branch, inside a run folder, as `workspace()` leaves it. */
  const run = (runId: string) => {
    const privateRepo = gitRepo({ "README.md": "private\n" });
    made.push(privateRepo);
    const root = scratch("run-");
    const lab = join(root, "faultforge");
    const priv = join(lab, "private");
    mkdirSync(lab, { recursive: true });
    git(privateRepo, "worktree", "add", "-q", "-b", `run-${runId}`, priv, "main");
    return { privateRepo, root, lab, priv };
  };

  it("removes the private worktree, its branch and the run folder, and reports nothing", () => {
    const { privateRepo, root, lab, priv } = run("ok");
    expect(teardown(FACTORY, privateRepo, root, lab, priv, "ok")).toEqual([]);
    expect(git(privateRepo, "worktree", "list", "--porcelain")).not.toContain("private");
    expect(git(privateRepo, "branch", "--list", "run-ok").trim()).toBe("");
    expect(existsSync(root)).toBe(false);
  });

  it("names each step that failed, and still removes the run folder", () => {
    const { privateRepo, root, lab, priv } = run("locked");
    // A locked worktree survives a single --force, and its branch can't be deleted while it is checked out.
    git(privateRepo, "worktree", "lock", priv);
    const failed = teardown(FACTORY, privateRepo, root, lab, priv, "locked");
    expect(failed.map((f) => f.split(":")[0])).toEqual(["private worktree", "private branch"]);
    expect(git(privateRepo, "branch", "--list", "run-locked").trim()).not.toBe("");
    expect(existsSync(root)).toBe(false);
    git(privateRepo, "worktree", "prune");
  });
});

describe("fingerprints: what the agent must not change", () => {
  const guarded = (files: Record<string, string>) => {
    const lab = scratch("lab-");
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(lab, ".claude", path, ".."), { recursive: true });
      writeFileSync(join(lab, ".claude", path), text);
    }
    return lab;
  };

  it("in CI, hashes only the guardrail files: each sorted path, then its content", () => {
    const lab = guarded({ "settings.json": "{}", "hooks/guard.ts": "deny" });
    const prints = fingerprints(FACTORY, "unused", "ci", lab);
    expect(prints).toEqual({
      [`the run's guardrail files (${join(lab, ".claude")})`]: sha256("hooks/guard.ts\ndeny\nsettings.json\n{}"),
    });
  });

  it("changes when a guarded file changes, or a new one appears", () => {
    const lab = guarded({ "settings.json": "{}", "hooks/guard.ts": "deny" });
    const first = fingerprints(FACTORY, "unused", "ci", lab);
    writeFileSync(join(lab, ".claude", "hooks", "guard.ts"), "allow");
    const edited = fingerprints(FACTORY, "unused", "ci", lab);
    expect(edited).not.toEqual(first);
    writeFileSync(join(lab, ".claude", "skills.md"), "new");
    expect(fingerprints(FACTORY, "unused", "ci", lab)).not.toEqual(edited);
  });

  it("locally, also fingerprints the owner's checkouts, and sees a change to one", () => {
    const lab = guarded({ "settings.json": "{}" });
    const privateRepo = gitRepo({ "README.md": "private\n" });
    made.push(privateRepo);
    const first = fingerprints(FACTORY, privateRepo, "local", lab);
    // The lab is listed as ROOT itself and as each repo's path resolved from it; ROOT ends with a separator
    // and the resolved "." doesn't, so both spellings are fingerprinted (the same checkout, twice).
    const expected = new Set([
      `the owner's checkout ${LAB_ROOT}`,
      `the owner's checkout ${resolve(LAB_ROOT, ".")}`,
      `the owner's checkout ${privateRepo}`,
      `the run's guardrail files (${join(lab, ".claude")})`,
    ]);
    expect(Object.keys(first).sort()).toEqual([...expected].sort());
    writeFileSync(join(privateRepo, "notes.md"), "uncommitted\n");
    const after = fingerprints(FACTORY, privateRepo, "local", lab);
    expect(after[`the owner's checkout ${privateRepo}`]).not.toBe(first[`the owner's checkout ${privateRepo}`]);
  });
});

describe("samePath: one folder, however it is spelled (Windows CI on PR 240)", () => {
  it("matches a folder against its real path and a differently cased drive letter", () => {
    const dir = mkdtempSync(join(tmpdir(), "same-path-"));
    expect(samePath(dir, realpathSync.native(dir))).toBe(true);
    expect(samePath(dir, join(dir, "."))).toBe(true);
    if (process.platform === "win32")
      expect(
        samePath(
          dir,
          dir.replace(/^[A-Z]/, (c) => c.toLowerCase()),
        ),
      ).toBe(true);
    expect(samePath(dir, join(dir, "other"))).toBe(false);
  });
});
