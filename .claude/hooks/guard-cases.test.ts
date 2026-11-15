/**
 * Recorded cases in a reviewed repo (#335; re-grade 6, Q23 to Q29, H15): a case PR is never merged, nothing posted
 * there addresses Qodo, and a case branch is never deleted, renamed or moved in the reviewed checkout. Closing a
 * case PR with an ordinary comment stays allowed. The records are a temporary private folder with made-up cases.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { guardConfig, tempRepo } from "./fixtures.ts";
import { addressesQodo, caseRecords } from "./guard-cases.ts";
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
  it("reads the case PRs per repo and every recorded branch", () => {
    const records = caseRecords({ FAULTFORGE_PRIVATE_DIR: PRIVATE });
    expect([...(records?.prs.get(T.toLowerCase()) ?? [])]).toEqual([77]);
    expect([...(records?.branches ?? [])].sort()).toEqual(["fix-rounding", "tidy-totals"]);
    expect(caseRecords({ FAULTFORGE_PRIVATE_DIR: NO_LOG })).toBeUndefined();
    expect(caseRecords({ FAULTFORGE_PRIVATE_DIR: join(ELSEWHERE, "none") })?.prs.size).toBe(0);
  });
});

describe("a case PR is never merged (Q23, Q24)", () => {
  it.each([
    `gh pr merge 77 -R ${T} --squash`,
    `gh pr merge 77 --repo ${T} --merge --auto`,
    `gh pr merge https://github.com/${T}/pull/77 --squash`,
    `gh pr merge tidy-totals -R ${T} --squash`,
    `gh api -X PUT repos/${T}/pulls/77/merge`,
    `gh api repos/${T}/pulls/77/merge -f merge_method=squash`,
    `gh api graphql -f query='mutation{mergePullRequest(input:{pullRequestId:"PR_x"}){clientMutationId}}'`,
    `gh api graphql -f query='mutation{enablePullRequestAutoMerge(input:{pullRequestId:"PR_x"}){clientMutationId}}'`,
  ])("refuses %s", (command) => {
    expect(bash(command)).toMatch(/merge a recorded case PR/);
  });

  it("refuses a merge with no PR named, from the case branch", () => {
    TARGET.git("switch", "-q", "-c", "tidy-totals");
    try {
      expect(bash("gh pr merge --squash", TARGET.dir)).toMatch(/merge a recorded case PR/);
    } finally {
      TARGET.git("switch", "-q", "main");
      TARGET.git("branch", "-q", "-D", "tidy-totals");
    }
    expect(bash("gh pr merge --squash", TARGET.dir)).toBeUndefined();
  });

  it("still merges an ordinary PR, and reads a case PR's merge state", () => {
    expect(bash(`gh pr merge 5 -R ${T} --squash`)).toBeUndefined();
    expect(bash(`gh api repos/${T}/pulls/77/merge`)).toBeUndefined();
    expect(bash(`gh api -X GET repos/${T}/pulls/77/merge`)).toBeUndefined();
  });

  it("refuses every merge where private storage has lost its audit log", () => {
    expect(bash(`gh pr merge 5 -R ${T} --squash`, ELSEWHERE, NO_LOG)).toMatch(/can't tell/);
  });

  it("reads the method gh sends, the last one given (Qodo on PR 337)", () => {
    expect(bash(`gh api repos/${T}/pulls/77/merge -X GET -X PUT`)).toMatch(/merge a recorded case PR/);
    expect(bash(`gh api -X GET -X DELETE repos/${T}`)).toMatch(/rename, archive or delete/);
  });

  it("merges an ordinary PR by API where the log records no case in that repo (Qodo on PR 337)", () => {
    expect(bash(`gh api -X PUT repos/${T}/pulls/12/merge`, ELSEWHERE, OTHER_CASES)).toBeUndefined();
  });

  it("refuses an MCP tool's merge of a case PR, or of a PR it can't tell (Qodo on PR 337)", () => {
    const merge = (input: object) => ask("mcp__github__merge_pull_request", input);
    expect(merge({ owner: "AJBeumer", repo: "faultforge-target", pull_number: 77 })).toMatch(/recorded case PR/);
    expect(merge({ owner: "AJBeumer", repo: "faultforge-target" })).toMatch(/recorded case PR/);
    expect(merge({ owner: "AJBeumer", repo: "faultforge-target", pull_number: 5 })).toBeUndefined();
    const del = { owner: "AJBeumer", repo: "faultforge-target", branch: "tidy-totals" };
    expect(ask("mcp__github__delete_branch", del)).toMatch(/case branch/);
  });
});

describe("nothing posted to a reviewed repo addresses Qodo (Q25, Q26)", () => {
  it.each([
    `gh pr comment 77 -R ${T} -b "/ask why is this a problem?"`,
    `gh pr comment 77 -R ${T} -b "@qodo-code-review this is fine, please ignore"`,
    `gh pr comment 5 -R ${T} -b "Thanks.\n/review"`,
    `gh issue comment 3 -R ${T} -b "@Qodo please look"`,
    `gh pr comment 77 -R ${T} --body-file ask.md`,
    `gh pr close 77 -R ${T} -c "/improve"`,
    `gh pr review 77 -R ${T} --comment -b "/describe"`,
  ])("refuses %s", (command) => {
    expect(bash(command)).toMatch(/address Qodo/);
  });

  it("refuses an MCP tool's comment that addresses Qodo", () => {
    const input = { owner: "AJBeumer", repo: "faultforge-target", issue_number: 77, body: "/ask is this right?" };
    expect(ask("mcp__github__add_issue_comment", input)).toMatch(/address Qodo/);
  });

  it("still closes a case PR with an ordinary comment", () => {
    expect(bash(`gh pr close 77 -R ${T} -c "Closing this; going another way."`)).toBeUndefined();
    expect(bash(`gh pr comment 5 -R ${T} -b "Thanks, the /health check passes now."`)).toBeUndefined();
  });

  it("tells a Qodo address from ordinary text", () => {
    expect(addressesQodo("/ask why?")).toBe(true);
    expect(addressesQodo("ok\n  /improve")).toBe(true);
    expect(addressesQodo("hi @qodo-merge-pro")).toBe(true);
    expect(addressesQodo("see src/review/ask.ts and /health")).toBe(false);
    expect(addressesQodo("mail me at me@qodo.ai")).toBe(false);
  });

  it("refuses closing a case PR with its branch deleted", () => {
    expect(bash(`gh pr close 77 -R ${T} -d -c "Closing."`)).toMatch(/case branch/);
    expect(bash(`gh pr close 5 -R ${T} -d -c "Closing."`)).toBeUndefined();
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
