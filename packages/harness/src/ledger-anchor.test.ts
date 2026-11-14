import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { anchorProblems, readAnchors, recordAnchor } from "./ledger-anchor.ts";
import { anchorsFileProblems, appendOnlyProblems, ledgerCheckProblems } from "./ledger-check.ts";

function sh(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

const CONTROL_ENTRY = {
  kind: "control",
  templateId: "x-control-v1",
  targetRepo: "https://github.com/Owner/target.git",
  targetCommit: "a".repeat(40),
  injectionCommit: "b".repeat(40),
  branch: "tidy",
  injectedFile: "src/x.ts",
  injectedLines: [1, 1],
  validation: { typecheck: "pass", publicTests: "pass", corpus: [] },
  validated: true,
  createdAt: "2026-11-01T00:00:00.000Z",
};

/** A private repository whose answer key gained one line per commit, and an empty anchors file beside it. */
function world() {
  const repo = mkdtempSync(join(tmpdir(), "ledger-anchor-"));
  sh(repo, "init", "--quiet", "-b", "main");
  sh(repo, "config", "user.email", "test@example.com");
  sh(repo, "config", "user.name", "Test");
  sh(repo, "config", "core.autocrlf", "false");
  const key = join(repo, "ground-truth.jsonl");
  // Each line a whole control entry, as `inject` writes one, so the answer-key schema accepts it.
  const add = (line: string) => {
    const entry = { ...CONTROL_ENTRY, ...JSON.parse(line) };
    writeFileSync(key, `${readFileOr(key)}${JSON.stringify(entry)}\n`);
    sh(repo, "add", "ground-truth.jsonl");
    sh(repo, "commit", "--quiet", "-m", `add ${line}`);
  };
  add('{"caseId":"FF-9001"}');
  add('{"caseId":"FF-9002"}');
  const anchors = join(mkdtempSync(join(tmpdir(), "ledger-anchors-")), "ledger-anchors.txt");
  return { repo, key, anchors, add };
}

function readFileOr(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** Replaces the whole history with one new commit holding the working tree as it is. */
function squash(repo: string) {
  sh(repo, "checkout", "--quiet", "--orphan", "squashed");
  sh(repo, "add", "-A");
  sh(repo, "commit", "--quiet", "-m", "one commit");
  sh(repo, "branch", "--quiet", "-D", "main");
  sh(repo, "branch", "--quiet", "-m", "main");
}

describe("recordAnchor (AUD-M11)", () => {
  it("appends the date and the private HEAD's commit id, and nothing else", () => {
    const w = world();
    const head = sh(w.repo, "rev-parse", "HEAD");
    expect(recordAnchor(w.repo, w.anchors, new Date("2026-11-14T03:00:00Z"))).toEqual({ commit: head, added: true });
    expect(readFileSync(w.anchors, "utf8")).toBe(`2026-11-14 ${head}\n`);
  });

  it("adds nothing when HEAD is already the last anchor, and a line for a new HEAD", () => {
    const w = world();
    recordAnchor(w.repo, w.anchors);
    expect(recordAnchor(w.repo, w.anchors).added).toBe(false);
    w.add('{"caseId":"FF-9003"}');
    expect(recordAnchor(w.repo, w.anchors).added).toBe(true);
    expect(readAnchors(w.anchors).anchors).toHaveLength(2);
  });

  it("starts a new line after a last anchor that has no line break, so two never run together (Qodo on PR 286)", () => {
    const w = world();
    writeFileSync(w.anchors, `2026-11-13 ${"a".repeat(40)}`);
    recordAnchor(w.repo, w.anchors);
    const { anchors, problems } = readAnchors(w.anchors);
    expect(problems).toEqual([]);
    expect(anchors.map((a) => a.commit)).toEqual(["a".repeat(40), sh(w.repo, "rev-parse", "HEAD")]);
  });

  it("refuses a folder that isn't the root of its own repository, and leaves the private repository as it was", () => {
    const w = world();
    const status = sh(w.repo, "status", "--porcelain", "--ignored");
    expect(() => recordAnchor(join(w.repo, "nope"), w.anchors)).toThrow();
    recordAnchor(w.repo, w.anchors);
    expect(sh(w.repo, "status", "--porcelain", "--ignored")).toBe(status);
  });
});

describe("anchorProblems (AUD-M11)", () => {
  it("passes a history that only grew after the anchor", () => {
    const w = world();
    recordAnchor(w.repo, w.anchors);
    w.add('{"caseId":"FF-9003"}');
    expect(anchorProblems(w.repo, w.anchors)).toEqual([]);
  });

  it("catches a squashed history that rewrote a line, which the commit-by-commit check can no longer see", () => {
    const w = world();
    recordAnchor(w.repo, w.anchors);
    writeFileSync(w.key, '{"caseId":"FF-9001","changed":true}\n{"caseId":"FF-9002"}\n');
    squash(w.repo);
    // The single commit only adds lines, so the history check alone passes it.
    expect(appendOnlyProblems(w.repo, "ground-truth.jsonl")).toEqual([]);
    expect(anchorProblems(w.repo, w.anchors)).toEqual([
      expect.stringMatching(/is not an ancestor of the private HEAD; was its history squashed or rewritten\?$/),
    ]);
  });

  it("catches a squash even with the same content, and an anchored commit the repository no longer holds", () => {
    const w = world();
    recordAnchor(w.repo, w.anchors);
    squash(w.repo);
    expect(anchorProblems(w.repo, w.anchors)).toHaveLength(1);
    writeFileSync(w.anchors, `2026-11-14 ${"e".repeat(40)}\n`);
    expect(anchorProblems(w.repo, w.anchors)).toEqual([
      expect.stringContaining("the private repository no longer holds that commit"),
    ]);
  });

  it("catches a file that is no longer what the anchored commit held, followed only by new lines", () => {
    const w = world();
    recordAnchor(w.repo, w.anchors);
    writeFileSync(w.key, '{"caseId":"FF-9001"}\n');
    expect(anchorProblems(w.repo, w.anchors)).toEqual([
      expect.stringContaining("ground-truth.jsonl then is not the start of ground-truth.jsonl today"),
    ]);
  });

  it("reports a missing anchors file, an empty one, and a line that isn't an anchor", () => {
    const w = world();
    expect(anchorProblems(w.repo, w.anchors)).toEqual([expect.stringContaining("no anchors file")]);
    writeFileSync(w.anchors, "");
    expect(anchorProblems(w.repo, w.anchors)).toEqual([expect.stringContaining("holds no anchor")]);
    const head = sh(w.repo, "rev-parse", "HEAD");
    writeFileSync(w.anchors, `2026-11-14 ${head}\n2026-11-14 ${head} 25 lines\n`);
    expect(anchorProblems(w.repo, w.anchors)).toEqual([
      expect.stringContaining('line 2 is not "YYYY-MM-DD <commit id>"'),
    ]);
  });

  it("is part of ledger:check when an anchors file is given", () => {
    const w = world();
    writeFileSync(join(w.repo, "audit-events.jsonl"), "");
    w.add('{"caseId":"FF-9003"}');
    recordAnchor(w.repo, w.anchors);
    const lab = labRepo(w.anchors);
    expect(ledgerCheckProblems(w.repo, w.anchors)).toEqual([]);
    squash(w.repo);
    expect(ledgerCheckProblems(w.repo, w.anchors).join("\n")).toContain("is not an ancestor of the private HEAD");
    expect(lab).toBeTruthy();
  });
});

/** Commits the anchors file in a public repository of its own, as this repository holds it. */
function labRepo(anchors: string): string {
  const lab = dirname(anchors);
  sh(lab, "init", "--quiet", "-b", "main");
  sh(lab, "config", "user.email", "test@example.com");
  sh(lab, "config", "user.name", "Test");
  sh(lab, "config", "core.autocrlf", "false");
  sh(lab, "add", basename(anchors));
  sh(lab, "commit", "--quiet", "-m", "anchor");
  return lab;
}

describe("anchorsFileProblems: an anchor can't be swapped for another (Qodo on PR 286)", () => {
  it("catches an anchor replaced by one naming a rewritten history, which the anchor check alone passes", () => {
    const w = world();
    recordAnchor(w.repo, w.anchors);
    labRepo(w.anchors);
    expect(anchorsFileProblems(w.anchors)).toEqual([]);
    writeFileSync(w.key, '{"caseId":"FF-9001","changed":true}\n{"caseId":"FF-9002"}\n');
    squash(w.repo);
    writeFileSync(w.anchors, `2026-11-14 ${sh(w.repo, "rev-parse", "HEAD")}\n`);
    expect(anchorProblems(w.repo, w.anchors)).toEqual([]);
    expect(anchorsFileProblems(w.anchors)).toEqual([expect.stringContaining("uncommitted changes removed or changed")]);
    sh(dirname(w.anchors), "commit", "--quiet", "-am", "swap");
    expect(anchorsFileProblems(w.anchors)).toEqual([expect.stringContaining("removed or changed a line")]);
  });

  it("passes a new anchor added after the last, committed or not, and refuses an anchors file never committed", () => {
    const w = world();
    recordAnchor(w.repo, w.anchors);
    expect(anchorsFileProblems(w.anchors)).toEqual([expect.stringContaining("not in a git repository")]);
    const lab = labRepo(w.anchors);
    w.add('{"caseId":"FF-9003"}');
    recordAnchor(w.repo, w.anchors);
    expect(anchorsFileProblems(w.anchors)).toEqual([]);
    const other = join(lab, "other-anchors.txt");
    writeFileSync(other, readFileSync(w.anchors, "utf8"));
    expect(anchorsFileProblems(other)).toEqual([expect.stringContaining("not committed")]);
    // Staged but never committed: no history to check it against (Qodo on PR 286).
    sh(lab, "add", "other-anchors.txt");
    expect(anchorsFileProblems(other)).toEqual([expect.stringContaining("not committed")]);
  });
});

describe("an anchors file whose last line has no line break (Qodo on PR 286)", () => {
  it("takes a new anchor on a line of its own, and the file still only grew, before and after the commit", () => {
    const w = world();
    recordAnchor(w.repo, w.anchors);
    writeFileSync(w.anchors, readFileSync(w.anchors, "utf8").trimEnd());
    const lab = labRepo(w.anchors);
    w.add('{"caseId":"FF-9003"}');
    recordAnchor(w.repo, w.anchors);
    expect(readAnchors(w.anchors)).toMatchObject({ problems: [], anchors: [{}, {}] });
    expect(anchorsFileProblems(w.anchors)).toEqual([]);
    sh(lab, "commit", "--quiet", "-am", "anchor");
    expect(anchorsFileProblems(w.anchors)).toEqual([]);
  });
});

describe("an anchors file replaced by a link (Qodo on PR 286)", () => {
  it("is refused, never followed to another file's anchors", (context) => {
    const w = world();
    recordAnchor(w.repo, w.anchors);
    const lab = labRepo(w.anchors);
    const other = join(lab, "other.txt");
    writeFileSync(other, readFileSync(w.anchors, "utf8"));
    sh(lab, "add", "other.txt");
    sh(lab, "commit", "--quiet", "-m", "other");
    rmSync(w.anchors);
    try {
      symlinkSync(other, w.anchors);
    } catch {
      context.skip(); // Windows without the right to make links: the link can't be made here, so can't be tested.
    }
    expect(anchorsFileProblems(w.anchors)).toEqual([expect.stringContaining("is a link")]);
  });
});
