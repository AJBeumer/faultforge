import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { blockedEvidencePaths, commitAndPublish } from "./factory-evidence.ts";

describe("blockedEvidencePaths (#102)", () => {
  it("allows paths under the evidence root or factory-log, nothing else", () => {
    expect(
      blockedEvidencePaths(
        [
          "raw-artifacts/factory-runs/x.jsonl",
          "raw-artifacts",
          "factory-log/2026-11-10.md",
          "factory-log",
          "ground-truth.jsonl",
          "audit-events.jsonl",
          "templates/evil/template.ts",
          "config/qodo.yaml",
          "raw-artifacts-evil/x", // a prefix match, not a path under the root
        ],
        "raw-artifacts",
      ),
    ).toEqual([
      "ground-truth.jsonl",
      "audit-events.jsonl",
      "templates/evil/template.ts",
      "config/qodo.yaml",
      "raw-artifacts-evil/x",
    ]);
  });

  it("drops only the genuinely empty line split() leaves after the trailing newline, never trims a real path", () => {
    expect(blockedEvidencePaths([""], "raw-artifacts")).toEqual([]);
    // A leading space is part of a real (if unusual) filename, not formatting noise to strip (Qodo on PR 141):
    // trimming it would make a root-level path look like it's under the evidence root when it is not.
    expect(blockedEvidencePaths([" raw-artifacts/x"], "raw-artifacts")).toEqual([" raw-artifacts/x"]);
  });
});

