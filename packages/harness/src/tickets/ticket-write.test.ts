import { describe, expect, it } from "vitest";
import type { Gh } from "../door/target-post.ts";
import { ExternalCallError } from "../shared/github.ts";
import { ticketWriter } from "./ticket-write.ts";

/** A fake lab gh and a fake door gh, each recording its calls. */
function fakes(doorFails?: Error) {
  const lab: string[][] = [];
  const door: { args: string[]; input?: string }[] = [];
  const doorGh: Gh = (args, input) => {
    door.push({ args, input });
    if (doorFails) throw doorFails;
    return "";
  };
  const gh = (...args: string[]) => {
    lab.push(args);
    return "";
  };
  return { lab, door, deps: { gh, door: doorGh, guardReviewed: ["Owner/app"] } };
}

describe("the runner's ticket writes (#345)", () => {
  it("sends a lab ticket's comment and labels with gh, as before", () => {
    const f = fakes();
    const w = ticketWriter([], f.deps);
    w.comment("Owner/lab", 3, "Picked up.");
    w.addLabels("Owner/lab", 3, ["agent-working"]);
    w.removeLabel("Owner/lab", 3, "ready-for-agent");
    expect(f.lab).toEqual([
      ["issue", "comment", "3", "--repo", "Owner/lab", "--body", "Picked up."],
      ["issue", "edit", "3", "--repo", "Owner/lab", "--add-label", "agent-working"],
      ["api", "-X", "DELETE", "repos/Owner/lab/issues/3/labels/ready-for-agent"],
    ]);
    expect(f.door).toEqual([]);
  });

  it("sends a repo on the guard's list through the door, whatever case it is spelled in, never with raw gh", () => {
    const f = fakes();
    const w = ticketWriter([], f.deps);
    w.comment("owner/APP", 3, "Picked up.");
    w.addLabels("Owner/app", 3, ["agent-working"]);
    w.removeLabel("Owner/app", 3, "ready-for-agent");
    expect(f.lab).toEqual([]);
    expect(f.door.map((c) => c.args.slice(0, 2))).toEqual([
      ["issue", "comment"],
      ["issue", "edit"],
      ["api", "--hostname"],
    ]);
  });

  it("sends a repo the config marks reviewed through the door too", () => {
    const f = fakes();
    ticketWriter(["Owner/other"], f.deps).comment("Owner/other", 3, "Picked up.");
    expect(f.lab).toEqual([]);
    expect(f.door).toHaveLength(1);
  });

  it("knows the target by the guard's own list when none is given", () => {
    const f = fakes();
    ticketWriter([], { gh: f.deps.gh, door: f.deps.door }).comment("AJBeumer/faultforge-target", 3, "Picked up.");
    expect(f.lab).toEqual([]);
    expect(f.door).toHaveLength(1);
  });

  it("lets the door's refusal through, sending nothing", () => {
    const f = fakes();
    expect(() => ticketWriter([], f.deps).comment("Owner/app", 3, "The planted bug")).toThrow(/refused/);
    expect(f.door).toEqual([]);
    expect(f.lab).toEqual([]);
  });

  it("turns a failed door send into gh's error shape, so a label already gone is still told apart", () => {
    const gone = Object.assign(new Error("Command failed"), { stderr: "gh: Label does not exist (HTTP 404)\n" });
    const f = fakes(gone);
    try {
      ticketWriter([], f.deps).removeLabel("Owner/app", 3, "ready-for-agent");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ExternalCallError);
      expect((error as ExternalCallError).stderr).toMatch(/HTTP 404/);
    }
  });
});
