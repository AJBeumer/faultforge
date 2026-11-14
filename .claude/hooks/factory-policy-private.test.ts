/**
 * A lab ticket's run is kept out of the private repo too (#299, second re-grade after round 4): the answer key,
 * the audit log, held-out files and unreleased templates, by every tool and shell spelling the re-grade tried.
 * Its own private worktree sits inside the run's folder; the agent may read back only the evidence its own
 * tools saved there. Folders are made up under the temp folder.
 */
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { decide } from "./factory-policy.ts";

const BASE = mkdtempSync(join(tmpdir(), "policy-lab-run-"));
const OWNER_PRIVATE = join(BASE, "owner-lab", "private");
const RUNS = join(BASE, "runs");
const RUN = join(RUNS, "r1");
const LAB = join(RUN, "lab");
const OWN_PRIVATE = join(LAB, "private");
for (const dir of [
  OWNER_PRIVATE,
  join(OWN_PRIVATE, "templates", "x-secret-v1"),
  join(OWN_PRIVATE, "raw-artifacts", "reviews", "faultforge-pr12"),
  join(OWN_PRIVATE, "raw-artifacts", "reviews", "faultforge-target-pr3"),
  join(OWN_PRIVATE, "raw-artifacts", "FF-9001"),
  join(OWN_PRIVATE, "raw-artifacts", "factory-log"),
  join(LAB, "packages", "harness", "src"),
  join(RUN, "faultforge-target"),
  join(RUNS, "r0", "lab", "private"),
])
  mkdirSync(dir, { recursive: true });
for (const file of ["ground-truth.jsonl", "audit-events.jsonl", "BACKLOG.md"])
  writeFileSync(join(OWN_PRIVATE, file), "{}\n");
writeFileSync(join(OWN_PRIVATE, "templates", "HELD-OUT.md"), "x\n");

const ENV = {
  FAULTFORGE_FACTORY_RUN: "r1",
  FAULTFORGE_RUN_ROOT: RUN,
  FAULTFORGE_TICKET_NUMBER: "7",
  FAULTFORGE_PRIVATE_CHECKOUTS: [OWNER_PRIVATE, RUNS, OWN_PRIVATE].join(delimiter),
};

function verdict(tool: string, input: object, cwd = LAB, extra: Record<string, string> = {}): string | undefined {
  const decision = decide(JSON.stringify({ tool_name: tool, cwd, tool_input: input }), { ...ENV, ...extra });
  if (decision.kind === "error") throw new Error(decision.message);
  return decision.kind === "deny" ? decision.reason : undefined;
}
const bash = (command: string, cwd = LAB) => verdict("Bash", { command }, cwd);

describe("a lab ticket's run doesn't read the private repo (#299)", () => {
  it.each([
    "cd private && cat ground-truth.jsonl",
    "cd private; cat ground*",
    "cat private/ground*",
    "git -C private show HEAD:ground-truth.jsonl",
    "git -C private show HEAD:templates/HELD-OUT.md",
    "git -C private log -p -3 -- templates",
    "git -C private log -p -1",
    "git -C private archive HEAD | tar t",
    "grep -rh templateId private",
    "grep -r templateId .",
    "grep -r templateId",
    "find . -name template.json",
    "head -c 9999 private/g*.jsonl",
    "cat private/raw-artifacts/FF-9001/x.json",
    "cat private/raw-artifacts/reviews/faultforge-target-pr3/x.json",
    "ls private/templates",
    "ls private/temp*",
    "ls -R .",
    "cp private/ground-truth.jsonl /tmp/a && cat /tmp/a",
    "cd packages && cat ../private/raw-artifacts/FF-9001/x.json",
    "cd packages && grep -r x ../priv*",
    "rg --no-ignore templateId",
    `cat ${join(OWNER_PRIVATE, "notes.md")}`,
    `ls ${join(RUNS, "r0", "lab", "private")}`,
    "cat templates/HELD-OUT.md",
  ])("refuses %s", (command) => {
    expect(bash(command)).toBeDefined();
  });

  it("refuses every command run from inside the private worktree, past its evidence", () => {
    expect(bash("cat ground-truth.jsonl", OWN_PRIVATE)).toBeDefined();
    expect(bash("ls", join(OWN_PRIVATE, "templates"))).toBeDefined();
  });

  it.each([
    ["Grep in the private worktree", "Grep", { pattern: "x", path: OWN_PRIVATE }],
    ["Grep by a glob", "Grep", { pattern: "templateId", path: LAB, glob: "**/ground-truth.jsonl" }],
    ["Glob of its templates", "Glob", { pattern: "private/templates/*" }],
    ["Glob of held-out files", "Glob", { pattern: "**/HELD-OUT*" }],
    ["Read of a case record", "Read", { file_path: join(OWN_PRIVATE, "cases", "FF-9001.json") }],
    ["Read of raw case evidence", "Read", { file_path: join(OWN_PRIVATE, "raw-artifacts", "FF-9001", "x.json") }],
    ["Read of the backlog", "Read", { file_path: join(OWN_PRIVATE, "BACKLOG.md") }],
    ["Read in the owner's private folder", "Read", { file_path: join(OWNER_PRIVATE, "x.md") }],
    ["Grep of the runs folder", "Grep", { pattern: "x", path: RUNS }],
  ])("refuses %s", (_name, tool, input) => {
    expect(verdict(tool, input)).toBeDefined();
  });
});

