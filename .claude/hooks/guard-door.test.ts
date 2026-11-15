/**
 * The door rule (#340): every write to a reviewed repo goes through `npm run target:post`, and the guard refuses
 * every other one without reading what it would say. Reads, and local work in the reviewed checkout, still pass.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { guardConfig, guardDecision, tempRepo } from "./fixtures.ts";
import { DOOR_SCRIPT, doorCommand, ghReads, mcpReads } from "./guard-door.ts";

const LAB = "D:\\Projects\\FaultForge";
const LAB_ROOT = join(import.meta.dirname, "../..");
const TARGET = "D:\\Projects\\faultforge-target";
const FIXTURE = tempRepo(true);
const CONFIG = guardConfig(FIXTURE.dir);
const DOOR = /go only through the door[\s\S]*npm run target:post/;
const UNKNOWN = /can't read from the command[\s\S]*npm run target:post/;

const bash = (command: string, cwd = LAB) => guardDecision("Bash", { command }, cwd, CONFIG);
const pwsh = (command: string, cwd = LAB) => guardDecision("PowerShell", { command }, cwd, CONFIG);

describe("the door rule (#340)", () => {
  describe("refuses every raw write aimed at the reviewed repo, whatever it says", () => {
    it.each([
      "gh issue create --repo AJBeumer/faultforge-target --title Tidy --body ok",
      "gh issue edit 3 --repo AJBeumer/faultforge-target --body ok",
      "gh issue comment 3 -R AJBeumer/faultforge-target --body ok",
      "gh pr create --repo AJBeumer/faultforge-target --title Tidy --body ok --head x",
      "gh pr edit 4 --repo AJBeumer/faultforge-target --title Tidy",
      "gh pr comment 4 --repo AJBeumer/faultforge-target --body ok",
      "gh pr close 4 --repo AJBeumer/faultforge-target --comment ok",
      "gh pr merge 4 --repo AJBeumer/faultforge-target",
      "gh pr -R AJBeumer/faultforge-target merge 4",
      "gh pr review 4 --repo AJBeumer/faultforge-target --approve",
      "gh label create x --repo AJBeumer/faultforge-target",
      "gh api repos/AJBeumer/faultforge-target/issues/1/comments -f body=ok",
      "gh api -X PATCH repos/AJBeumer/faultforge-target/issues/1",
      "gh api --method=DELETE repos/AJBeumer/faultforge-target/git/refs/heads/x",
      "gh api graphql -f query='mutation { addComment(input: {}) { clientMutationId } }'",
      "curl -X POST https://api.github.com/repos/AJBeumer/faultforge-target/issues -d '{}'",
      "wget --post-data=x https://api.github.com/repos/AJBeumer/faultforge-target/issues",
      `git -C ${TARGET} push origin tidy`,
      `cd ${TARGET} && git push origin tidy`,
    ])("%s", (command) => {
      expect(bash(command)).toMatch(DOOR);
    });

    it("refuses a push by URL from elsewhere (the lab's history rule names where to push from)", () => {
      expect(bash("git push https://github.com/AJBeumer/faultforge-target.git main")).toMatch(
        /only from its own checkout/,
      );
    });

    it("refuses a write from inside the checkout that names no repo, and a plain push there", () => {
      expect(bash("gh issue create --title Tidy --body ok", TARGET)).toMatch(DOOR);
      expect(bash("git push origin tidy", TARGET)).toMatch(DOOR);
      expect(bash("git push", TARGET)).toMatch(DOOR);
    });

    it("refuses PowerShell's web calls with a body", () => {
      expect(
        pwsh(
          "Invoke-WebRequest -Method Post -Uri https://api.github.com/repos/AJBeumer/faultforge-target/issues -Body x",
        ),
      ).toMatch(DOOR);
    });

    it("refuses an MCP tool that writes to it, and lets one that reads through", () => {
      const input = { owner: "AJBeumer", repo: "faultforge-target", title: "Tidy", body: "ok" };
      expect(guardDecision("mcp__github__create_issue", input, LAB, CONFIG)).toMatch(DOOR);
      expect(guardDecision("mcp__github__merge_pull_request", { ...input, pull_number: 3 }, LAB, CONFIG)).toMatch(DOOR);
      expect(guardDecision("mcp__github__get_issue", { ...input, issue_number: 3 }, LAB, CONFIG)).toBeUndefined();
    });
  });

  describe("refuses the spellings a text parser missed, without reading them", () => {
    it("a repo named by a variable the command sets, or one it doesn't", () => {
      expect(bash('R=AJBeumer/faultforge-target; gh issue comment 1 -R "$R" --body ok')).toMatch(DOOR);
      expect(bash('gh issue comment 1 -R "$REPO" --body ok')).toMatch(UNKNOWN);
    });

    it("a script file that writes to it", () => {
      const dir = mkdtempSync(join(tmpdir(), "guard-door-script-"));
      const script = join(dir, "post.mjs");
      writeFileSync(
        script,
        "import { execFileSync } from 'node:child_process';\nexecFileSync('gh', ['issue', 'create', '--repo', 'AJBeumer/faultforge-target', '--body', 'x']);\n",
      );
      expect(bash(`node ${script.replace(/\\/g, "/")}`)).toMatch(/npm run target:post/);
    });

    it("node or python inline code that runs gh or reaches the network (shell-exec.ts refuses it everywhere)", () => {
      const built = /inline interpreter code that starts another program|network/;
      expect(
        bash(
          `node -e "require('child_process').execFileSync('gh',['issue','create','-R','AJBeumer/faultforge-target','--body','x'])"`,
        ),
      ).toMatch(built);
      expect(
        bash(
          `python -c "import subprocess; subprocess.run(['gh','pr','merge','3','-R','AJBeumer/faultforge-target'])"`,
        ),
      ).toMatch(built);
      expect(bash(`node -e "require('child_process').execSync('gh pr comment 3 --body x')"`, TARGET)).toMatch(built);
      expect(
        bash(`node -e "fetch('https://api.github.com/repos/AJBeumer/faultforge-target/issues', {method: 'POST'})"`),
      ).toMatch(built);
    });

    it("an HTTP write to a URL it can't read", () => {
      expect(bash('curl -X POST "$URL" -d @body.json')).toMatch(UNKNOWN);
    });
  });

  describe("lets reads and local work through", () => {
    it.each([
      "gh pr view 3 --repo AJBeumer/faultforge-target",
      "gh pr -R AJBeumer/faultforge-target view 3",
      "gh issue list --repo AJBeumer/faultforge-target",
      "gh pr checks 3 --repo AJBeumer/faultforge-target",
      "gh api repos/AJBeumer/faultforge-target/pulls/3 --jq .head.sha",
      `git -C ${TARGET} fetch origin`,
      `git -C ${TARGET} log --oneline -3`,
    ])("%s", (command) => {
      expect(bash(command)).toBeUndefined();
    });

    it("a commit in the checkout, whose own message is still read, as git's commit-msg hook reads it", () => {
      expect(bash('git commit -m "Tidy the lookup"', FIXTURE.dir)).toBeUndefined();
      expect(bash('git commit -m "Fix the planted bug"', FIXTURE.dir)).toMatch(/says planted/);
    });

    it("inline code that only names the repo, such as a file that holds its URL", () => {
      expect(bash(`node -e "require('fs').writeFileSync('x.md', 'see faultforge-target')"`)).toBeUndefined();
    });

    it("a lab post that names target work as plain text", () => {
      expect(bash('gh issue comment 5 --repo AJBeumer/faultforge --body "Follows target 3"')).toBeUndefined();
    });
  });

  describe("passes the door itself unread", () => {
    it("exactly npm run target:post -- … from the lab's checkout, whatever its files hold", () => {
      const body = join(mkdtempSync(join(tmpdir(), "guard-door-body-")), "planted.md");
      writeFileSync(body, "This would say planted, but the door reads it, not the guard.\n");
      const command = `npm run target:post -- pr-comment --number 3 --body-file '${body}'`;
      expect(guardDecision("Bash", { command }, LAB_ROOT, CONFIG)).toBeUndefined();
      expect(doorCommand(command, LAB_ROOT)).toBe(true);
    });

    it("nothing else: a chain, an expansion, another folder, or a package.json that runs something else", () => {
      expect(doorCommand("npm run target:post -- push --branch x; git push", LAB_ROOT)).toBe(false);
      expect(doorCommand('npm run target:post -- pr-comment --body-file "$F"', LAB_ROOT)).toBe(false);
      expect(doorCommand("npm run target:post -- push --branch x", TARGET)).toBe(false);
      const fake = mkdtempSync(join(tmpdir(), "guard-door-pkg-"));
      writeFileSync(join(fake, "package.json"), JSON.stringify({ scripts: { "target:post": "gh issue create" } }));
      expect(doorCommand("npm run target:post -- push --branch x", fake, fake)).toBe(false);
      writeFileSync(join(fake, "package.json"), JSON.stringify({ scripts: { "target:post": DOOR_SCRIPT } }));
      expect(doorCommand("npm run target:post -- push --branch x", fake, fake)).toBe(true);
      // Chained after the door, a raw write is still judged, and refused.
      expect(
        guardDecision("Bash", { command: `npm run target:post -- x && git -C ${TARGET} push` }, LAB_ROOT, CONFIG),
      ).toBeDefined();
    });
  });

  it("ghReads: a known read verb or an API GET reads; anything else is a write", () => {
    expect(ghReads(["pr", "view", "3"])).toBe(true);
    expect(ghReads(["pr", "-R", "o/n", "view", "3"])).toBe(true);
    expect(ghReads(["api", "repos/o/n/pulls", "-X", "GET"])).toBe(true);
    expect(ghReads(["api", "repos/o/n/pulls", "--jq", ".x"])).toBe(true);
    expect(ghReads(["api", "graphql", "-f", "query={ viewer { login } }"])).toBe(false);
    expect(ghReads(["api", "repos/o/n/issues", "-fbody=x"])).toBe(false);
    expect(ghReads(["pr", "-R", "o/n", "merge", "3"])).toBe(false);
    expect(ghReads(["extension", "exec", "x"])).toBe(false);
  });

  it("mcpReads: only a tool named for reading", () => {
    expect(mcpReads("mcp__github__get_pull_request")).toBe(true);
    expect(mcpReads("mcp__github__list_issues")).toBe(true);
    expect(mcpReads("mcp__github__create_pull_request")).toBe(false);
    expect(mcpReads("mcp__github__push_files")).toBe(false);
    // The verb may come last (Qodo on PR 344).
    expect(mcpReads("mcp__github__issue_read")).toBe(true);
    expect(mcpReads("mcp__github__issue_write")).toBe(false);
  });
});

describe("what Qodo found in the review of PR 344", () => {
  const LAB_CWD = LAB_ROOT;

  it("takes no second line after the door: a line break ends the door's form", () => {
    const merge = "npm run target:post -- push --branch x\ngh pr merge 5 -R AJBeumer/faultforge-target";
    expect(doorCommand(merge, LAB_ROOT)).toBe(false);
    expect(guardDecision("Bash", { command: merge }, LAB_CWD, CONFIG)).toMatch(DOOR);
    expect(doorCommand("npm run target:post -- push --branch x\r\nrm -rf .claude", LAB_ROOT)).toBe(false);
  });

  it("lets no pre or post script, or an npmrc that changes how scripts run, ride along with the door", () => {
    const root = mkdtempSync(join(tmpdir(), "guard-door-pre-"));
    const write = (scripts: Record<string, string>) =>
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ scripts: { "target:post": DOOR_SCRIPT, ...scripts } }),
      );
    const door = "npm run target:post -- push --branch x";
    write({});
    expect(doorCommand(door, root, root)).toBe(true);
    write({ "pretarget:post": "gh pr merge 5" });
    expect(doorCommand(door, root, root)).toBe(false);
    write({ "posttarget:post": "gh pr merge 5" });
    expect(doorCommand(door, root, root)).toBe(false);
    write({});
    writeFileSync(join(root, ".npmrc"), "script-shell=./post.sh\n");
    expect(doorCommand(door, root, root)).toBe(false);
  });

  it("refuses combined curl flags and httpie's implicit POST to the target", () => {
    const api = "https://api.github.com/repos/AJBeumer/faultforge-target/issues";
    expect(bash(`curl -sd @body.json ${api}`)).toMatch(DOOR);
    expect(bash(`curl -sX POST ${api}`)).toMatch(DOOR);
    expect(bash(`curl -XPOST ${api}`)).toMatch(DOOR);
    expect(bash("http api.github.com/repos/AJBeumer/faultforge-target/issues title=x")).toMatch(DOOR);
    expect(bash("http POST api.github.com/repos/AJBeumer/faultforge-target/issues")).toMatch(DOOR);
  });

  it("refuses an HTTP write with any argument it can't read, whatever literal URL sits beside it", () => {
    expect(bash('curl -X POST https://example.com "$TARGET_URL" -d "{}"')).toMatch(UNKNOWN);
  });

  it("lets explicit reads through: gh api -X GET, and curl's read flags", () => {
    const api = "https://api.github.com/repos/AJBeumer/faultforge-target/pulls";
    expect(bash("gh api -X GET repos/AJBeumer/faultforge-target/issues/5")).toBeUndefined();
    expect(bash(`curl -f ${api}`)).toBeUndefined();
    expect(bash(`curl -fsSL -D headers.txt -H "Accept: application/json" ${api}`)).toBeUndefined();
    expect(bash(`curl -XGET ${api}`)).toBeUndefined();
  });

  it("reads push only as git's own subcommand: a message, a stash or a config key that says push is none", () => {
    expect(bash('git commit -m "Retry push on timeout"', FIXTURE.dir)).toBeUndefined();
    expect(bash("git stash push -m wip", FIXTURE.dir)).toBeUndefined();
    expect(bash("git config push.default simple", FIXTURE.dir)).toBeUndefined();
    expect(bash("git -C . push origin tidy", FIXTURE.dir)).toMatch(DOOR);
  });

  it("judges a commit's links by the checkout its git call runs in, not the folder the command starts from", () => {
    const other = tempRepo(true);
    const config = guardConfig(FIXTURE.dir, (c) => {
      c.repos.other = { ...c.repos.target, github: "AJBeumer/other-app", path: other.dir };
    });
    const at = (path: string) => path.replace(/\\/g, "/");
    // From the target's checkout, a commit in the other one may not link the target.
    const cross = `git -C ${at(other.dir)} commit --allow-empty -m "See faultforge-target#5"`;
    expect(guardDecision("Bash", { command: cross }, FIXTURE.dir, config)).toMatch(/link to the target/);
    // From anywhere, a commit in the target's own checkout may name its own ticket.
    const own = `git -C ${at(FIXTURE.dir)} commit --allow-empty -m "Closes faultforge-target#5"`;
    expect(guardDecision("Bash", { command: own }, LAB, config)).toBeUndefined();
  });
});

describe("what Qodo found in the second review of PR 344", () => {
  const api = "https://api.github.com/repos/AJBeumer/faultforge-target/issues";

  it("refuses httpie sending a file as the whole body", () => {
    expect(bash("http api.github.com/repos/AJBeumer/faultforge-target/issues @payload.json")).toMatch(DOOR);
  });

  it("refuses PowerShell's and wget's abbreviated parameters, and a bare method word", () => {
    expect(pwsh(`irm ${api} -Me Post -Bo '{"title":"x"}'`)).toMatch(DOOR);
    expect(pwsh(`Invoke-WebRequest ${api} -In body.json`)).toMatch(DOOR);
    expect(bash(`wget --post-d=x ${api}`)).toMatch(DOOR);
    expect(bash(`wget --meth=POST ${api}`)).toMatch(DOOR);
    expect(pwsh(`irm ${api} -Headers @{a=1}`)).toBeUndefined();
  });

  it("passes the door unread only when no node_modules/.bin from the root up holds a node of its own", () => {
    const root = mkdtempSync(join(tmpdir(), "guard-door-bin-"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { "target:post": DOOR_SCRIPT } }));
    const door = "npm run target:post -- push --branch x";
    expect(doorCommand(door, root, root)).toBe(true);
    mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(root, "node_modules", ".bin", "node.cmd"), "@echo off\n");
    expect(doorCommand(door, root, root)).toBe(false);
  });
});
