import { describe, expect, it } from "vitest";
import type { EvidenceRow } from "./rules-evidence.ts";
import { findPatterns, newPatterns, proposalBody, proposalTitle, THRESHOLD } from "./rules-propose.ts";

const row = (overrides: Partial<EvidenceRow>): EvidenceRow => ({
  id: "00000000-0000-4000-8000-000000000000",
  repo: "faultforge",
  github: "AJBeumer/faultforge",
  pr: 59,
  firstSeenCommit: "aaa1111",
  file: "packages/harness/src/review-wait.ts",
  lines: [1, 2],
  title: "A finding",
  category: "Correctness",
  severity: "remediation_recommended",
  description: null,
  reviewDepth: "standard",
  recordedAt: "2026-11-06T18:00:00Z",
  openAtLastReview: false,
  ...overrides,
});

describe("findPatterns", () => {
  it("finds a pattern at the threshold: same repo and category, enough findings over enough PRs", () => {
    const rows = [
      row({ id: "a", pr: 59 }),
      row({ id: "b", pr: 60 }),
      row({ id: "c", pr: 60 }),
      row({ id: "d", pr: 61, category: "Security" }),
    ];
    const patterns = findPatterns(rows);
    expect(patterns).toHaveLength(1);
    expect(patterns[0]).toMatchObject({ repo: "faultforge", category: "Correctness", prs: [59, 60] });
    expect(patterns[0]?.findings.map((f) => f.id)).toEqual(["a", "b", "c"]);
  });

  it("finds nothing under the threshold: too few findings, or all on one PR", () => {
    const twoFindings = [row({ id: "a", pr: 59 }), row({ id: "b", pr: 60 })];
    expect(findPatterns(twoFindings)).toEqual([]);
    const onePr = [row({ id: "a" }), row({ id: "b" }), row({ id: "c" })];
    expect(findPatterns(onePr)).toEqual([]);
  });

  it("keeps repos apart: the same category in two repos is two counts, not one", () => {
    const rows = [
      row({ id: "a", pr: 59 }),
      row({ id: "b", pr: 60 }),
      row({ id: "c", pr: 6, repo: "target", github: "AJBeumer/faultforge-target" }),
    ];
    expect(findPatterns(rows)).toEqual([]);
  });
});

describe("newPatterns", () => {
  it("drops a pattern whose proposal ticket already exists, open or closed", () => {
    const pattern = findPatterns([row({ id: "a", pr: 59 }), row({ id: "b", pr: 60 }), row({ id: "c", pr: 61 })]);
    expect(newPatterns(pattern, [proposalTitle(pattern[0] as never)])).toEqual([]);
    expect(newPatterns(pattern, ["Some other ticket"])).toEqual(pattern);
  });
});

describe("propose", () => {
  it("opens one ticket per new pattern, and nothing when every pattern is known", async () => {
    const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { propose } = await import("./rules-propose.ts");

    const dir = mkdtempSync(join(tmpdir(), "ff-propose-"));
    try {
      mkdirSync(join(dir, "private", "raw-artifacts", "reviews", "faultforge-pr59"), { recursive: true });
      mkdirSync(join(dir, "private", "cases"), { recursive: true });
      writeFileSync(join(dir, "private", "ground-truth.jsonl"), "");
      const findings = ["a", "b", "c"].map((id, at) => ({
        id,
        file: "src/x.ts",
        lines: [1, 2],
        severity: "remediation_recommended",
        category: "Correctness",
        title: `Slip ${at}`,
        description: null,
      }));
      for (const [at, pr] of [59, 60].entries()) {
        mkdirSync(join(dir, "private", "raw-artifacts", "reviews", `faultforge-pr${pr}`), { recursive: true });
        writeFileSync(
          join(dir, "private", "raw-artifacts", "reviews", `faultforge-pr${pr}`, "aaa.review.json"),
          JSON.stringify({
            repo: "AJBeumer/faultforge",
            pr,
            headSha: `sha${pr}`,
            state: "complete",
            recordedAt: `2026-11-06T18:0${at}:00Z`,
            findings: at === 0 ? findings.slice(0, 2) : findings.slice(2),
            openFindings: [],
          }),
        );
      }
      const factory = {
        evidence: "private/raw-artifacts",
        repos: {
          faultforge: { github: "AJBeumer/faultforge", guard: "lab" },
          target: { github: "AJBeumer/faultforge-target", guard: "reviewed" },
        },
      } as never;

      const ghCalls: string[][] = [];
      const fakeGh = (...args: string[]) => {
        ghCalls.push(args);
        return "https://github.com/AJBeumer/faultforge/issues/999\n";
      };
      const lines: string[] = [];
      const result = propose(
        factory,
        dir,
        { open: true },
        fakeGh,
        () => [],
        (l) => lines.push(l),
      );
      expect(result.opened).toEqual(["https://github.com/AJBeumer/faultforge/issues/999"]);
      expect(ghCalls[0]).toContain("rule-proposal");

      const known = propose(
        factory,
        dir,
        { open: true },
        fakeGh,
        () => ["Rule proposal: repeated Correctness findings in faultforge reviews"],
        (l) => lines.push(l),
      );
      expect(known.opened).toEqual([]);
      expect(lines.join("\n")).toContain("already has its proposal ticket");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("proposalBody", () => {
  it("links PRs in this repo, names reviewed-repo PRs as plain text, and quotes the threshold", () => {
    const pattern = {
      repo: "target",
      category: "Correctness",
      prs: [6, 16],
      findings: [
        row({ id: "t1", pr: 6, repo: "target", github: "AJBeumer/faultforge-target", title: "Target slip" }),
        row({ id: "t2", pr: 16, repo: "target", github: "AJBeumer/faultforge-target", title: "Another" }),
        row({ id: "f1", pr: 59, title: "Lab slip" }),
      ],
    };
    const body = proposalBody(pattern, "AJBeumer/faultforge");
    expect(body).toContain("| target 6 |");
    expect(body).toContain("| target 16 |");
    expect(body).toContain("| #59 |");
    expect(body).not.toContain("faultforge-target#");
    expect(body).not.toContain("github.com/AJBeumer/faultforge-target");
    expect(body).toContain(`threshold: ${THRESHOLD.findings} findings over ${THRESHOLD.prs} PRs`);
    expect(body).toContain("rule-pattern: target/Correctness");
  });
});
