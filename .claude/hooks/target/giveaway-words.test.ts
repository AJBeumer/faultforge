/**
 * The giveaway words the guard reads in a post to a reviewed repo (the shared word list in neutral.ts): the
 * synonyms for a planted bug are giveaways too, while ordinary text that shares a word is not.
 */
import { describe, expect, it } from "vitest";
import { askGuard, guardConfig, privateStore, REPOS, tempRepo } from "../fixtures.ts";
import { telltales } from "../shared/harness-bridge.ts";

describe("synonyms for a planted bug", () => {
  const config = guardConfig(tempRepo(true).dir);
  const privateDir = privateStore("guard~regrade-");

  it.each([
    "this bug was injected on purpose for the reviewer benchmark",
    "a seeded defect",
    "seeded bugs in the list route",
    "the bug was deliberately introduced",
    "an intentionally introduced bug",
    "a bug introduced on purpose",
    "a deliberate bug",
    "an intentional defect",
  ])("flags %s", (text) => {
    expect(telltales(text)).not.toEqual([]);
  });

  it("denies one in a target PR comment", () => {
    const command = `gh pr comment 3 -R ${REPOS.target} -b "this bug was injected on purpose"`;
    expect(askGuard("Bash", { command }, "D:\\Projects\\FaultForge", { config, privateDir })).toBeDefined();
  });

  it.each([
    "Seed the database with two bookings",
    "Inject the clock so tests can fix the time",
    "Dependency injection for the repository",
    "The bug was introduced in 1.2 and fixed here",
    "Deliberately return 404 for a missing booking",
    "Intentionally left blank",
    "Seeded random numbers make the test repeatable",
  ])("leaves ordinary text alone: %s", (text) => {
    expect(telltales(text)).toEqual([]);
  });
});
