import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { beatFile } from "./factory-lock.ts";
import { type DryRunDeps, describeLock, dryRun, main, type ProcessView } from "./factory-recover.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ff-recover-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const alive = (pids: number[], reused: number[] = []): ProcessView => ({
  isAlive: (pid) => pids.includes(pid),
  isSame: (pid) => !reused.includes(pid),
});

function lock(held: Record<string, unknown>, beat?: Record<string, unknown>) {
  writeFileSync(join(dir, "factory.lock"), JSON.stringify(held));
  if (beat) writeFileSync(beatFile(dir, String(held.token)), JSON.stringify(beat));
}

describe("describeLock: what a tick would do with the run lock, read only", () => {
  it("says a tick would take a lock nobody holds", () => {
    expect(describeLock(dir, alive([]))).toMatch(/^no tick holds the run lock/);
  });

  it("says a tick would wait for a live holder", () => {
    lock({ pid: 11, since: "2026-11-14T01:00:00Z", token: "t" }, { at: "2026-11-14T01:05:00Z" });
    expect(describeLock(dir, alive([11]))).toBe(
      "held by a live tick (pid 11, since 2026-11-14T01:00:00Z, last heartbeat 2026-11-14T01:05:00Z): a tick would wait",
    );
  });

  it("says a tick would take over a gone holder's lock, and end its agent first when that is still running", () => {
    lock({ pid: 11, token: "t" }, { at: "2026-11-14T01:05:00Z", agentPid: 22, agentStarted: "s" });
    const text = describeLock(dir, alive([22]));
    expect(text).toMatch(
      /^stale \(pid 11, last heartbeat 2026-11-14T01:05:00Z; its holder is gone\): a tick would take it over/,
    );
    expect(text).toContain("after ending its agent (pid 22)");
    expect(describeLock(dir, alive([]))).not.toContain("agent");
  });

  it("calls a holder whose pid now names another process stale", () => {
    lock({ pid: 11, started: "old", token: "t" });
    expect(describeLock(dir, alive([11], [11]))).toContain("its pid is now another process");
  });

  it("treats an unreadable lock as one a tick would take over", () => {
    writeFileSync(join(dir, "factory.lock"), "{not json");
    expect(describeLock(dir, alive([]))).toMatch(/can't be read.*take it over/);
    writeFileSync(join(dir, "factory.lock"), "null");
    expect(describeLock(dir, alive([]))).toMatch(/can't be read.*take it over/);
  });
});

describe("dryRun: the report, and never a write", () => {
  const deps = (labels: Record<string, string[]>, listFails = false): DryRunDeps & { lines: string[] } => {
    const lines: string[] = [];
    return {
      lines,
      repos: [{ github: "o/t" }],
      reads: {
        labelled: (_github, label) => {
          if (listFails) throw new Error("HTTP 502");
          return Object.entries(labels)
            .filter(([, l]) => l.includes(label))
            .map(([n]) => ({ number: Number(n), title: "t" }));
        },
        claimMode: () => null,
      },
      lockDir: dir,
      processes: alive([]),
      now: () => new Date("2026-11-14T02:00:00Z"),
      print: (line) => lines.push(line),
    };
  };

  it("lists what it would change and exits 0; a write would have thrown", () => {
    const d = deps({ 7: ["agent-working"], 8: ["ready-for-agent"] });
    expect(dryRun("local", d)).toBe(0);
    expect(d.lines[0]).toBe(
      "[factory:recover] dry run at 2026-11-14T02:00:00.000Z, as a local tick would see it; nothing is written",
    );
    expect(d.lines).toContain(
      "- o/t#7: would comment, add agent-needs-help, then remove agent-working and ready-for-agent",
    );
    expect(d.lines.join("\n")).not.toMatch(/a dry run never writes/);
  });

  it("says when there is nothing to recover", () => {
    const d = deps({});
    expect(dryRun("ci", d)).toBe(0);
    expect(d.lines).toContain("would change: nothing, no ticket of this mode is left agent-working");
    // In ci mode the lock line says it is only this machine's: an Actions tick keeps its lock on the runner.
    expect(d.lines).toContain(
      "run lock (this machine's lock only; an Actions tick keeps its own on the runner): no tick holds the run lock: a tick would take it",
    );
    const local = deps({});
    dryRun("local", local);
    expect(local.lines).toContain("run lock: no tick holds the run lock: a tick would take it");
  });

  it("exits 1 when a repo couldn't be read, so an incomplete report is never taken for a clean one", () => {
    const d = deps({}, true);
    expect(dryRun("local", d)).toBe(1);
    expect(d.lines.some((l) => l.startsWith("couldn't read: o/t:"))).toBe(true);
  });

  it("refuses to run without --dry-run, or with an unknown mode: there is no writing mode", () => {
    expect(main([])).toBe(2);
    expect(main(["--dry-run", "--mode", "both"])).toBe(2);
    expect(main(["--force"])).toBe(2);
  });
});
