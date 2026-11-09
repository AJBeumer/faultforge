import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseLog, summarize } from "./factory-timeline.ts";

const root = join(import.meta.dirname, "../../..");
const fixture = (name: string) =>
  parseLog(readFileSync(join(root, "private/raw-artifacts/factory-runs", `${name}.jsonl`), "utf8"));

describe("summarize", () => {
  it("sums up a finished run", () => {
    expect(summarize(fixture("20261109-093504-target-18"))).toBe(
      "Summary: label to result 14.3 min, waiting 9.1 min, agent 4.8 min, cost $1.62, 60 turns, 1 review round, outcome agent-done",
    );
  });

  it("sums up a refused run as waiting and the outcome, with no agent numbers", () => {
    const summary = summarize(fixture("20261109-094924-faultforge-71"));
    expect(summary).toBe("Summary: waiting 6.9 min, outcome refused");
    expect(summary).not.toMatch(/\b0 min\b|\$0\.00|\b0 turns\b/);
  });

  it("sums up a not-ready run the same way", () => {
    expect(summarize(fixture("20261109-082907-faultforge-66"))).toBe("Summary: waiting 0.2 min, outcome not-ready");
  });

  it("shows a missing value as n/a, never 0 or NaN", () => {
    const events = [
      { t: "2026-11-09T09:35:04.414Z", event: "picked", labelledAt: "2026-11-09T09:25:56Z" },
      { t: "2026-11-09T09:35:10.868Z", event: "agent-started" },
      // agent-finished has no costUsd or turns: the agent died before reporting them.
      { t: "2026-11-09T09:40:00.566Z", event: "agent-finished", costUsd: null, turns: null },
      { t: "2026-11-09T09:40:11.510Z", event: "finished", label: "agent-needs-help" },
    ];
    const summary = summarize(events);
    expect(summary).toBe(
      "Summary: label to result 14.3 min, waiting 9.1 min, agent 4.8 min, cost n/a, n/a turns, 0 review rounds, outcome agent-needs-help",
    );
    expect(summary).not.toMatch(/NaN|\$0\.00(?!\d)/);
  });

  it("counts every agent-step review-wait as a review round", () => {
    const events = [
      { t: "2026-11-09T09:00:00.000Z", event: "picked", labelledAt: "2026-11-09T08:00:00Z" },
      { t: "2026-11-09T09:00:01.000Z", event: "agent-started" },
      { t: "2026-11-09T09:00:02.000Z", event: "agent-step", step: "review-wait" },
      { t: "2026-11-09T09:00:03.000Z", event: "agent-step", step: "push" },
      { t: "2026-11-09T09:00:04.000Z", event: "agent-step", step: "review-wait" },
      { t: "2026-11-09T09:00:05.000Z", event: "agent-finished", costUsd: 2, turns: 10 },
      { t: "2026-11-09T09:00:06.000Z", event: "finished", label: "agent-done" },
    ];
    expect(summarize(events)).toMatch(/2 review rounds/);
  });
});
