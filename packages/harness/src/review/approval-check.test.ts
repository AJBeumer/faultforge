import { describe, expect, it } from "vitest";
import { loadFactory } from "../shared/factory-config.ts";
import {
  type ApprovalCheckDeps,
  type Check,
  ciGreen,
  type LabelEvent,
  MAX_LISTED_FILES,
  type PrView,
  run,
} from "./approval-check.ts";

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
const repo = loadFactory().repos.faultforge;
const JOBS = repo?.ciJobs ?? [];
const LABEL = repo?.approval?.label ?? "";
const ACTOR = repo?.approval?.actor ?? "";
const STARTED = "2026-11-23T12:00:00Z";
const green: Check[] = JOBS.map((name) => ({ name, status: "COMPLETED", conclusion: "SUCCESS" }));
const added = (login: string, at: string): LabelEvent => ({
  event: "labeled",
  label: { name: LABEL },
  actor: { login },
  created_at: at,
});

function harness(opts: {
  labelled?: boolean;
  files?: string[];
  review?: object | null;
  checks?: Check[];
  events?: LabelEvent[];
}) {
  const out: string[] = [];
  const err: string[] = [];
  const view: PrView = {
    headRefOid: HEAD,
    labels: opts.labelled ? [{ name: LABEL }] : [],
    statusCheckRollup: opts.checks ?? green,
  };
  const review =
    opts.review === undefined
      ? { headSha: HEAD, state: "complete", openFindings: [], reviewRounds: 1, reviewStartedAt: STARTED }
      : opts.review;
  const deps: ApprovalCheckDeps = {
    view: () => view,
    files: () => opts.files ?? ["packages/harness/src/x.ts"],
    timeline: () => opts.events ?? (opts.labelled ? [added(ACTOR, "2026-11-23T12:05:00Z")] : []),
    read: () => (review === null ? undefined : JSON.stringify(review)),
    out: (l) => out.push(l),
    error: (l) => err.push(l),
  };
  return { deps, out, err };
}

describe("approval:check", () => {
  it("verifies a label Qodo's app added after reviewing the head, which the review, the gate and CI back", () => {
    const h = harness({ labelled: true });
    expect(run(["faultforge", "5"], h.deps)).toBe(0);
    expect(h.out.join("\n")).toMatch(new RegExp(`12:05:00Z {2}labeled by ${ACTOR.replace(/[[\]]/g, "\\$&")}`));
    expect(h.out.join("\n")).toMatch(/verdict: approved-verified/);
  });

  it("calls a label left on after a push to an unreviewed head a disagreement", () => {
    const h = harness({ labelled: true, review: { headSha: OLD, state: "complete", openFindings: [] } });
    expect(run(["faultforge", "5"], h.deps)).toBe(3);
  });

  it("calls a label on a skipped review a disagreement", () => {
    const h = harness({
      labelled: true,
      review: { headSha: HEAD, state: "skipped by Qodo", openFindings: [], reviewStartedAt: STARTED },
    });
    expect(run(["faultforge", "5"], h.deps)).toBe(3);
  });

  // Proof test for the review finding "Manually added labels appear verified" (certificate issued).
  it("does not verify a label a person added by hand", () => {
    const h = harness({ labelled: true, events: [added("some-person", "2026-11-23T20:00:00Z")] });
    expect(run(["faultforge", "5"], h.deps)).toBe(3);
    expect(h.out.join("\n")).toMatch(/added by some-person/);
  });

  // Proof test for the review finding "An old-head label can appear current" (certificate issued).
  it("does not verify a label added before Qodo began reviewing the current head", () => {
    const h = harness({ labelled: true, events: [added(ACTOR, "2026-11-23T10:00:00Z")] });
    expect(run(["faultforge", "5"], h.deps)).toBe(3);
    expect(h.out.join("\n")).toMatch(/belongs to an older head/);
  });

  // Proof test for the review finding "Large pull requests can bypass the guard" (certificate issued).
  it("refuses a pull request with more files than GitHub lists, since a guarded one may be missing", () => {
    const files = Array.from({ length: MAX_LISTED_FILES }, (_, i) => `src/f${i}.ts`);
    const h = harness({ labelled: true, files });
    expect(run(["faultforge", "5"], h.deps)).toBe(2);
    expect(run(["faultforge", "5", "--predict"], h.deps)).toBe(2);
  });

  it("reads past 100 files, so a guarded file further down still holds the PR", () => {
    const files = [...Array.from({ length: 150 }, (_, i) => `src/f${i}.ts`), ".claude/hooks/a.ts"];
    const h = harness({ labelled: true, files });
    expect(run(["faultforge", "5"], h.deps)).toBe(3);
  });

  it("holds a clean, unlabelled guarded PR for a person", () => {
    const h = harness({ files: [".claude/hooks/a.ts"] });
    expect(run(["faultforge", "5"], h.deps)).toBe(1);
    expect(h.out.join("\n")).toMatch(/verdict: held-for-human/);
  });

  it("calls an unlabelled PR with a Medium finding not eligible", () => {
    const h = harness({
      review: { headSha: HEAD, state: "complete", openFindings: [{ severity: "remediation_recommended" }] },
    });
    expect(run(["faultforge", "5"], h.deps)).toBe(1);
    expect(h.out.join("\n")).toMatch(/verdict: not-eligible/);
  });

  it("calls a missing label on an eligible head a disagreement", () => {
    expect(run(["faultforge", "5"], harness({}).deps)).toBe(3);
  });

  it("predicts from the changed files alone, before any review", () => {
    const h = harness({ files: ["src/a.ts", ".claude/hooks/b.ts"], review: null });
    expect(run(["faultforge", "5", "--predict"], h.deps)).toBe(0);
    expect(h.out.join("\n")).toMatch(/prediction: held-for-human/);
    const clean = harness({ review: null });
    expect(run(["faultforge", "5", "--predict"], clean.deps)).toBe(0);
    expect(clean.out.join("\n")).toMatch(/prediction: eligible-if-clean/);
  });

  it("can't decide without a saved review, a known repo or a good argument", () => {
    const h = harness({ review: null });
    expect(run(["faultforge", "5"], h.deps)).toBe(2);
    expect(h.err.join("\n")).toMatch(/review:wait/);
    expect(run(["nope", "5"], h.deps)).toBe(2);
    expect(run(["faultforge", "5", "--other"], h.deps)).toBe(2);
    expect(run(["target", "5"], h.deps)).toBe(2);
  });
});

describe("CI green", () => {
  it("needs every required job to pass, and no check to fail", () => {
    expect(ciGreen(green, JOBS)).toBe(true);
    expect(ciGreen(green.slice(1), JOBS)).toBe(false);
    expect(ciGreen([...green, { name: "other", status: "COMPLETED", conclusion: "FAILURE" }], JOBS)).toBe(false);
    expect(ciGreen([{ ...green[0], status: "IN_PROGRESS", conclusion: "" }, ...green.slice(1)], JOBS)).toBe(false);
    expect(ciGreen(green, [])).toBe(false);
  });

  // Proof test for the review finding "Skipped required jobs pass approval" (certificate issued).
  it("does not count a required job that was skipped or neutral, while an optional one may be", () => {
    const [first, ...rest] = green;
    expect(ciGreen([{ ...first, conclusion: "SKIPPED" }, ...rest], JOBS)).toBe(false);
    expect(ciGreen([{ ...first, conclusion: "NEUTRAL" }, ...rest], JOBS)).toBe(false);
    expect(ciGreen([...green, { name: "optional", status: "COMPLETED", conclusion: "SKIPPED" }], JOBS)).toBe(true);
  });
});
