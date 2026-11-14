import { describe, expect, it } from "vitest";
import { isLabelAlreadyGone, relabelWith } from "./factory-relabel.ts";
import { ExternalCallError } from "./github.ts";

describe("isLabelAlreadyGone (#107)", () => {
  it("swallows only gh's own 404 for a label that was never on the issue", () => {
    const gone = new ExternalCallError("gh api", {
      stderr: "gh: HTTP 404: Label does not exist (https://api.github.com/repos/o/r/issues/1/labels/x)\n",
    });
    expect(isLabelAlreadyGone(gone)).toBe(true);
  });

  it("reports a 401, a 403, a 404 that isn't about the label, and a timeout, instead of swallowing them", () => {
    const unauthorized = new ExternalCallError("gh api", { stderr: "gh: HTTP 401: Bad credentials (...)\n" });
    const forbidden = new ExternalCallError("gh api", { stderr: "gh: HTTP 403: Forbidden (...)\n" });
    const issueGone = new ExternalCallError("gh api", { stderr: "gh: HTTP 404: Not Found (...)\n" });
    const timedOut = new ExternalCallError("gh api", { code: "ETIMEDOUT" });
    expect(isLabelAlreadyGone(unauthorized)).toBe(false);
    expect(isLabelAlreadyGone(forbidden)).toBe(false);
    expect(isLabelAlreadyGone(issueGone)).toBe(false);
    expect(isLabelAlreadyGone(timedOut)).toBe(false);
    expect(isLabelAlreadyGone(new Error("plain"))).toBe(false);
  });
});

describe("relabelWith (#107, Qodo on PR 123)", () => {
  it("always adds, even when every removal failed, and reports nothing when it was just a missing label", () => {
    const added: string[][] = [];
    const gone = () => {
      throw new ExternalCallError("gh api", {
        stderr: "gh: HTTP 404: Label does not exist (...)\n",
      });
    };
    expect(relabelWith(["old"], ["new"], gone, (labels) => added.push(labels))).toEqual({
      removeFailed: null,
      addFailed: null,
    });
    expect(added).toEqual([["new"]]);
  });

  it("adds the new label, then still reports a 401 removal failure separately, never swallowing it", () => {
    const added: string[][] = [];
    const unauthorized = () => {
      throw new ExternalCallError("gh api", { stderr: "gh: HTTP 401: Bad credentials (...)\n" });
    };
    const result = relabelWith(["old"], ["new"], unauthorized, (labels) => added.push(labels));
    expect(added).toEqual([["new"]]);
    expect(result.removeFailed).toBeInstanceOf(ExternalCallError);
    expect((result.removeFailed as ExternalCallError).message).toMatch(/401/);
    expect(result.addFailed).toBeNull();
  });

  it("reports a failed add on its own, distinct from a failed removal: the caller must never confuse them", () => {
    const addBroke = new ExternalCallError("gh issue edit", { stderr: "gh: HTTP 500: Internal Server Error (...)\n" });
    const result = relabelWith(
      ["old"],
      ["new"],
      () => {},
      () => {
        throw addBroke;
      },
    );
    expect(result.removeFailed).toBeNull();
    expect(result.addFailed).toBe(addBroke);
  });

  it("adds nothing when there is nothing to add, and removes every label asked for", () => {
    const removed: string[] = [];
    const result = relabelWith(
      ["a", "b"],
      [],
      (label) => removed.push(label),
      () => {
        throw new Error("must not be called");
      },
    );
    expect(removed).toEqual(["a", "b"]);
    expect(result).toEqual({ removeFailed: null, addFailed: null });
  });
});

/** A ticket's labels, with GitHub's two calls: add some, remove one. Either can be made to fail. */
function labelsOn(start: string[], fail: { add?: boolean; remove?: boolean } = {}) {
  const labels = new Set(start);
  return {
    labels,
    removeOne: (label: string) => {
      if (fail.remove) throw new ExternalCallError("gh api", { stderr: "gh: HTTP 502: Bad Gateway (...)\n" });
      labels.delete(label);
    },
    addAll: (add: string[]) => {
      if (fail.add) throw new ExternalCallError("gh issue edit", { stderr: "gh: HTTP 502: Bad Gateway (...)\n" });
      for (const l of add) labels.add(l);
    },
  };
}

describe("relabelWith: add before remove, so a ticket never ends with no factory label (AUD-M19)", () => {
  it("a failed add leaves the old label in place and removes nothing", () => {
    const t = labelsOn(["ready-for-agent"], { add: true });
    const result = relabelWith(["ready-for-agent"], ["agent-working"], t.removeOne, t.addAll);
    expect(result.addFailed).toBeInstanceOf(ExternalCallError);
    expect([...t.labels]).toEqual(["ready-for-agent"]);
  });

  it("a good add then a good removal leaves exactly the new label", () => {
    const t = labelsOn(["agent-working", "ready-for-agent"]);
    expect(relabelWith(["agent-working", "ready-for-agent"], ["agent-done"], t.removeOne, t.addAll)).toEqual({
      removeFailed: null,
      addFailed: null,
    });
    expect([...t.labels]).toEqual(["agent-done"]);
  });

  it("a failed removal after a good add leaves both labels, never neither", () => {
    const t = labelsOn(["agent-working"], { remove: true });
    const result = relabelWith(["agent-working"], ["agent-needs-help"], t.removeOne, t.addAll);
    expect(result.removeFailed).toBeInstanceOf(ExternalCallError);
    expect([...t.labels].sort()).toEqual(["agent-needs-help", "agent-working"]);
  });

  it("never removes a label it was also asked to add", () => {
    const t = labelsOn(["agent-needs-help"]);
    relabelWith(["agent-needs-help", "ready-for-agent"], ["agent-needs-help"], t.removeOne, t.addAll);
    expect([...t.labels]).toEqual(["agent-needs-help"]);
  });
});