describe("commitAndPublish: what a run may push to the private repo (#102)", () => {
  function sh(dir: string, ...args: string[]): string {
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
  }

  function bareOrigin(): string {
    const dir = mkdtempSync(join(tmpdir(), "ff-evidence-origin-"));
    sh(dir, "init", "--quiet", "--bare", "-b", "main");
    const seed = mkdtempSync(join(tmpdir(), "ff-evidence-seed-"));
    sh(seed, "init", "--quiet", "-b", "main");
    sh(seed, "config", "user.email", "test@example.com");
    sh(seed, "config", "user.name", "Test");
    writeFileSync(join(seed, "README.md"), "seed\n");
    sh(seed, "add", "README.md");
    sh(seed, "commit", "--quiet", "-m", "seed");
    sh(seed, "remote", "add", "origin", dir);
    sh(seed, "push", "--quiet", "origin", "HEAD:main");
    rmSync(seed, { recursive: true, force: true });
    return dir;
  }

  function clone(origin: string): string {
    const dir = mkdtempSync(join(tmpdir(), "ff-evidence-priv-"));
    sh(dir, "clone", "--quiet", origin, ".");
    sh(dir, "config", "user.email", "test@example.com");
    sh(dir, "config", "user.name", "Test");
    return dir;
  }

  it("a push to private main by someone else during the run is not the run's change (AUD-M2, two clones)", () => {
    const origin = bareOrigin();
    const run = clone(origin);
    const other = clone(origin);
    // The run writes only its evidence.
    mkdirSync(join(run, "raw-artifacts", "factory-runs"), { recursive: true });
    writeFileSync(join(run, "raw-artifacts", "factory-runs", "x.jsonl"), '{"event":"idle"}\n');
    // Meanwhile the owner pushes a case record and a template to main.
    mkdirSync(join(other, "templates", "x-secret-v1"), { recursive: true });
    writeFileSync(join(other, "templates", "x-secret-v1", "template.json"), "{}\n");
    writeFileSync(join(other, "ground-truth.jsonl"), '{"caseId":"FF-9001"}\n');
    sh(other, "add", "-A");
    sh(other, "commit", "--quiet", "-m", "owner's case");
    sh(other, "push", "--quiet", "origin", "HEAD:main");
    const result = commitAndPublish(run, "raw-artifacts", "x", sh, sh);
    expect(result).toEqual({ pushed: true, blocked: [] });
    expect(sh(origin, "show", "main:raw-artifacts/factory-runs/x.jsonl")).toContain("idle");
    expect(sh(origin, "show", "main:ground-truth.jsonl")).toContain("FF-9001");
  });

  it("a second copy after the first push, with main moved again, still sees only the run's own files", () => {
    const origin = bareOrigin();
    const run = clone(origin);
    const other = clone(origin);
    const log = join(run, "raw-artifacts", "factory-runs", "y.jsonl");
    mkdirSync(join(run, "raw-artifacts", "factory-runs"), { recursive: true });
    writeFileSync(log, '{"event":"picked"}\n');
    expect(commitAndPublish(run, "raw-artifacts", "y", sh, sh).pushed).toBe(true);
    sh(other, "pull", "--quiet", "origin", "main");
    writeFileSync(join(other, "audit-events.jsonl"), '{"event":"x"}\n');
    sh(other, "add", "-A");
    sh(other, "commit", "--quiet", "-m", "owner's audit event");
    sh(other, "push", "--quiet", "origin", "HEAD:main");
    writeFileSync(log, '{"event":"picked"}\n{"event":"finished"}\n');
    expect(commitAndPublish(run, "raw-artifacts", "y", sh, sh)).toEqual({ pushed: true, blocked: [] });
  });

  it("diffs from the commit the run started on when given, not from main as fetched now", () => {
    const calls: string[][] = [];
    const run = (_cwd: string, ...args: string[]) => {
      calls.push(args);
      return "";
    };
    commitAndPublish("/priv", "raw-artifacts", "z", run, run, "abc1234");
    expect(calls).toContainEqual(["diff", "--no-renames", "--name-only", "abc1234", "HEAD"]);
    expect(calls.some((c) => c[0] === "diff" && c.includes("origin/main"))).toBe(false);
  });

  it("pushes an allowed run straight to main", () => {
    const origin = bareOrigin();
    const priv = clone(origin);
    mkdirSync(join(priv, "raw-artifacts", "factory-runs"), { recursive: true });
    writeFileSync(join(priv, "raw-artifacts", "factory-runs", "run1.jsonl"), '{"event":"idle"}\n');
    const result = commitAndPublish(priv, "raw-artifacts", "run1", sh, sh);
    expect(result).toEqual({ pushed: true, blocked: [] });
    expect(sh(origin, "show", "main:raw-artifacts/factory-runs/run1.jsonl")).toContain("idle");
  });

  it("refuses to push a run that touched the answer key, and moves main not at all", () => {
    const origin = bareOrigin();
    const priv = clone(origin);
    const mainBefore = sh(origin, "rev-parse", "main");
    mkdirSync(join(priv, "raw-artifacts", "factory-runs"), { recursive: true });
    writeFileSync(join(priv, "raw-artifacts", "factory-runs", "run2.jsonl"), '{"event":"idle"}\n');
    writeFileSync(join(priv, "ground-truth.jsonl"), '{"caseId":"FF-0099"}\n');
    const result = commitAndPublish(priv, "raw-artifacts", "run2", sh, sh);
    expect(result.pushed).toBe(false);
    expect(result.blocked).toEqual(["ground-truth.jsonl"]);
    expect(result.savedAt).toBe("blocked-run2");
    expect(sh(origin, "rev-parse", "main")).toBe(mainBefore);
    expect(sh(origin, "show", "blocked-run2:ground-truth.jsonl")).toContain("FF-0099");
  });

  it("does not mistake a similarly-prefixed root path for one under the evidence root, through the same trimming `git` helper production uses (Qodo on PR 141, round 2)", () => {
    const origin = bareOrigin();
    const priv = clone(origin);
    mkdirSync(join(priv, "raw-artifacts-decoy"), { recursive: true });
    writeFileSync(join(priv, "raw-artifacts-decoy", "file.txt"), "nope\n");
    const result = commitAndPublish(priv, "raw-artifacts", "run5", sh, sh);
    expect(result.pushed).toBe(false);
    expect(result.blocked).toEqual(["raw-artifacts-decoy/file.txt"]);
  });

  it("still blocks a protected file moved under the evidence root: the rename's old path still counts as changed (Qodo on PR 141)", () => {
    const origin = bareOrigin();
    // Seed `ground-truth.jsonl` on main itself, so moving it is a same-commit rename, not a new file.
    const seedMain = clone(origin);
    writeFileSync(join(seedMain, "ground-truth.jsonl"), '{"caseId":"FF-0001"}\n');
    sh(seedMain, "add", "ground-truth.jsonl");
    sh(seedMain, "commit", "--quiet", "-m", "seed ground truth");
    sh(seedMain, "push", "--quiet", "origin", "HEAD:main");
    rmSync(seedMain, { recursive: true, force: true });
    const mainBefore = sh(origin, "rev-parse", "main");

    const priv = clone(origin);
    mkdirSync(join(priv, "raw-artifacts"), { recursive: true });
    sh(priv, "mv", "ground-truth.jsonl", "raw-artifacts/ground-truth.jsonl");
    const result = commitAndPublish(priv, "raw-artifacts", "run3", sh, sh);
    expect(result.pushed).toBe(false);
    expect(result.blocked).toContain("ground-truth.jsonl");
    expect(sh(origin, "rev-parse", "main")).toBe(mainBefore);
  });

  it("sees a change the agent already committed mid-run, before saveEvidence ever stages anything", () => {
    const origin = bareOrigin();
    const priv = clone(origin);
    mkdirSync(join(priv, "config"), { recursive: true });
    writeFileSync(join(priv, "config", "qodo-rules.yaml"), "rules: []\n");
    sh(priv, "add", "config/qodo-rules.yaml");
    sh(priv, "commit", "--quiet", "-m", "agent's own commit mid-run");
    const result = commitAndPublish(priv, "raw-artifacts", "run4", sh, sh);
    expect(result.pushed).toBe(false);
    expect(result.blocked).toEqual(["config/qodo-rules.yaml"]);
  });
});
