/**
 * Recorded cases in a reviewed repo (#335; re-grade 6, Q27 to Q29, H15): the repo itself stays, and a case branch is
 * never deleted, renamed or moved in the reviewed checkout. Merges and words to Qodo are refused by the door rule
 * (guard-door.test.ts). The records are a temporary private folder with made-up cases.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { guardConfig, tempRepo } from "./fixtures.ts";
import { caseRecords } from "./guard-cases.ts";
import { decide } from "./guard-target.ts";

const T = "AJBeumer/faultforge-target";
const TARGET = tempRepo(true);
const CONFIG = guardConfig(TARGET.dir);
const ELSEWHERE = mkdtempSync(join(tmpdir(), "guard-cases-elsewhere-"));
writeFileSync(join(ELSEWHERE, "ask.md"), "Thanks.\n/improve\n");
/** Private storage with one recorded case PR (77) on branch tidy-totals, and a control on branch fix-rounding. */
const PRIVATE = mkdtempSync(join(tmpdir(), "guard-cases-private-"));
writeFileSync(
  join(PRIVATE, "audit-events.jsonl"),
  [
    { type: "control.injected", caseId: "FF-9001", branch: "fix-rounding" },
    { type: "pr.opened", caseId: "FF-9002", repo: T, pr: 77, url: `https://github.com/${T}/pull/77` },
    { type: "pr.opened", caseId: "FF-9003", repo: "someone/else", pr: 5 },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n"),
);
writeFileSync(join(PRIVATE, "ground-truth.jsonl"), `${JSON.stringify({ caseId: "FF-9002", branch: "tidy-totals" })}\n`);
/** Private storage that has lost its audit log: no case can be told apart. */
const NO_LOG = mkdtempSync(join(tmpdir(), "guard-cases-nolog-"));
mkdirSync(join(NO_LOG, "templates"));
/** Private storage whose log records cases in another repo only. */
const OTHER_CASES = mkdtempSync(join(tmpdir(), "guard-cases-other-"));
writeFileSync(
  join(OTHER_CASES, "audit-events.jsonl"),
  `${JSON.stringify({ type: "pr.opened", repo: "o/x", pr: 1 })}\n`,
);

function ask(tool: string, input: object, cwd = ELSEWHERE, priv = PRIVATE): string | undefined {
  const env: NodeJS.ProcessEnv = { ...process.env, FAULTFORGE_CONFIG: CONFIG, FAULTFORGE_PRIVATE_DIR: priv };
  delete env.FAULTFORGE_FACTORY_RUN;
  const decision = decide(JSON.stringify({ tool_name: tool, cwd, tool_input: input }), env);
  if (decision.kind === "error") throw new Error(decision.message);
  return decision.kind === "deny" ? decision.reason : undefined;
}
const bash = (command: string, cwd = ELSEWHERE, priv = PRIVATE) => ask("Bash", { command }, cwd, priv);

describe("case records", () => {
  it("reads every recorded branch", () => {
    const records = caseRecords({ FAULTFORGE_PRIVATE_DIR: PRIVATE });
    expect([...(records?.branches ?? [])].sort()).toEqual(["fix-rounding", "tidy-totals"]);
    expect(caseRecords({ FAULTFORGE_PRIVATE_DIR: NO_LOG })).toBeUndefined();
    expect(caseRecords({ FAULTFORGE_PRIVATE_DIR: join(ELSEWHERE, "none") })?.branches.size).toBe(0);
  });
});

describe("the reviewed repo itself stays (Q27 to Q29)", () => {
  it.each([`gh repo rename tidy -R ${T}`, `gh repo delete ${T} --yes`, `gh api -X DELETE repos/${T}`])(
    "refuses %s",
    (command) => {
      expect(bash(command)).toBeDefined();
    },
  );
});

describe("a case branch stays in the reviewed checkout (H15)", () => {
  it.each([
    "git update-ref -d refs/heads/main",
    "git update-ref refs/heads/tidy-totals HEAD~1",
    "git branch -D tidy-totals",
    "git branch --delete --force fix-rounding",
    "git branch -m tidy-totals renamed",
    "git branch -f tidy-totals HEAD~1",
    "git checkout -B fix-rounding",
    "git switch -C tidy-totals origin/main",
    // The name joined on to the flag (Qodo on PR 337).
    "git checkout -Btidy-totals",
    "git switch -Cfix-rounding",
    "git switch --force-create=tidy-totals",
    "git branch -D $B",
  ])("refuses %s", (command) => {
    expect(bash(command, TARGET.dir)).toMatch(/update-ref|case branch/);
  });

  it("refuses it from elsewhere, through git -C", () => {
    expect(bash(`git -C ${TARGET.dir.replace(/\\/g, "/")} branch -D tidy-totals`)).toMatch(/case branch/);
  });

  it("still deletes and makes ordinary branches", () => {
    expect(bash("git branch -D tidy-header", TARGET.dir)).toBeUndefined();
    expect(bash("git checkout -b tidy-header", TARGET.dir)).toBeUndefined();
    expect(bash("git branch -D tidy-totals", ELSEWHERE)).toBeUndefined();
  });

  it("refuses a branch change where private storage has lost its audit log", () => {
    expect(bash("git branch -D tidy-header", TARGET.dir, NO_LOG)).toMatch(/case branch/);
  });
});