describe("a lab ticket's run still does its work (#299)", () => {
  it.each([
    "npm test",
    "npm run check",
    "git status",
    "ls -la",
    "ls -la packages",
    "grep -rn foo packages",
    "grep -rn foo packages/harness/src",
    "rg foo",
    "git grep -n foo",
    "cat private/raw-artifacts/reviews/faultforge-pr12/x.review.json",
    "ls private/raw-artifacts/factory-log",
    "cd ../faultforge-target && npm test",
  ])("allows %s", (command) => {
    expect(bash(command)).toBeUndefined();
  });

  it.each([
    ["Grep from the checkout (ripgrep skips the git-ignored worktree)", "Grep", { pattern: "ground-truth" }],
    [
      "Read of the PR's saved review",
      "Read",
      { file_path: join(OWN_PRIVATE, "raw-artifacts", "reviews", "faultforge-pr12", "a.review.json") },
    ],
    [
      "Read of the factory log",
      "Read",
      { file_path: join(OWN_PRIVATE, "raw-artifacts", "factory-log", "2026-11-14.md") },
    ],
    ["Read of its own code", "Read", { file_path: join(LAB, "packages", "harness", "src", "x.ts") }],
  ])("allows %s", (_name, tool, input) => {
    expect(verdict(tool, input)).toBeUndefined();
  });

  it("allows a Glob from the checkout only while Glob skips git-ignored files, as the runner sets it", () => {
    expect(verdict("Glob", { pattern: "**/*.ts" }, LAB, { CLAUDE_CODE_GLOB_NO_IGNORE: "false" })).toBeUndefined();
    expect(verdict("Glob", { pattern: "**/template.json" })).toMatch(/holds the private worktree/);
  });
});

describe("a run folder named through a link still meets itself (#299, the Windows runner's short temp names)", () => {
  it("allows Grep from the checkout and refuses its private worktree when the run root is a link", () => {
    const linked = join(BASE, "linked-runs");
    try {
      symlinkSync(RUNS, linked, "junction");
    } catch {
      return; // no links on this machine: nothing to show
    }
    const env = {
      ...ENV,
      FAULTFORGE_RUN_ROOT: join(linked, "r1"),
      FAULTFORGE_PRIVATE_CHECKOUTS: [OWNER_PRIVATE, linked, join(linked, "r1", "lab", "private")].join(delimiter),
    };
    const ask = (tool: string, input: object) => {
      const decision = decide(
        JSON.stringify({ tool_name: tool, cwd: join(linked, "r1", "lab"), tool_input: input }),
        env,
      );
      return decision.kind === "deny" ? decision.reason : undefined;
    };
    expect(ask("Grep", { pattern: "x" })).toBeUndefined();
    expect(ask("Read", { file_path: join(linked, "r1", "lab", "private", "BACKLOG.md") })).toBeDefined();
    expect(ask("Read", { file_path: join(OWN_PRIVATE, "ground-truth.jsonl") })).toBeDefined();
  });
});
