/**
 * A repo name split or escaped for the shell is the same name once the shell joins it, so a write to the
 * reviewed repo spelled that way still goes through the door, and a read spelled that way still passes.
 */
import { describe, expect, it } from "vitest";
import { askGuard, DOOR, growth, guardConfig, LINEAR_BOUND, tempRepo } from "../fixtures.ts";
import { unreadableDestination } from "./expand.ts";

const LAB = "D:\\Projects\\FaultForge";
const FIXTURE = tempRepo(true);
const CONFIG = guardConfig(FIXTURE.dir);
const ask = (tool: string, command: string) => askGuard(tool, { command }, LAB, { config: CONFIG, outsideRun: true });
const bash = (command: string) => ask("Bash", command);
const UNKNOWN = /can't read from the command/;
const pwsh = (command: string) => ask("PowerShell", command);
/** The fixture checkout's path with forward slashes and empty quotes before its last letter. */
const splitPath = () => {
  const path = FIXTURE.dir.replace(/\\/g, "/");
  return `${path.slice(0, -1)}''${path.slice(-1)}`;
};

describe("a write to the reviewed repo whose name the shell joins", () => {
  it.each([
    ["empty single quotes in -R", "gh issue comment 5 -R AJBeumer/faultforge-tar''get --body ok"],
    ["empty double quotes in -R", 'gh issue comment 5 -R AJBeumer/faultforge-tar""get --body ok'],
    ["a quoted half of an API route", "gh api 'repos/AJBeumer/faultforge-'target/issues -f body=x"],
    ["an escaped letter in an API route", "gh api repos/AJBeumer/faultforge-tar\\get/issues -f body=x"],
    ["empty quotes in an API route", "gh api repos/AJBeumer/faultforge-tar''get/issues -f title=x -f body=x"],
    [
      "empty quotes in a curl URL",
      "curl -X POST https://api.github.com/repos/AJBeumer/faultforge-tar''get/issues -d '{}'",
    ],
    ["an ANSI-C escape in an API route", "gh api $'repos/AJBeumer/faultforge-tar\\x67et/issues' -f body=x"],
    ["empty quotes in --repo", "gh issue comment 5 --repo AJBeumer/faultforge-tar''get --body ok"],
    ["an escaped letter in --repo", "gh pr comment 5 --repo=AJBeumer/faultforge-\\target --body ok"],
    ["empty quotes in GH_REPO", "GH_REPO=AJBeumer/faultforge-tar''get gh issue create --title Tidy --body ok"],
    ["empty quotes in an issue URL", "gh issue comment https://github.com/AJBeumer/faultforge-tar''get/issues/5 -b ok"],
    ["empty quotes in a push URL", "git push https://github.com/AJBeumer/faultforge-tar''get.git main"],
  ])("is refused: %s", (_name, command) => {
    expect(bash(command)).toBeDefined();
  });

  it("names the door for each spelling the shell joins", () => {
    for (const command of [
      "gh issue comment 5 -R AJBeumer/faultforge-tar''get --body ok",
      'gh issue comment 5 -R AJBeumer/faultforge-tar""get --body ok',
      "gh api 'repos/AJBeumer/faultforge-'target/issues -f body=x",
      "gh api repos/AJBeumer/faultforge-tar\\get/issues -f body=x",
      "gh api repos/AJBeumer/faultforge-tar''get/issues -f title=x -f body=x",
      "curl -X POST https://api.github.com/repos/AJBeumer/faultforge-tar''get/issues -d '{}'",
      "gh api $'repos/AJBeumer/faultforge-tar\\x67et/issues' -f body=x",
    ]) {
      expect(bash(command), command).toMatch(DOOR);
    }
  });

  it("is refused in PowerShell with the split inside a single-quoted string", () => {
    expect(pwsh("gh issue comment 5 -R 'AJBeumer/faultforge-tar''get' --body ok")).toMatch(DOOR);
    expect(pwsh("gh api 'repos/AJBeumer/faultforge-tar''get/issues' -f body=x")).toMatch(DOOR);
  });

  it("is refused when git -C or cd names the checkout with a split folder name", () => {
    expect(bash(`git -C ${splitPath()} push origin tidy`)).toMatch(DOOR);
    expect(bash(`cd ${splitPath()} && git push origin tidy`)).toMatch(DOOR);
  });

  it("does not read a move split by quotes inside a message to another repo", () => {
    const body = `c''d ${FIXTURE.dir.replace(/\\/g, "/")}`;
    expect(bash(`gh issue comment 5 -R AJBeumer/other-app --body "${body}"`)).toBeUndefined();
  });
});

describe("a write whose repo name holds a variable the command doesn't set, or a brace list", () => {
  it.each([
    "gh issue comment 5 -R AJBeumer/faultforge-tar$X --body ok",
    "gh issue comment 5 --repo=AJBeumer/faultforge-tar${X}get --body ok",
    "GH_REPO=AJBeumer/faultforge-$X gh issue create --title Tidy --body ok",
    "gh api repos/AJBeumer/faultforge-tar$X/issues -f body=x",
    "gh api repos/$OWNER/faultforge-target/issues -f body=x",
    "gh issue comment https://github.com/AJBeumer/faultforge-$X/issues/5 -b ok",
    "gh issue comment 5 -R AJBeumer/faultforge-{x,target} --body ok",
    "gh issue comment 5 -R AJBeumer/faultforge-targe{t,} --body ok",
    "gh api repos/AJBeumer/faultforge-{x,target}/issues -f body=x",
    "gh api repos/{AJBeumer/faultforge-target,o/n}/issues -f body=x",
  ])("is refused as unreadable: %s", (command) => {
    expect(bash(command)).toMatch(UNKNOWN);
  });

  it("reads only the repo, not the message, for a variable", () => {
    expect(bash("gh issue comment 5 -R AJBeumer/other-app --body 'See repos/o/$X'")).toBeUndefined();
    expect(bash("gh issue comment 5 -R AJBeumer/other-app --body 'Try --repo o/$X'")).toBeUndefined();
  });

  it("takes time linear in the command's length", () => {
    const ratio = growth((k) => unreadableDestination(`gh issue comment 5 ${"--repo".repeat(1000 * k)}`));
    expect(ratio).toBeLessThan(LINEAR_BOUND);
  });

  it("still passes a variable or a brace list elsewhere in a write to another repo", () => {
    expect(bash("gh issue comment 5 -R AJBeumer/other-app --body ok")).toBeUndefined();
    expect(bash("gh api repos/AJBeumer/other-app/issues/$N/comments -f body=ok")).toBeUndefined();
    expect(bash("gh api repos/{owner}/{repo}/issues -f body=ok")).toBeUndefined();
    expect(bash(`gh issue comment 5 -R AJBeumer/other-app --body '{"a":1,"b":2}'`)).toBeUndefined();
  });
});

describe("a read of the reviewed repo whose name the shell joins", () => {
  it.each([
    "gh pr view 5 -R AJBeumer/faultforge-tar''get",
    "gh api repos/AJBeumer/faultforge-tar''get/pulls",
    "gh api $'repos/AJBeumer/faultforge-tar\\x67et/pulls'",
    "curl https://api.github.com/repos/AJBeumer/faultforge-tar''get/pulls",
  ])("passes: %s", (command) => {
    expect(bash(command)).toBeUndefined();
  });
});
