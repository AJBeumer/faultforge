import { describe, expect, it } from "vitest";
import { claimMarker } from "./factory-comments.ts";
import { claimModeFrom, type RecoveryDeps, recoverStranded, STRANDED_COMMENT } from "./factory-recovery.ts";

const WORKING = "agent-working";
const READY = "ready-for-agent";
const HELP = "agent-needs-help";

/**
 * A fake GitHub holding each ticket's labels, so a test sees where a ticket ends up, not only which calls
 * were made. `relabel` adds before it removes, as `relabelWith` does, and either step can be made to fail.
 */
function world(
  tickets: Record<string, string[]>,
  opts: { addFails?: boolean; removeFails?: boolean; commentFails?: boolean; listFails?: string } = {},
) {
  const labels = new Map(Object.entries(tickets).map(([ref, l]) => [ref, new Set(l)]));
  const calls: string[] = [];
  const deps: RecoveryDeps = {
    labelled: (github, label) => {
      if (opts.listFails === github) throw new Error("HTTP 502");
      return [...labels.entries()]
        .filter(([ref, l]) => ref.startsWith(`${github}#`) && l.has(label))
        .map(([ref]) => ({ number: Number(ref.split("#")[1]), title: "t" }));
    },
    relabel: (github, number, remove, add) => {
      calls.push(`relabel ${github}#${number} -${remove.join(",")} +${add.join(",")}`);
      const l = labels.get(`${github}#${number}`) ?? new Set<string>();
      if (add.length && opts.addFails) return { removeFailed: null, addFailed: "403" };
      for (const a of add) l.add(a);
      if (remove.length && opts.removeFails) return { removeFailed: "403", addFailed: null };
      for (const r of remove) if (!add.includes(r)) l.delete(r);
      return { removeFailed: null, addFailed: null };
    },
    comment: (github, number) => {
      if (opts.commentFails) throw new Error("502");
      calls.push(`comment ${github}#${number}`);
    },
  };
  const on = (ref: string) => [...(labels.get(ref) ?? [])].sort();
  return {
    deps,
    calls,
    on,
    run: (repos = ["o/t"]) =>
      recoverStranded(
        repos.map((github) => ({ github })),
        deps,
      ),
  };
}

