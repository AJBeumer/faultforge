/**
 * Links go one way: a lab commit never links to the target, from any message source git takes (a trailer, a
 * message file, a template, a second -m). A plain-text reference stays allowed. Folders are made up under the
 * temp folder.
 */
import { describe, expect, it } from "vitest";
import { askGuard, guardConfig, privateStore, REPOS, scratchFolder, tempRepo } from "../fixtures.ts";

const T = REPOS.target;
const LINK = `${T}#3`;
const CONFIG = guardConfig(tempRepo(true).dir);
const PRIVATE = privateStore("guard~private-");
/** A folder that is no checkout, holding the message files the commits read. */
const ELSEWHERE = scratchFolder("guard-elsewhere-", {
  "notes.txt": "Tidy the list\n",
  "link.txt": `Tidy\n\nRefs ${LINK}\n`,
  "url.txt": `Tidy\n\nSee https://github.com/${T}/pull/3\n`,
});
const bash = (command: string) =>
  askGuard("Bash", { command }, ELSEWHERE, { config: CONFIG, privateDir: PRIVATE, outsideRun: true });

describe("a lab commit can't link to the target from any message source", () => {
  it.each([
    ["a trailer", `git commit -m "x" --trailer "Refs: ${LINK}"`],
    ["a trailer with =", `git commit --trailer="Fixes: ${LINK}" -m x`],
    ["a trailer URL", `git commit -m x --trailer "Refs: https://github.com/${T}/issues/3"`],
    ["a message file", "git commit -F link.txt"],
    ["a long message file", "git commit --file=url.txt"],
    ["a template", "git commit -t link.txt"],
    ["a second -m", `git commit -m x -m "Refs ${LINK}"`],
  ])("refuses %s", (_name, command) => {
    expect(bash(command)).toMatch(/link to the target/);
  });

  it("allows a plain-text reference and an ordinary trailer", () => {
    expect(bash('git commit -m "x" --trailer "Refs: target 3"')).toBeUndefined();
    expect(bash("git commit -F notes.txt")).toBeUndefined();
  });
});
