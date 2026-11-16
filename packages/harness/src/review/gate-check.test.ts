import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type GateCheckDeps, run } from "./gate-check.ts";
import { savedReviewDir, savedReviewPath } from "./saved-review.ts";

const HEAD = "c".repeat(40);
const OLD = "d".repeat(40);
const ENV = { FAULTFORGE_PRIVATE_DIR: join("scratch", "private") };

/** Runs the command against saved reviews held in memory, keyed by the path the command would read. */
function check(argv: string[], saved: Record<string, unknown>, head: string | Error = HEAD) {
  const out: string[] = [];
  const errors: string[] = [];
  const files = new Map(
    Object.entries(saved).map(([sha, record]) => [
      savedReviewPath(savedReviewDir("faultforge", 12, ENV), sha),
      typeof record === "string" ? record : JSON.stringify(record),
    ]),
  );
  const deps: GateCheckDeps = {
    head: () => {
      if (head instanceof Error) throw head;
      return head;
    },
    read: (path) => files.get(path),
    out: (line) => out.push(line),
    error: (line) => errors.push(line),
  };
  return { code: run(argv, deps, ENV), out: out.join("\n"), errors: errors.join("\n") };
}

const complete = (openFindings: unknown[], headSha = HEAD) => ({ headSha, state: "complete", openFindings });

describe("gate:check", () => {
  it("exits 0 and lists the flagged findings when only informational ones are open", () => {
    const result = check(["faultforge", "12"], {
      [HEAD]: complete([{ severity: "informational", title: "A name could be clearer" }]),
    });
    expect(result.code).toBe(0);
    expect(result.out).toContain("Quality gate: MET");
    expect(result.out).toContain("[informational (Low)] A name could be clearer");
  });

  it("exits 1 when a remediation-recommended finding is open", () => {
    const result = check(["faultforge", "12"], {
      [HEAD]: complete([{ severity: "remediation_recommended", title: "Unread page" }]),
    });
    expect(result.code).toBe(1);
    expect(result.out).toContain("Quality gate: NOT MET");
    expect(result.out).toContain("[remediation_recommended (Medium)] Unread page");
  });

  it("exits 1 on an unknown label", () => {
    const result = check(["faultforge", "12"], { [HEAD]: complete([{ severity: "urgent", title: "?" }]) });
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/label the gate doesn't know \(urgent\)/);
  });

  it("exits 2, never 0, when only an older commit's review is saved", () => {
    const result = check(["faultforge", "12"], { [OLD]: complete([]) });
    expect(result.code).toBe(2);
    expect(result.errors).toMatch(/no saved review of ccccccc/);
    expect(result.errors).toContain(`npm run review:wait -- faultforge 12 --commit ${HEAD}`);
  });

  it("exits 1 when the file for the head holds a review of another commit", () => {
    const result = check(["faultforge", "12"], { [HEAD]: complete([], OLD) });
    expect(result.code).toBe(1);
    expect(result.out).toContain("the saved review is of ddddddd, not of ccccccc");
  });

  it("exits 1 for a review that didn't finish, even with nothing open", () => {
    const result = check(["faultforge", "12"], { [HEAD]: { ...complete([]), state: "review incomplete" } });
    expect(result.code).toBe(1);
    expect(result.out).toContain("didn't finish");
  });

  it("takes the commit from --commit without asking GitHub", () => {
    const result = check(["faultforge", "12", "--commit", HEAD], { [HEAD]: complete([]) }, new Error("offline"));
    expect(result.code).toBe(0);
  });

  it("exits 2 when it can't decide: bad arguments, GitHub unreachable, an unreadable record", () => {
    expect(check([], {}).code).toBe(2);
    expect(check(["nowhere", "12"], {}).code).toBe(2);
    expect(check(["faultforge", "0"], {}).code).toBe(2);
    expect(check(["faultforge", "12", "--commit", "abc"], {}).code).toBe(2);
    expect(check(["faultforge", "12", "--other", HEAD], {}).code).toBe(2);
    expect(check(["faultforge", "12", "--commit", HEAD, "extra"], {}).code).toBe(2);
    expect(check(["faultforge", "12"], {}, new Error("offline")).errors).toMatch(/couldn't read.*offline/);
    expect(check(["faultforge", "12"], {}, "not-a-sha").code).toBe(2);
    expect(check(["faultforge", "12"], { [HEAD]: "{not json" }).code).toBe(2);
  });
});
