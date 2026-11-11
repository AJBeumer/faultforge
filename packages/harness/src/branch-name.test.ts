import { describe, expect, it } from "vitest";
import { type BranchExistence, deriveBranchName } from "./branch-name.ts";
import { telltales } from "./neutral.ts";

function fakeGit(local: string[], origin: string[]): BranchExistence {
  return {
    existsLocally: (name) => local.includes(name),
    existsOnOrigin: (name) => origin.includes(name),
  };
}

describe("deriveBranchName", () => {
  it("uses the base name on a first run, when nothing takes it", () => {
    expect(deriveBranchName("tidy-replay-lookup", fakeGit([], []))).toBe("tidy-replay-lookup");
  });

  it("falls back to -2 when the base name is taken locally", () => {
    expect(deriveBranchName("tidy-replay-lookup", fakeGit(["tidy-replay-lookup"], []))).toBe("tidy-replay-lookup-2");
  });

  it("falls back to -3 when the base name and -2 are both taken on origin", () => {
    expect(deriveBranchName("tidy-replay-lookup", fakeGit([], ["tidy-replay-lookup", "tidy-replay-lookup-2"]))).toBe(
      "tidy-replay-lookup-3",
    );
  });

  it("treats a name as taken whichever of local or origin holds it", () => {
    expect(deriveBranchName("tidy-replay-lookup", fakeGit(["tidy-replay-lookup-2"], ["tidy-replay-lookup"]))).toBe(
      "tidy-replay-lookup-3",
    );
  });

  it("never reuses a branch that only exists on origin, pushed from another checkout", () => {
    expect(deriveBranchName("tidy-replay-lookup", fakeGit([], ["tidy-replay-lookup"]))).toBe("tidy-replay-lookup-2");
  });

  it("a numeric suffix never introduces a giveaway the base name didn't already have", () => {
    const bases = ["tidy-replay-lookup", "quiet-booking-sweep", "steady-queue-rename"];
    for (const base of bases) {
      expect(telltales(base)).toEqual([]);
      for (let suffix = 2; suffix < 50; suffix++) {
        expect(telltales(`${base}-${suffix}`)).toEqual([]);
      }
    }
  });
});
