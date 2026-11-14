import { describe, expect, it } from "vitest";
import { unsavedFiles, wasSaved } from "./factory-keep.ts";

const line = (event: string) => JSON.stringify({ t: "2026-11-14T00:00:00Z", event });
const log = (...events: string[]) => events.map(line).join("\n");

describe("factory:keep: which runs a cancelled or crashed CI tick left unsaved (AUD-M19)", () => {
  it("a log whose saved event came after its outcome is saved", () => {
    expect(wasSaved(log("picked", "claimed", "finished", "saved", "cleanup"))).toBe(true);
    expect(wasSaved(log("picked", "refused", "saved"))).toBe(true);
    expect(wasSaved(log("picked", "finished", "saved", "kept"))).toBe(true);
  });

  it("a log cut off mid-run, or with anything after its last copy, is not", () => {
    expect(wasSaved(log("picked", "claimed", "agent-started"))).toBe(false);
    // The first copy's run went on: an error after it means the saved copy is not the whole story.
    expect(wasSaved(log("picked", "finished", "saved", "error"))).toBe(false);
    expect(wasSaved(`${log("picked", "agent-started")}\n{"t":"2026-11-14T00:0`)).toBe(false);
  });

  it("keeps each unsaved run's log and its transcript, and nothing of a saved run", () => {
    const files: Record<string, string> = {
      "a.jsonl": log("picked", "agent-started"),
      "a.agent.jsonl": "{}",
      "b.jsonl": log("picked", "finished", "saved"),
      "b.agent.jsonl": "{}",
      "c.jsonl": log("picked", "error"),
      "qodo-check-x": "",
    };
    expect(unsavedFiles(Object.keys(files), (name) => files[name] ?? "")).toEqual([
      "a.jsonl",
      "a.agent.jsonl",
      "c.jsonl",
    ]);
  });
});
