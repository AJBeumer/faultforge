import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eventProblems, readEventProblems } from "./ledger-append.ts";
import { buildRevision, main, revisionHashes } from "./ledger-revise.ts";
import { sha256 } from "./provenance.ts";

const TEMPLATE = "x-secret-v1";
const OLD = '{"id":"x-secret-v1"}\n';
const NEW = '{"id":"x-secret-v1","match":{"kindTerms":["race"]}}\n';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function sh(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

/** A lab repo whose template is created, then revised, then left alone; and private storage holding the case. */
function world() {
  const repo = temp("ledger-revise-repo-");
  sh(repo, "init", "--quiet", "-b", "main");
  sh(repo, "config", "user.email", "test@example.com");
  sh(repo, "config", "user.name", "Test");
  sh(repo, "config", "core.autocrlf", "false");
  const folder = join(repo, "templates", "seed", TEMPLATE);
  mkdirSync(folder, { recursive: true });
  const commit = (file: string, text: string, message: string) => {
    writeFileSync(join(repo, file), text);
    sh(repo, "add", "-A");
    sh(repo, "commit", "--quiet", "-m", message);
    return sh(repo, "rev-parse", "HEAD");
  };
  const created = commit(join("templates", "seed", TEMPLATE, "template.json"), OLD, "add template");
  const revised = commit(join("templates", "seed", TEMPLATE, "template.json"), NEW, "revise template");
  const unrelated = commit("README.md", "hello\n", "readme");
  const priv = temp("ledger-revise-private-");
  writeFileSync(
    join(priv, "ground-truth.jsonl"),
    `${JSON.stringify({ kind: "sabotage", caseId: "FF-9001", templateId: TEMPLATE })}\n`,
  );
  writeFileSync(join(priv, "audit-events.jsonl"), "");
  return { repo, priv, created, revised, unrelated };
}

const input = (commit: string, extra: Partial<{ caseId: string; templateId: string; reason: string }> = {}) => ({
  caseId: "FF-9001",
  templateId: TEMPLATE,
  commit,
  reason: "gained its kind terms after its verdict",
  ...extra,
});

describe("revisionHashes: template.json before and after the commit", () => {
  it("hashes the parent's and the commit's template.json, and resolves a short id to the full one", () => {
    const w = world();
    expect(revisionHashes(w.repo, TEMPLATE, w.revised.slice(0, 7))).toEqual({
      commit: w.revised,
      oldHash: sha256(OLD),
      newHash: sha256(NEW),
    });
  });

  it("refuses a commit that didn't change it, or that created it", () => {
    const w = world();
    expect(revisionHashes(w.repo, TEMPLATE, w.unrelated)).toEqual({
      refused: expect.stringContaining("didn't change"),
    });
    expect(revisionHashes(w.repo, TEMPLATE, w.created)).toEqual({ refused: expect.stringContaining("its creation") });
    expect(revisionHashes(w.repo, "x-other-v1", w.revised)).toEqual({
      refused: expect.stringContaining("no template.json"),
    });
  });

  it("throws for a commit git can't resolve", () => {
    const w = world();
    expect(() => revisionHashes(w.repo, TEMPLATE, "f".repeat(40))).toThrow(/can't resolve/);
  });
});

describe("buildRevision: a template.revised event that fits its schema", () => {
  it("builds the event from the answer key and the commit, and the schema accepts it", () => {
    const w = world();
    const event = buildRevision(input(w.revised), {
      repo: w.repo,
      privateRoot: w.priv,
      now: new Date("2026-11-14T03:00:00Z"),
    });
    expect(event).toMatchObject({
      type: "template.revised",
      at: "2026-11-14T03:00:00.000Z",
      caseId: "FF-9001",
      templateId: TEMPLATE,
      oldHash: sha256(OLD),
      newHash: sha256(NEW),
      commit: w.revised,
      reason: "gained its kind terms after its verdict",
    });
    expect(eventProblems(event)).toEqual([]);
    expect(readEventProblems(event as Record<string, unknown>)).toBeUndefined();
  });

  it("refuses a case the answer key doesn't hold, another case's template, and a blank reason", () => {
    const w = world();
    const opts = { repo: w.repo, privateRoot: w.priv };
    expect(buildRevision(input(w.revised, { caseId: "FF-9002" }), opts)).toEqual({
      refused: "the answer key holds no FF-9002",
    });
    expect(buildRevision(input(w.revised, { templateId: "x-other-v1" }), opts)).toEqual({
      refused: expect.stringContaining("another template"),
    });
    expect(buildRevision(input(w.revised, { reason: "  " }), opts)).toEqual({ refused: "a revision needs a reason" });
    expect(buildRevision(input(w.revised, { caseId: "case-1" }), opts)).toEqual({
      refused: expect.stringContaining("not a case id"),
    });
  });
});

describe("the template.revised schema", () => {
  const valid = {
    eventId: "e1",
    type: "template.revised",
    at: "2026-11-14T03:00:00Z",
    caseId: "FF-9001",
    templateId: TEMPLATE,
    oldHash: "a".repeat(64),
    newHash: "b".repeat(64),
    commit: "c".repeat(40),
    reason: "why",
    tool: "faultforge-harness@0.0.0",
    environment: "linux-x64-node24",
  };

  it("accepts a whole event", () => {
    expect(eventProblems(valid)).toEqual([]);
  });

  it("requires every field, in its shape, and nothing else", () => {
    for (const field of ["templateId", "oldHash", "newHash", "commit", "reason", "tool", "environment"]) {
      const { [field as keyof typeof valid]: _gone, ...rest } = valid;
      expect(eventProblems(rest).join("; ")).toContain(field);
    }
    expect(eventProblems({ ...valid, oldHash: "abc" })).not.toEqual([]);
    expect(eventProblems({ ...valid, commit: "c".repeat(7) })).not.toEqual([]);
    expect(eventProblems({ ...valid, reason: " " })).not.toEqual([]);
    expect(eventProblems({ ...valid, extra: 1 })).toEqual(['/: unknown property "extra"']);
  });
});

describe("main: appends one event, or refuses and writes nothing", () => {
  const quiet = () => {
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => {
      out.push(line);
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    return out;
  };
  const args = (commit: string, ...extra: string[]) => [
    "--case",
    "FF-9001",
    "--template",
    TEMPLATE,
    "--commit",
    commit,
    "--reason",
    "gained its kind terms after its verdict",
    ...extra,
  ];

  it("appends the event once; the same revision again is refused, exit 1", () => {
    const w = world();
    quiet();
    const log = join(w.priv, "audit-events.jsonl");
    expect(main(args(w.revised, "--repo", w.repo), w.priv)).toBe(0);
    const lines = readFileSync(log, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ type: "template.revised", commit: w.revised });
    expect(main(args(w.revised, "--repo", w.repo), w.priv)).toBe(1);
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("writes nothing with --dry-run, and prints the event", () => {
    const w = world();
    const out = quiet();
    expect(main(args(w.revised, "--repo", w.repo, "--dry-run"), w.priv)).toBe(0);
    expect(readFileSync(join(w.priv, "audit-events.jsonl"), "utf8")).toBe("");
    expect(JSON.parse(out[0] as string)).toMatchObject({ type: "template.revised" });
  });

  it("exits 1 on a refusal and 2 when it can't run, writing nothing either way", () => {
    const w = world();
    quiet();
    expect(main(args(w.unrelated, "--repo", w.repo), w.priv)).toBe(1);
    expect(main(args("f".repeat(40), "--repo", w.repo), w.priv)).toBe(2);
    expect(main(["--case", "FF-9001"], w.priv)).toBe(2);
    expect(main([...args(w.revised), "--unknown"], w.priv)).toBe(2);
    expect(readFileSync(join(w.priv, "audit-events.jsonl"), "utf8")).toBe("");
    expect(existsSync(join(w.priv, "audit-events.jsonl.lock"))).toBe(false);
  });
});
