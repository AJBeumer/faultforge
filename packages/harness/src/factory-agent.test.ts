import { describe, expect, it } from "vitest";
import { agentArgs, agentInstructions, killTree, prUrlFromToolResult } from "./factory-agent.ts";

describe("agentInstructions (#73)", () => {
  it("tells the agent to pass PR bodies, comments and commit messages as files", () => {
    const text = agentInstructions("/runs/r", "target", 18, "/runs/r/ticket.md");
    expect(text).toMatch(/--body-file/);
    expect(text).toMatch(/git commit -F/);
    expect(text).toMatch(/PR bodies, comments and commit messages/);
  });

  it("names the snapshot file's environment variable and rules out the live reads the skills mention (#113)", () => {
    const text = agentInstructions("/runs/r", "target", 18, "/runs/r/ticket.md");
    expect(text).toContain("is in /runs/r/ticket.md.");
    expect(text).toMatch(/never with gh issue view, gh api or npm run ticket:ready/);
    expect(text).toMatch(/Don't move the ticket on the project board/);
  });

  it("gives the path outright and rules out listing the environment, which the first run did on its first call (#113)", () => {
    const text = agentInstructions("/runs/r", "faultforge", 107, "/runs/r/ticket.md");
    expect(text).toContain("Don't list it (env, printenv and set are blocked)");
    expect(text).toContain('echo "$FAULTFORGE_TICKET_FILE", is fine');
  });

  it("says to wait for Qodo in the foreground and never to end the turn early, which lost run 20261110-150249 (#129)", () => {
    const text = agentInstructions("/runs/r", "faultforge", 18, "/runs/r/ticket.md");
    expect(text).toContain(
      "Run review:wait in the foreground, with the Bash tool's longest timeout (600000 ms) and --timeout 9",
    );
    expect(text).toContain("run it again while it exits 1");
    expect(text).toContain(
      "Never start it in the background and never schedule a wakeup: ending your turn ends the run",
    );
    expect(text).toContain("Report FACTORY_RESULT before you stop");
  });
});

describe("agentArgs (#103)", () => {
  const args = agentArgs({
    repoKey: "target",
    number: 18,
    budget: 25,
    settingsFile: "/runs/r/agent-settings.json",
    mcpConfigFile: "/runs/r/agent-mcp.json",
    instructions: "do the ticket",
    extraDirs: ["--add-dir", "/runs/r/faultforge-target"],
  });
  const value = (flag: string) => args[args.indexOf(flag) + 1];

  it("reaches no MCP server of the machine: an explicit config, used strictly", () => {
    expect(value("--mcp-config")).toBe("/runs/r/agent-mcp.json");
    expect(args).toContain("--strict-mcp-config");
  });

  it("takes the wakeup tool away: a scheduled wakeup never fires in a headless run (#129)", () => {
    expect(value("--disallowedTools")).toBe("ScheduleWakeup");
  });

  it("keeps the run's other limits: the deny settings, the budget, the prompt and the extra folders", () => {
    expect(value("--settings")).toBe("/runs/r/agent-settings.json");
    expect(value("--max-budget-usd")).toBe("25");
    expect(value("-p")).toBe("/factory target 18");
    expect(value("--append-system-prompt")).toBe("do the ticket");
    expect(value("--add-dir")).toBe("/runs/r/faultforge-target");
  });
});

describe("prUrlFromToolResult (#107)", () => {
  it("finds a pull request url in a plain string result", () => {
    expect(prUrlFromToolResult("Created https://github.com/owner/target/pull/42\n", "owner/target")).toBe(
      "https://github.com/owner/target/pull/42",
    );
  });

  it("finds a pull request url inside a list of text blocks", () => {
    expect(
      prUrlFromToolResult([{ type: "text", text: "https://github.com/owner/target/pull/7 opened" }], "owner/target"),
    ).toBe("https://github.com/owner/target/pull/7");
  });

  it("is null when there is no pull request url", () => {
    expect(prUrlFromToolResult("nothing here", "owner/target")).toBeNull();
    expect(prUrlFromToolResult(null, "owner/target")).toBeNull();
    expect(prUrlFromToolResult(undefined, "owner/target")).toBeNull();
  });

  it("ignores a pull request url of some other repository, even alongside this one's (Qodo on PR 123)", () => {
    const text =
      "See https://github.com/owner/other/pull/3 for background.\nCreated https://github.com/owner/target/pull/42";
    expect(prUrlFromToolResult(text, "owner/target")).toBe("https://github.com/owner/target/pull/42");
    expect(prUrlFromToolResult("Created https://github.com/owner/other/pull/3", "owner/target")).toBeNull();
  });
});

describe("killTree: a process already gone is no crash (audit N-12)", () => {
  it.skipIf(process.platform === "win32")("ignores ESRCH and rethrows anything else", () => {
    const gone = () => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    };
    expect(() => killTree(12345, gone)).not.toThrow();
    const denied = () => {
      throw Object.assign(new Error("not permitted"), { code: "EPERM" });
    };
    expect(() => killTree(12345, denied)).toThrow(/not permitted/);
  });
});
