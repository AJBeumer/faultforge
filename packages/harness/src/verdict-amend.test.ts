import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ledgerProblems, readAuditLog } from "./ledger.ts";
import { AMENDMENT_REASON, type AmendOptions, run } from "./verdict-amend.ts";

const COMMIT = "f".repeat(40);

/** Private storage with one judged case (FF-9300, PR 3) and one other case's verdict. */
function fixture(verdictExtra: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "verdict-amend-"));
  writeFileSync(
    join(root, "ground-truth.jsonl"),
    `${JSON.stringify({ caseId: "FF-9300", kind: "sabotage", templateId: "x-secret-v1", injectionCommit: COMMIT })}\n`,
  );
  const dir = join(root, "raw-artifacts", "reviews", "target-pr3");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${COMMIT.slice(0, 7)}.review.json`), JSON.stringify({ pr: 3, headSha: COMMIT }));
  const events = [
    { eventId: "pr", type: "pr.opened", caseId: "FF-9300", at: "2026-11-13T18:00:00.000Z", pr: 3 },
    {
      eventId: "v1",
      type: "case.adjudicated",
      caseId: "FF-9300",
      at: "2026-11-13T18:01:37.000Z",
      by: "Owner",
      disposition: "confirmed_detected",
      reason: "Finding names the injected lines and describes the leak.",
      judgements: [],
      ...verdictExtra,
    },
    {
      eventId: "v2",
      type: "case.adjudicated",
      caseId: "FF-9301",
      at: "2026-11-13T18:02:00.000Z",
      disposition: "confirmed_detected",
      reason: "Qodo named the off-by-one in the loop bound.",
    },
  ];
  writeFileSync(join(root, "audit-events.jsonl"), events.map((e) => `${JSON.stringify(e)}\n`).join(""));
  return root;
}

function answers(list: string[]) {
  let i = 0;
  return async () => list[i++] ?? "";
}

async function amend(root: string, extra: Partial<AmendOptions> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run("FF-9300", {
    env: { FAULTFORGE_PRIVATE_DIR: root },
    log: (l) => out.push(l),
    error: (l) => err.push(l),
    isTTY: true,
    ownerLogin: () => "Owner",
    now: () => "2026-11-15T09:00:00.000Z",
    ...extra,
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("verdict:amend (#250, AUD-H4)", () => {
  it("appends one amendment that adds a reason written later, and ledger:check accepts it", async () => {
    const root = fixture();
    const auditPath = join(root, "audit-events.jsonl");
    const before = readFileSync(auditPath, "utf8");
    const { code, err } = await amend(root, {
      ask: answers(["Qodo named the response that leaks the other user's booking"]),
    });
    expect(err).toBe("");
    expect(code).toBe(0);
    const after = readFileSync(auditPath, "utf8");
    expect(after.startsWith(before)).toBe(true);
    const added = JSON.parse(after.slice(before.length));
    expect(added).toEqual({
      kind: "amendment",
      amends: "v1",
      at: "2026-11-15T09:00:00.000Z",
      change: {
        amendedReason: "Qodo named the response that leaks the other user's booking",
        amendedReasonAt: "2026-11-15T09:00:00.000Z",
        amendedReasonBy: "Owner",
        amendedReasonWrittenLater: true,
      },
      reason: AMENDMENT_REASON,
      evidence: `raw-artifacts/reviews/target-pr3/${COMMIT.slice(0, 7)}.review.json`,
    });
    expect(ledgerProblems(auditPath)).toEqual([]);
    const verdict = readAuditLog(auditPath).find((e) => e.eventId === "v1");
    // The verdict itself is unchanged: same disposition, original reason kept, same time.
    expect(verdict).toMatchObject({
      disposition: "confirmed_detected",
      reason: "Finding names the injected lines and describes the leak.",
      at: "2026-11-13T18:01:37.000Z",
      amendedReasonWrittenLater: true,
    });
  });

  it("refuses the original reason or another case's, and writes nothing", async () => {
    const root = fixture();
    const before = readFileSync(join(root, "audit-events.jsonl"), "utf8");
    const { code, err } = await amend(root, {
      ask: answers([
        "finding names the injected lines and describes the leak",
        "Qodo named the off-by-one in the loop bound",
        "",
      ]),
    });
    expect(code).toBe(1);
    expect(err).toContain("no reason given");
    expect(readFileSync(join(root, "audit-events.jsonl"), "utf8")).toBe(before);
  });

  it("refuses a second amended reason for the same verdict", async () => {
    const root = fixture();
    appendFileSync(
      join(root, "audit-events.jsonl"),
      `${JSON.stringify({ kind: "amendment", amends: "v1", at: "2026-11-14T00:00:00.000Z", change: { amendedReason: "first" }, reason: "r", evidence: "e" })}\n`,
    );
    const { code, err } = await amend(root, { ask: answers(["second"]) });
    expect(code).toBe(1);
    expect(err).toContain("already has an amended reason");
  });

  it("prints with --dry-run and writes nothing; refuses without a terminal", async () => {
    const root = fixture();
    const before = readFileSync(join(root, "audit-events.jsonl"), "utf8");
    const dry = await amend(root, { dryRun: true, ask: answers(["a reason of its own"]) });
    expect(dry.code).toBe(0);
    expect(dry.out).toContain('"amendedReasonWrittenLater": true');
    expect((await amend(root, { isTTY: false })).code).toBe(1);
    expect(readFileSync(join(root, "audit-events.jsonl"), "utf8")).toBe(before);
  });

  it("exits 2 for a case with no verdict", async () => {
    const errors: string[] = [];
    const code = await run("FF-9399", {
      env: { FAULTFORGE_PRIVATE_DIR: fixture() },
      log: () => {},
      error: (l) => errors.push(l),
      isTTY: true,
    });
    expect(code).toBe(2);
    expect(errors.join("\n")).toContain("has no verdict");
  });
});
