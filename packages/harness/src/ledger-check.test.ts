import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendOnlyBreak, appendOnlyProblems, ledgerCheckProblems, ledgerProblemsWithHistory } from "./ledger-check.ts";

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ledger-check-"));
  sh(dir, "init", "--quiet", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  return dir;
}

function sh(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

function commit(dir: string, file: string, contents: string, message: string) {
  writeFileSync(join(dir, file), contents);
  sh(dir, "add", file);
  sh(dir, "commit", "--quiet", "-m", message);
}

describe("appendOnlyProblems: a file's git history", () => {
  it("is empty when every commit only adds lines", () => {
    const dir = repo();
    commit(dir, "ground-truth.jsonl", '{"caseId":"FF-0001"}\n', "first case");
    commit(dir, "ground-truth.jsonl", '{"caseId":"FF-0001"}\n{"caseId":"FF-0002"}\n', "second case");
    expect(appendOnlyProblems(dir, "ground-truth.jsonl")).toEqual([]);
  });

  it("is empty for a file with no history at all", () => {
    const dir = repo();
    expect(appendOnlyProblems(dir, "ground-truth.jsonl")).toEqual([]);
  });

  it("names the commit that changed an existing line", () => {
    const dir = repo();
    commit(dir, "ground-truth.jsonl", '{"caseId":"FF-0001","validated":true}\n', "first case");
    commit(dir, "ground-truth.jsonl", '{"caseId":"FF-0001","validated":false}\n', "edit the line");
    const editSha = sh(dir, "rev-parse", "HEAD").slice(0, 12);
    const problems = appendOnlyProblems(dir, "ground-truth.jsonl");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(editSha);
  });

  it("names the commit that removed a line", () => {
    const dir = repo();
    commit(dir, "ground-truth.jsonl", '{"caseId":"FF-0001"}\n{"caseId":"FF-0002"}\n', "two cases");
    commit(dir, "ground-truth.jsonl", '{"caseId":"FF-0001"}\n', "drop a case");
    expect(appendOnlyProblems(dir, "ground-truth.jsonl")).toHaveLength(1);
  });

  it("reports one problem per offending commit, not per removed line", () => {
    const dir = repo();
    commit(dir, "ground-truth.jsonl", '{"caseId":"FF-0001"}\n{"caseId":"FF-0002"}\n', "two cases");
    commit(dir, "ground-truth.jsonl", "", "drop everything");
    expect(appendOnlyProblems(dir, "ground-truth.jsonl")).toHaveLength(1);
  });

  it("catches an uncommitted edit, not just committed history (Qodo on PR 135)", () => {
    const dir = repo();
    commit(dir, "ground-truth.jsonl", '{"caseId":"FF-0001","validated":true}\n', "first case");
    writeFileSync(join(dir, "ground-truth.jsonl"), '{"caseId":"FF-0001","validated":false}\n');
    const problems = appendOnlyProblems(dir, "ground-truth.jsonl");
    expect(problems).toEqual(["ground-truth.jsonl: uncommitted changes removed or changed a line"]);
  });

  it("is empty when nothing but history exists, with no uncommitted changes", () => {
    const dir = repo();
    commit(dir, "ground-truth.jsonl", '{"caseId":"FF-0001"}\n', "first case");
    expect(appendOnlyProblems(dir, "ground-truth.jsonl")).toEqual([]);
  });

  it("catches a merge commit whose conflict resolution drops a line, which plain git log -p hides (Qodo on PR 135)", () => {
    const dir = repo();
    commit(dir, "f.jsonl", "L1\n", "base");
    sh(dir, "switch", "--quiet", "-c", "feature");
    commit(dir, "f.jsonl", "L1\nL2\n", "feature adds L2");
    sh(dir, "switch", "--quiet", "main");
    commit(dir, "f.jsonl", "L1\nL3\n", "main adds L3");
    try {
      sh(dir, "merge", "--no-ff", "--no-edit", "-q", "feature");
    } catch {
      // Expected: both sides touched line 2, so the merge conflicts and needs a manual resolution.
    }
    // Resolve by keeping only feature's line, dropping main's L3 without any earlier commit having done so.
    writeFileSync(join(dir, "f.jsonl"), "L1\nL2\n");
    sh(dir, "add", "f.jsonl");
    sh(dir, "commit", "--quiet", "--no-edit");
    const mergeSha = sh(dir, "rev-parse", "HEAD").slice(0, 12);
    const problems = appendOnlyProblems(dir, "f.jsonl");
    expect(problems.some((p) => p.includes(mergeSha))).toBe(true);
  });
});

describe("appendOnlyProblems: the repository itself", () => {
  it("refuses a directory that isn't the root of its own git repository", () => {
    const dir = repo();
    const nested = join(dir, "subdir");
    mkdirSync(nested);
    expect(() => appendOnlyProblems(nested, "ground-truth.jsonl")).toThrow(/not the root of its own git repository/);
  });

  it("refuses a directory with no git repository at all", () => {
    const dir = mkdtempSync(join(tmpdir(), "not-a-repo-"));
    expect(() => appendOnlyProblems(dir, "ground-truth.jsonl")).toThrow(/not inside a git repository/);
  });
});

describe("ledgerCheckProblems: both files together", () => {
  it("combines ledgerProblems and append-only problems across both files", () => {
    const dir = repo();
    commit(dir, "ground-truth.jsonl", '{"caseId":"FF-0001"}\n', "first case");
    commit(
      dir,
      "ground-truth.jsonl",
      `${JSON.stringify({ caseId: "FF-0001" })}\n${JSON.stringify({
        kind: "amendment",
        amends: "FF-9999",
        at: "t1",
        change: { note: "x" },
      })}\n`,
      "bad amendment",
    );
    commit(dir, "audit-events.jsonl", '{"eventId":"evt-1"}\n', "first event");
    const problems = ledgerCheckProblems(dir);
    expect(problems.some((p) => p.includes("FF-9999"))).toBe(true);
  });

  it("is empty for two clean, append-only files", () => {
    const dir = repo();
    commit(dir, "ground-truth.jsonl", '{"caseId":"FF-0001"}\n', "first case");
    const event = '{"eventId":"evt-1","type":"pr.opened","at":"2026-11-01T00:00:00Z","caseId":"FF-0001"}\n';
    commit(dir, "audit-events.jsonl", event, "first event");
    expect(ledgerCheckProblems(dir)).toEqual([]);
  });
});

describe("ledgerProblemsWithHistory: what the case commands check first (#224)", () => {
  it("finds a rewritten line in the committed history of a file at its repository's root", () => {
    const dir = repo();
    commit(dir, "audit-events.jsonl", '{"eventId":"e1","type":"x"}\n', "first");
    commit(dir, "audit-events.jsonl", '{"eventId":"e1","type":"y"}\n', "rewrite");
    const problems = ledgerProblemsWithHistory([join(dir, "audit-events.jsonl")]);
    expect(problems.join("\n")).toContain("removed or changed a line");
  });

  it("is empty for an append-only history, and checks no history for a file outside a repository", () => {
    const dir = repo();
    commit(dir, "audit-events.jsonl", '{"eventId":"e1","type":"x"}\n', "first");
    commit(dir, "audit-events.jsonl", '{"eventId":"e1","type":"x"}\n{"eventId":"e2","type":"x"}\n', "second");
    expect(ledgerProblemsWithHistory([join(dir, "audit-events.jsonl"), join(dir, "missing.jsonl")])).toEqual([]);
    const loose = mkdtempSync(join(tmpdir(), "not-a-repo-"));
    writeFileSync(join(loose, "audit-events.jsonl"), '{"eventId":"e1","type":"x"}\n');
    expect(ledgerProblemsWithHistory([join(loose, "audit-events.jsonl")])).toEqual([]);
  });
});

describe("ledgerProblemsWithHistory refuses what it can't check (Qodo on PR 232)", () => {
  it("reports a file in a folder inside another repository, rather than skipping its history", () => {
    const dir = repo();
    mkdirSync(join(dir, "nested"));
    writeFileSync(join(dir, "nested", "audit-events.jsonl"), '{"eventId":"e1","type":"x"}\n');
    const problems = ledgerProblemsWithHistory([join(dir, "nested", "audit-events.jsonl")]);
    expect(problems.join("\n")).toContain("can't be checked");
  });
});

describe("appendOnlyProblems: an amendment line is history like any other (M86)", () => {
  it("names the commit that removed an amendment", () => {
    const dir = repo();
    const amendment = '{"kind":"amendment","amends":"FF-0001","change":{"x":1},"reason":"r","evidence":"e"}';
    commit(dir, "ground-truth.jsonl", `{"caseId":"FF-0001"}\n${amendment}\n`, "case and amendment");
    commit(dir, "ground-truth.jsonl", '{"caseId":"FF-0001"}\n', "drop the amendment");
    expect(appendOnlyProblems(dir, "ground-truth.jsonl")).toHaveLength(1);
  });
});

describe("appendOnlyProblems: a line inserted before the end (AUD-M10, #251)", () => {
  it("names the commit that inserted a line between two old ones", () => {
    const dir = repo();
    commit(dir, "ground-truth.jsonl", '{"caseId":"FF-0001"}\n{"caseId":"FF-0003"}\n', "two cases");
    commit(
      dir,
      "ground-truth.jsonl",
      '{"caseId":"FF-0001"}\n{"caseId":"FF-0002"}\n{"caseId":"FF-0003"}\n',
      "back-date",
    );
    const problems = appendOnlyProblems(dir, "ground-truth.jsonl");
    expect(problems).toEqual([expect.stringContaining("inserted a line before the end")]);
  });

  it("finds an uncommitted insertion at the top", () => {
    const dir = repo();
    commit(dir, "ground-truth.jsonl", '{"caseId":"FF-0001"}\n', "one case");
    writeFileSync(join(dir, "ground-truth.jsonl"), '{"caseId":"FF-0000"}\n{"caseId":"FF-0001"}\n');
    expect(appendOnlyProblems(dir, "ground-truth.jsonl")).toEqual([
      "ground-truth.jsonl: uncommitted changes inserted a line before the end",
    ]);
  });

  it("still accepts a plain append", () => {
    expect(appendOnlyBreak("@@ -1,1 +1,2 @@\n a\n+b\n")).toBeUndefined();
    expect(appendOnlyBreak("@@ -1,1 +1,2 @@\n+a\n b\n")).toBe("inserted");
    expect(appendOnlyBreak("@@ -1,2 +1,1 @@\n a\n-b\n")).toBe("removed");
  });
});
