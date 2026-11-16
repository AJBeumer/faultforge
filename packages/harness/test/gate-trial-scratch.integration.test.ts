/**
 * A gate trial's scratch copy, made for real from a small local repository: it sits at the commit asked
 * for, fetches from the address given, and can't push anywhere. Then one whole trial runs on it with a
 * stand-in reviewer and builder, to show the order of work holds on a real folder.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TrialReview } from "../src/case/gate-trial.ts";
import { makeScratch, NO_PUSH } from "../src/case/gate-trial-real.ts";
import { runTrial, type TrialIo, type TrialRecord } from "../src/case/gate-trial-run.ts";
import type { QualityGate } from "../src/shared/factory-config.ts";

const GATE: QualityGate = {
  fix: ["action_required", "remediation_recommended"],
  flag: ["informational"],
  maxRounds: 3,
};

describe("a gate trial's scratch copy", () => {
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

  /** A source repository with two commits and a bare repository that stands in for its public address. */
  function source() {
    root = mkdtempSync(join(tmpdir(), "gate-trial-scratch-"));
    const repo = join(root, "source");
    const publicAddress = join(root, "public.git");
    git(root, "init", "-q", "--bare", publicAddress);
    git(root, "init", "-q", repo);
    git(repo, "config", "user.email", "t@example.com");
    git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "limit.js"), "export const limit = 280;\n");
    git(repo, "add", "limit.js");
    git(repo, "commit", "-qm", "base");
    const base = git(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "limit.js"), "export const limit = 300;\n");
    git(repo, "commit", "-qam", "later");
    return { repo, publicAddress, base };
  }

  it("sits at the commit asked for, fetches from the address given, and refuses to push", () => {
    const { repo, publicAddress, base } = source();
    const app = makeScratch(root, repo, publicAddress, base, false);
    expect(git(app, "rev-parse", "HEAD")).toBe(base);
    // Trimmed: git may check the file out with this system's own line ending.
    expect(readFileSync(join(app, "limit.js"), "utf8").trim()).toBe("export const limit = 280;");
    expect(git(app, "remote", "get-url", "origin")).toBe(publicAddress);
    expect(git(app, "remote", "get-url", "--push", "origin")).toBe(NO_PUSH);
    // A push from the copy fails, and the address it was told to fetch from holds nothing afterwards.
    expect(() => git(app, "push", "origin", "HEAD:refs/heads/leak")).toThrow();
    expect(git(publicAddress, "for-each-ref")).toBe("");
    // The source checkout is untouched: still on its later commit, with no new branch.
    expect(git(repo, "rev-parse", "HEAD")).not.toBe(base);
    expect(git(repo, "branch", "--list").split("\n")).toHaveLength(1);
  });

  it("carries one whole trial on a real folder: change, review, fix, proofs, record", async () => {
    const { repo, publicAddress, base } = source();
    let app = "";
    let asCheckedOut = "";
    let saved: TrialRecord | undefined;
    const limitIs = (n: number) => readFileSync(join(app, "limit.js"), "utf8").includes(`limit = ${n};`);
    const reviews: TrialReview[] = [
      {
        complete: true,
        open: [{ id: "f1", severity: "remediation_recommended", title: "The limit was widened", file: "limit.js" }],
        evidence: "review-1",
      },
      { complete: true, open: [], evidence: "review-2" },
    ];
    const io: TrialIo = {
      prepare: async () => {
        app = makeScratch(root, repo, publicAddress, base, false);
        asCheckedOut = readFileSync(join(app, "limit.js"), "utf8");
        // The change under review, uncommitted: the limit widened tenfold.
        writeFileSync(join(app, "limit.js"), "export const limit = 2800;\n");
      },
      proofs: () => [{ invariantId: "INV-LIMIT", own: true }],
      // The stand-in proof reads the real file: it fails while the limit is the widened one.
      runProofs: async () => [limitIs(2800) ? "fail" : "pass"],
      review: async (round) => reviews[round - 1] as TrialReview,
      build: async (_round, _prompt, mustFix) => {
        // The fix puts the file back exactly as it was checked out, line ending included.
        writeFileSync(join(app, "limit.js"), asCheckedOut);
        return mustFix.map((f) => ({ id: f.id, decision: "fixed" as const }));
      },
      evidencePasses: async () => false,
      publicTests: async () => "pass",
      save: (record) => {
        saved = record;
      },
      log: () => {},
    };
    const facts = {
      caseId: "FF-9001",
      control: false,
      templateId: "made-up-v1",
      targetCommit: base,
      ticket: { url: "https://github.com/owner/app/issues/1", title: "Tidy the limit", body: "Keep it as it is." },
    };
    const record = await runTrial(facts, "saved", GATE, io);
    expect(record.status).toBe("done");
    expect(record.result).toBe("gate met, defect gone");
    expect(record.proofs).toEqual([{ invariantId: "INV-LIMIT", own: true, before: "fail", after: "pass" }]);
    expect(saved).toBe(record);
    // The fix was made in the scratch copy and never committed: its head is still the base, the tree is
    // back to it, and nothing reached the public address.
    expect(existsSync(join(app, "limit.js"))).toBe(true);
    expect(git(app, "rev-parse", "HEAD")).toBe(base);
    expect(git(app, "status", "--short")).toBe("");
    expect(git(publicAddress, "for-each-ref")).toBe("");
  });
});