describe("recoverStranded (#197)", () => {
  it("moves a stranded ticket to needs-help: comment first, then the help label, then agent-working off", () => {
    const w = world({ "o/t#7": [WORKING] });
    expect(w.run()).toEqual({ recovered: ["o/t#7"], failed: [] });
    expect(w.calls).toEqual(["comment o/t#7", `relabel o/t#7 - +${HELP}`, `relabel o/t#7 -${WORKING},${READY} +`]);
    expect(w.on("o/t#7")).toEqual([HELP]);
  });

  it("leaves tickets that aren't agent-working alone", () => {
    const w = world({ "o/t#1": [READY], "o/t#2": [HELP], "o/t#3": [] });
    expect(w.run()).toEqual({ recovered: [], failed: [] });
    expect(w.calls).toEqual([]);
  });

  it("posts the plain stranded comment, with no word that would give the lab away", () => {
    expect(STRANDED_COMMENT).not.toMatch(/faultforge|ledger|planted|sabotage/i);
  });

  it("a repo it can't list is reported, and the next repo is still recovered", () => {
    const w = world({ "o/a#1": [WORKING], "o/b#2": [WORKING] }, { listFails: "o/a" });
    const result = w.run(["o/a", "o/b"]);
    expect(result.recovered).toEqual(["o/b#2"]);
    expect(result.failed).toEqual([expect.stringMatching(/^o\/a: couldn't list its tickets/)]);
  });
});

describe("recoverStranded: every failure leaves the ticket findable (Qodo on PR 211)", () => {
  it("keeps agent-working when the help label can't be added, so the next tick tries again", () => {
    const w = world({ "o/t#7": [WORKING] }, { addFails: true });
    expect(w.run()).toMatchObject({ recovered: [], failed: [expect.stringContaining("couldn't add")] });
    expect(w.on("o/t#7")).toEqual([WORKING]);
  });

  it("changes no label when the comment fails, so the notice is retried", () => {
    const w = world({ "o/t#7": [WORKING] }, { commentFails: true });
    expect(w.run().failed).toHaveLength(1);
    expect(w.calls).toEqual([]);
    expect(w.on("o/t#7")).toEqual([WORKING]);
  });

  it("retries only the removal for a ticket that already has the help label: no second comment", () => {
    const w = world({ "o/t#7": [WORKING, HELP] });
    expect(w.run().recovered).toEqual(["o/t#7"]);
    expect(w.calls).toEqual([`relabel o/t#7 -${WORKING},${READY} +`]);
    expect(w.on("o/t#7")).toEqual([HELP]);
  });

  it("reports a failed removal, so it isn't counted as recovered, and the ticket still carries a factory label", () => {
    const w = world({ "o/t#7": [WORKING] }, { removeFails: true });
    expect(w.run()).toMatchObject({ recovered: [], failed: [expect.stringContaining("couldn't remove")] });
    expect(w.on("o/t#7")).toEqual([HELP, WORKING]);
  });

  it("a second tick after a failed removal finishes the job without a second comment", () => {
    const tickets = { "o/t#7": [WORKING] };
    const first = world(tickets, { removeFails: true });
    first.run();
    const second = world({ "o/t#7": first.on("o/t#7") });
    expect(second.run().recovered).toEqual(["o/t#7"]);
    expect(second.calls.filter((c) => c.startsWith("comment"))).toEqual([]);
    expect(second.on("o/t#7")).toEqual([HELP]);
  });
});

describe("recoverStranded: a ticket the other way of running claimed is left alone (AUD-M19)", () => {
  it("skips a ticket whose claim came from the other mode, and still recovers its own and unmarked ones", () => {
    const w = world({ "o/t#1": [WORKING], "o/t#2": [WORKING], "o/t#3": [WORKING] });
    const claims: Record<number, "ci" | "local" | null> = { 1: "local", 2: "ci", 3: null };
    const deps: RecoveryDeps = { ...w.deps, mode: "ci", claimMode: (_github, number) => claims[number] ?? null };
    const result = recoverStranded([{ github: "o/t" }], deps);
    expect(result.recovered).toEqual(["o/t#2", "o/t#3"]);
    expect(result.otherMode).toEqual(["o/t#1 (claimed by a local run)"]);
    expect(w.on("o/t#1")).toEqual([WORKING]);
    expect(w.calls.some((c) => c.includes("#1"))).toBe(false);
  });

  it("a claim mode it can't read leaves the ticket for the next tick, reported", () => {
    const w = world({ "o/t#1": [WORKING] });
    const deps: RecoveryDeps = {
      ...w.deps,
      mode: "local",
      claimMode: () => {
        throw new Error("HTTP 502");
      },
    };
    const result = recoverStranded([{ github: "o/t" }], deps);
    expect(result.recovered).toEqual([]);
    expect(result.failed).toEqual(["o/t#1: HTTP 502"]);
    expect(w.on("o/t#1")).toEqual([WORKING]);
  });

  it("reads the mode from the latest claim the owner posted, never from someone else's comment", () => {
    const comments = [
      { body: `Picked up.\n\n${claimMarker("local")}`, user: { login: "Owner" } },
      { body: `Picked up again.\n\n${claimMarker("ci")}`, user: { login: "owner" } },
      { body: claimMarker("local"), user: { login: "stranger" } },
    ];
    expect(claimModeFrom(comments, "owner")).toBe("ci");
    expect(claimModeFrom([{ body: "no mark", user: { login: "owner" } }], "owner")).toBeNull();
  });
});

describe("recoverStranded: a ticket that already shows agent-done (Qodo on PR 262)", () => {
  it("only loses agent-working: its run finished, so no stranded comment and no help label", () => {
    const w = world({ "o/t#7": [WORKING, "agent-done"] });
    expect(w.run().recovered).toEqual(["o/t#7"]);
    expect(w.calls).toEqual([`relabel o/t#7 -${WORKING},${READY} +`]);
    expect(w.on("o/t#7")).toEqual(["agent-done"]);
  });
});
