import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendOnlyProblems, ledgerCheckProblems } from "./ledger-check.ts";

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
    commit(dir, "audit-events.jsonl", '{"eventId":"evt-1"}\n', "first event");
    expect(ledgerCheckProblems(dir)).toEqual([]);
  });
});
