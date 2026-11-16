import { dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type GateCheckDeps, run } from "./gate-check.ts";
import { savedReviewPath, waitSaveDir } from "./saved-review.ts";

const HEAD = "c".repeat(40);
const OLD = "d".repeat(40);

/** Runs the command against saved reviews held in memory, keyed by the path the command would read. */
function check(argv: string[], saved: Record<string, unknown>, head: string | Error = HEAD, listFails = false) {
  const out: string[] = [];
  const errors: string[] = [];
  const dir = waitSaveDir("faultforge", 12);
  const files = new Map(
    Object.entries(saved).map(([sha, record]) => [
      savedReviewPath(dir, sha),
      typeof record === "string" ? record : JSON.stringify(record),
    ]),
  );
  const deps: GateCheckDeps = {
    head: () => {
      if (head instanceof Error) throw head;
      return head;
    },
    read: (path) => files.get(path),
    readAll: (folder) => {
      if (listFails) throw new Error("the folder can't be listed");
      return [...files].filter(([path]) => dirname(path) === folder).map(([, text]) => text);
    },
    out: (line) => out.push(line),
    error: (line) => errors.push(line),
  };
  return { code: run(argv, deps), out: out.join("\n"), errors: errors.join("\n") };
}

const complete = (openFindings: unknown[], headSha = HEAD, extra: object = {}) => ({
  headSha,
  state: "complete",
  // The head's review is the newer save unless a test says otherwise.
  recordedAt: headSha === HEAD ? "2026-11-16T10:30:00.000Z" : "2026-11-16T10:10:00.000Z",
  openFindings,
  ...extra,
});

describe("gate:check", () => {
  const savedEnv = process.env.FAULTFORGE_PRIVATE_DIR;
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.FAULTFORGE_PRIVATE_DIR;
    else process.env.FAULTFORGE_PRIVATE_DIR = savedEnv;
  });

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

  it("lists as closed a finding an earlier save of the pull request held and the head's review no longer has open", () => {
    const fixed = { id: "f1", severity: "remediation_recommended", title: "Unread page" };
    const low = { id: "f2", severity: "informational", title: "A name" };
    const result = check(["faultforge", "12"], {
      [OLD]: { ...complete([fixed, low], OLD), findings: [fixed, low] },
      [HEAD]: { ...complete([low]), findings: [] },
    });
    expect(result.code).toBe(0);
    expect(result.out).toContain(
      "Closed since an earlier review of this pull request:\n  - [remediation_recommended (Medium)] Unread page",
    );
    expect(result.out).not.toMatch(/Closed since[\s\S]*A name/);
  });

  it("says none are closed when the head's review is the only save, even if it lists findings it closed itself", () => {
    const closedThere = { id: "f9", severity: "action_required", title: "Dismissed on this commit" };
    const result = check(["faultforge", "12"], { [HEAD]: { ...complete([]), findings: [closedThere] } });
    expect(result.code).toBe(0);
    expect(result.out).toContain("Closed since an earlier review of this pull request: none");
  });

  it("never lists as closed a finding first raised on a later commit than the one checked", () => {
    const later = { id: "f3", severity: "remediation_recommended", title: "Raised afterwards" };
    const result = check(["faultforge", "12", "--commit", OLD], {
      [OLD]: complete([], OLD),
      [HEAD]: complete([later]),
    });
    expect(result.code).toBe(0);
    expect(result.out).not.toContain("Raised afterwards");
  });

  it("still gives its verdict when an old save can't be read or the folder can't be listed", () => {
    const unreadable = check(["faultforge", "12"], { [HEAD]: complete([]), [OLD]: "{not json" });
    expect(unreadable.code).toBe(0);
    expect(unreadable.out).toContain("Quality gate: MET");
    const unlisted = check(["faultforge", "12"], { [HEAD]: complete([]) }, HEAD, true);
    expect(unlisted.code).toBe(0);
    expect(unlisted.out).toContain("Closed since an earlier review of this pull request: none");
  });

  it("holds a save that records its rounds to the gate's limit, and still judges one that doesn't", () => {
    const over = check(["faultforge", "12"], { [HEAD]: complete([], HEAD, { reviewRounds: 4 }) });
    expect(over.code).toBe(1);
    expect(over.out).toContain("4 review rounds have run on the pull request, more than the gate's 3");
    const old = check(["faultforge", "12"], { [HEAD]: complete([]) });
    expect(old.code).toBe(0);
    expect(old.out).toContain("Review rounds: not recorded in this save");
  });

  it("looks where review:wait saves, whatever FAULTFORGE_PRIVATE_DIR says", () => {
    const before = waitSaveDir("faultforge", 12);
    process.env.FAULTFORGE_PRIVATE_DIR = "/somewhere/else";
    expect(waitSaveDir("faultforge", 12)).toBe(before);
    // The save is keyed by the folder computed before the variable was set: the command still finds it.
    const result = check(["faultforge", "12"], { [HEAD]: complete([]) });
    expect(result.code).toBe(0);
    expect(result.out).toContain(savedReviewPath(before, HEAD));
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
