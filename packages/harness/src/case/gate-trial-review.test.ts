import { describe, expect, it } from "vitest";
import { isErrorAnswer, readLocalReview } from "./gate-trial-review.ts";

const HIGH = {
  id: "f1",
  title: "A retry is refused",
  description: "The second call fails.",
  category: "Correctness",
  action_level: "action_required",
  location: { file_path: "src/a.ts", start_line: 23, end_line: 27, side: "right" },
};
const MEDIUM = {
  id: "f2",
  title: "No test",
  category: "Testability",
  action_level: "remediation_recommended",
  location: { file_path: "src/a.ts", start_line: 23, end_line: 26 },
};

/** An answer in the shape `qodo review --json` gives: findings with a `location`, and state lists of ids. */
function answer(extra: object = {}): Record<string, unknown> {
  return {
    findings: [HIGH, MEDIUM],
    finding_state: { complete: false, introduced: ["f1", "f2"], resolved: [], still_open: [], dismissed: [] },
    meta: { coverage: { complete: true }, skipped_files: [] },
    ...extra,
  };
}
const read = (payload: unknown, trace = "") => readLocalReview(`${JSON.stringify(payload)}${trace}`, "saved.json");
const ids = (payload: unknown) => read(payload).open.map((f) => f.id);

describe("readLocalReview", () => {
  it("reads every open finding with its label, file and lines, and where the answer was saved", () => {
    const review = read(answer());
    expect(review.complete).toBe(true);
    expect(review.evidence).toBe("saved.json");
    expect(review.open).toEqual([
      {
        id: "f1",
        severity: "action_required",
        title: "A retry is refused",
        category: "Correctness",
        file: "src/a.ts",
        lines: [23, 27],
        description: "The second call fails.",
      },
      {
        id: "f2",
        severity: "remediation_recommended",
        title: "No test",
        category: "Testability",
        file: "src/a.ts",
        lines: [23, 26],
        description: null,
      },
    ]);
  });

  it("reads an answer that ends with the CLI's trace line", () => {
    expect(read(answer(), "\n  trace 3a27381a47e9d9b7ec6cb123f79a30b8\n").open).toHaveLength(2);
  });

  it("passes on what the reviewer says about its finding inventory, and never guesses it", () => {
    expect(read(answer()).inventoryComplete).toBe(false);
    expect(read(answer({ finding_state: { complete: true } })).inventoryComplete).toBe(true);
    expect(read(answer({ finding_state: { complete: "yes" } })).inventoryComplete).toBe(false);
    expect(read(answer({ finding_state: undefined })).inventoryComplete).toBe(false);
  });

  it("leaves out a finding the answer lists as resolved or dismissed, by id or as a whole finding", () => {
    expect(ids(answer({ finding_state: { resolved: ["f1"], dismissed: [{ id: "f2" }] } }))).toEqual([]);
  });

  it("keeps a finding the answer lists as open, even when it also lists it as resolved", () => {
    expect(ids(answer({ finding_state: { still_open: ["f1"], resolved: ["f1", "f2"] } }))).toEqual(["f1"]);
    expect(ids(answer({ finding_state: { introduced: [{ id: "f2" }], dismissed: ["f2"] } }))).toEqual(["f1", "f2"]);
  });

  it("takes an open finding that only a state list holds, with its details", () => {
    const review = read(answer({ findings: [HIGH], finding_state: { still_open: [MEDIUM] } }));
    expect(review.open.map((f) => [f.id, f.severity])).toEqual([
      ["f1", "action_required"],
      ["f2", "remediation_recommended"],
    ]);
  });

  it("keeps an open id with no finding behind it, with no label, so the gate blocks on it", () => {
    const review = read(answer({ findings: [], finding_state: { still_open: ["ghost"] } }));
    expect(review.open).toEqual([
      { id: "ghost", severity: null, title: "A finding the review lists as open without its details" },
    ]);
  });

  it("keeps a finding with no label or no place: the gate decides what an unlabelled finding means", () => {
    const review = read(answer({ findings: [{ id: "f3", title: "Odd" }], finding_state: {} }));
    expect(review.open).toEqual([
      { id: "f3", severity: null, title: "Odd", category: null, file: null, lines: null, description: null },
    ]);
  });

  it("is incomplete, never clean, when coverage wasn't complete or a file was skipped", () => {
    expect(read(answer({ meta: { coverage: { complete: false } } })).complete).toBe(false);
    expect(read(answer({ meta: {} })).complete).toBe(false);
    expect(read(answer({ meta: { coverage: { complete: true }, skipped_files: ["src/b.ts"] } })).complete).toBe(false);
  });

  it("is incomplete with nothing open for an error answer, a missing findings list, or output that isn't JSON", () => {
    const none = { complete: false, inventoryComplete: false, open: [], evidence: "saved.json" };
    expect(read({ error: { message: "base commit is not pushed" } })).toEqual(none);
    expect(read({ meta: { coverage: { complete: true } } })).toEqual(none);
    expect(readLocalReview("", "saved.json")).toEqual(none);
    expect(readLocalReview("not json", "saved.json")).toEqual(none);
    expect(read(null)).toEqual(none);
  });

  it("is incomplete when a finding or a state list can't be read, so a broken entry never drops out silently", () => {
    expect(read(answer({ findings: [{ title: "No id" }] })).complete).toBe(false);
    expect(read(answer({ findings: ["text"] })).complete).toBe(false);
    expect(read(answer({ finding_state: { still_open: "f1" } })).complete).toBe(false);
    expect(read(answer({ finding_state: { resolved: [{ title: "no id" }] } })).complete).toBe(false);
    expect(read(answer({ finding_state: { dismissed: [7] } })).complete).toBe(false);
  });
});

describe("isErrorAnswer", () => {
  it("is true for an error or for output that isn't JSON, and false for any review, complete or not", () => {
    expect(isErrorAnswer(JSON.stringify({ error: { message: "the stream closed" } }))).toBe(true);
    expect(isErrorAnswer("")).toBe(true);
    expect(isErrorAnswer("null")).toBe(true);
    expect(isErrorAnswer(JSON.stringify(answer()))).toBe(false);
    expect(isErrorAnswer(JSON.stringify(answer({ meta: { coverage: { complete: false } } })))).toBe(false);
    expect(isErrorAnswer(`${JSON.stringify(answer())}\n  trace 3a27381a47e9d9b7ec6cb123f79a30b8\n`)).toBe(false);
  });
});
