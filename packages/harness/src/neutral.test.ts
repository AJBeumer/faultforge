import { describe, expect, it } from "vitest";
import { telltales } from "./neutral.ts";

describe("telltales", () => {
  it.each([
    "Simplify replay lookup in createBooking",
    "tidy-replay-lookup",
    "Shorten README intro",
    "await app.inject(request)",
    "Clock and id generator are injected",
    "Normalize line endings to LF",
  ])("lets ordinary text through: %s", (text) => {
    expect(telltales(text)).toEqual([]);
  });

  it.each([
    ["FaultForge case", "names the lab"],
    ["Fix planted bug", "says planted"],
    ["injected bug in create.ts", "says a bug was injected"],
    ["Add mutation testing", "says mutation"],
    ["Update ledger", "mentions the ledger"],
    ["see the answer key", "mentions the answer key"],
    ["covered by the proof test", "mentions the hidden proof test"],
    ["closes FF-0002", "contains a case id"],
  ])("flags %s", (text, reason) => {
    expect(telltales(text)).toContain(reason);
  });

  it("allows the target repository's own name", () => {
    expect(telltales("faultforge-target")).toEqual([]);
  });
});
