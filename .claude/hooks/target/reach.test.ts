/**
 * Where a command reaches (target/reach.ts): every spelling of a write to a reviewed repo is that write, so it
 * goes through the door; a history rewrite there is refused however git is spelled; and a raw GraphQL write or
 * an MCP tool's input reaches every reviewed repo. Repos are made up under the temp folder.
 */
import { describe, expect, it } from "vitest";
import { askGuard, DOOR, guardConfig, privateStore, tempRepo } from "../fixtures.ts";

const LAB = "D:\\Projects\\FaultForge";
const TARGET = "D:\\Projects\\faultforge-target";
const CONFIG = guardConfig(tempRepo(true).dir);
const PRIVATE = privateStore("guard~private-", ["idempotency-guard-bypass-v1"]);
const verdict = (tool: string, input: object, cwd = LAB) =>
  askGuard(tool, input, cwd, { config: CONFIG, privateDir: PRIVATE });
const bash = (command: string, cwd?: string) => verdict("Bash", { command }, cwd);

describe("the bypass spellings the audit found (AUD-M3)", () => {
  it.each([
    ["gh api -fbody=", 'gh api repos/AJBeumer/faultforge-target/issues/3/comments -fbody="the planted bug"'],
    [
      "gh api --method POST -ftitle=",
      'gh api --method POST repos/AJBeumer/faultforge-target/issues -ftitle="planted bug"',
    ],
    [
      "gh api on the repo itself",
      'gh api repos/AJBeumer/faultforge-target -X PATCH -f description="planted-bug target"',
    ],
    ["GH_REPO=", 'GH_REPO=AJBeumer/faultforge-target gh issue create --title "planted bug" --body x'],
    ["$env:GH_REPO", '$env:GH_REPO="AJBeumer/faultforge-target"; gh issue create --title "planted bug" --body x'],
    [
      "an issue URL after the flags",
      'gh issue comment --body "planted bug" https://github.com/AJBeumer/faultforge-target/issues/3',
    ],
    ["quote-split words", 'gh pr comment 3 -R AJBeumer/faultforge-target -b "pla""nted bug, case F""F-0012"'],
    ["PowerShell string joins", "gh pr comment 3 -R AJBeumer/faultforge-target -b ('pla'+'nted bug')"],
    [
      "--fill-verbose after a quoted title",
      'gh pr create -R AJBeumer/faultforge-target --head b -t "x" --fill-verbose',
    ],
  ])("denies %s", (_name, command) => {
    expect(bash(command)).toBeDefined();
  });

  it("denies a raw API write with curl, even with clean text", () => {
    const curl =
      "curl -X POST -H 'Authorization: Bearer t' https://api.github.com/repos/AJBeumer/faultforge-target/issues/3/comments -d '{\"body\":\"Thanks\"}'";
    expect(bash(curl)).toMatch(DOOR);
  });

  it.each([
    "git push -fu origin main",
    "git push -uf origin main",
    'git push "--force" origin main',
    "git push origin '+main'",
    "git push --mirror",
    "git push origin --delete main",
    "git push -d origin main",
    "git push origin :main",
    "gi''t pu''sh --fo''rce origin main",
    "git send-pack --force origin main",
  ])("denies the history rewrite %s", (command) => {
    expect(bash(command, TARGET)).toMatch(DOOR);
  });

  it("denies a force push through GIT_DIR", () => {
    expect(
      bash("GIT_DIR=../faultforge-target/.git GIT_WORK_TREE=../faultforge-target git push --force origin main"),
    ).toMatch(DOOR);
  });
});

describe("a raw GraphQL write and an MCP tool's input reach every reviewed repo", () => {
  it("counts a raw write to GitHub's GraphQL endpoint as reaching every reviewed repo", () => {
    expect(bash("curl -X POST https://api.github.com/graphql -d @payload.json")).toMatch(DOOR);
  });

  it("reads an MCP input's text, so a word after a line break is still a word", () => {
    const input = { owner: "AJBeumer", repo: "faultforge-target", body: "Notes\nplanted bug" };
    expect(verdict("mcp__github__add_comment", input)).toMatch(DOOR);
    expect(verdict("mcp__github__add_comment", { body: "Notes\nx-secret-v1" })).toMatch(/still private/);
  });
});
