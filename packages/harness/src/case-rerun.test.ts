import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCliArgs, RERUN_REASON, type RerunArgs, run } from "./case-rerun.ts";
import { ledgerProblems, readLedger } from "./ledger.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);

/** An answer key with two bug cases on one template, a third on another, and a control. */
function fixture(extra: object[] = []) {
  const root = mkdtempSync(join(tmpdir(), "case-rerun-"));
  const lines = [
    { caseId: "FF-9601", kind: "sabotage", templateId: "x-secret-v1", injectionCommit: A },
    { caseId: "FF-9602", kind: "sabotage", templateId: "x-secret-v1", injectionCommit: B },
    { caseId: "FF-9603", kind: "sabotage", templateId: "x-other-v1", injectionCommit: B },
    { caseId: "FF-9604", kind: "control", templateId: "x-secret-v1", injectionCommit: B },
    ...extra,
  ];
  writeFileSync(join(root, "ground-truth.jsonl"), lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
  return root;
}

function rerun(root: string, args: Partial<RerunArgs> = {}, trees: Record<string, string> = { [A]: "t1", [B]: "t1" }) {
  const err: string[] = [];
  const out: string[] = [];
  const code = run(
    { caseId: "FF-9602", of: "FF-9601", dryRun: false, ...args },
    {
      env: { FAULTFORGE_PRIVATE_DIR: root },
      log: (l) => out.push(l),
      error: (l) => err.push(l),
      treeOf: (commit) => {
        const tree = trees[commit];
        if (!tree) throw new Error(`no such commit ${commit}`);
        return tree;
      },
      now: () => "2026-11-14T03:00:00.000Z",
    },
  );
  return { code, err: err.join("\n"), out: out.join("\n") };
}

describe("case:rerun (AUD-M13)", () => {
  it("appends one amendment marking the rerun, keeps every line, and ledger:check accepts it", () => {
    const root = fixture();
    const path = join(root, "ground-truth.jsonl");
    const before = readFileSync(path, "utf8");
    expect(rerun(root).code).toBe(0);
    const after = readFileSync(path, "utf8");
    expect(after.startsWith(before)).toBe(true);
    expect(JSON.parse(after.slice(before.length))).toEqual({
      kind: "amendment",
      amends: "FF-9602",
      at: "2026-11-14T03:00:00.000Z",
      change: { rerunOf: "FF-9601" },
      reason: RERUN_REASON,
      evidence: `target commits ${B} and ${A} both hold tree t1`,
    });
    expect(ledgerProblems(path)).toEqual([]);
    expect(readLedger(path).find((e) => e.caseId === "FF-9602")).toMatchObject({ rerunOf: "FF-9601" });
  });

  it("refuses different trees, different templates, a control, itself, a missing case, and writes nothing", () => {
    const root = fixture();
    const path = join(root, "ground-truth.jsonl");
    const before = readFileSync(path, "utf8");
    expect(rerun(root, {}, { [A]: "t1", [B]: "t2" }).err).toContain("different trees");
    expect(rerun(root, { caseId: "FF-9603" }).err).toContain("planted x-other-v1");
    expect(rerun(root, { caseId: "FF-9604" }).err).toContain("not a bug case");
    expect(rerun(root, { caseId: "FF-9601" }).err).toContain("rerun of itself");
    expect(rerun(root, { of: "FF-9699" }).code).toBe(1);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("refuses a case already marked, and a rerun of a rerun", () => {
    const marked = { kind: "amendment", amends: "FF-9602", change: { rerunOf: "FF-9601" }, reason: "r", evidence: "e" };
    const root = fixture([marked]);
    expect(rerun(root).err).toContain("already marked");
    expect(rerun(root, { caseId: "FF-9603", of: "FF-9602" }).err).toContain("is itself a rerun");
  });

  it("exits 2 when git can't read a commit, and prints with --dry-run", () => {
    expect(rerun(fixture(), {}, {}).code).toBe(2);
    const root = fixture();
    const before = readFileSync(join(root, "ground-truth.jsonl"), "utf8");
    const dry = rerun(root, { dryRun: true });
    expect(dry.code).toBe(0);
    expect(dry.out).toContain('"rerunOf": "FF-9601"');
    expect(readFileSync(join(root, "ground-truth.jsonl"), "utf8")).toBe(before);
  });

  it("reads its command line", () => {
    expect(parseCliArgs(["FF-9602", "--of", "FF-9601"])).toEqual({ caseId: "FF-9602", of: "FF-9601", dryRun: false });
    expect(parseCliArgs(["FF-9602"])).toBeNull();
    expect(parseCliArgs(["FF-96", "--of", "FF-9601"])).toBeNull();
  });
});
