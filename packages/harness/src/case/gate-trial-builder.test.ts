import { describe, expect, it } from "vitest";
import { addedSince, BUILDER_TOOLS, builderArgs, builderDeny, changeProblems, plainEnv } from "./gate-trial-builder.ts";

describe("the builder's confinement", () => {
  it("allows files and the repository's own checks, and no tool that reaches further", () => {
    expect(BUILDER_TOOLS).toContain("Read");
    expect(BUILDER_TOOLS).toContain("Bash(npm test:*)");
    expect(BUILDER_TOOLS).toContain("Bash(npm run format:*)");
    for (const tool of ["Bash", "WebFetch", "WebSearch", "Task", "Agent", "Skill"]) {
      expect(BUILDER_TOOLS).not.toContain(tool);
    }
    const shellRules = BUILDER_TOOLS.filter((tool) => tool.startsWith("Bash("));
    expect(shellRules.every((tool) => !/git (push|commit|remote)|curl|gh /.test(tool))).toBe(true);
  });

  it("starts headless, never asks, loads no MCP server and caps the cost", () => {
    const args = builderArgs("/s/settings.json", "/s/mcp.json", 4);
    expect(args.slice(0, 5)).toEqual(["-p", "--output-format", "json", "--permission-mode", "dontAsk"]);
    expect(args[args.indexOf("--allowedTools") + 1]).toBe(BUILDER_TOOLS.join(","));
    expect(args[args.indexOf("--max-budget-usd") + 1]).toBe("4");
    expect(args[args.indexOf("--settings") + 1]).toBe("/s/settings.json");
    expect(args).toContain("--strict-mcp-config");
  });

  it("denies the folder that holds the lab's checkouts, for every file tool, in both spellings of the drive", () => {
    const deny = builderDeny("D:\\Projects\\FaultForge", "D:\\Projects\\FaultForge\\private");
    expect(deny).toContain("Read(//d/Projects/**)");
    expect(deny).toContain("Read(//D/Projects/**)");
    expect(deny).toContain("Grep(//d/Projects/**)");
  });

  it("denies private storage too when it is configured somewhere else", () => {
    const deny = builderDeny("/home/me/work/faultforge", "/srv/evidence/private");
    expect(deny).toContain("Read(//home/me/work/**)");
    expect(deny).toContain("Read(//srv/evidence/private/**)");
    expect(deny).toContain("Glob(//srv/evidence/private/**)");
    expect(new Set(deny).size).toBe(deny.length);
  });

  it("gives the builder, and an install, no variable of this project, of Qodo or of GitHub", () => {
    const env = plainEnv({
      PATH: "/bin",
      FAULTFORGE_PRIVATE_DIR: "/p",
      faultforge_config: "/c",
      QODO_KEY_FILE: "/k",
      GH_TOKEN: "t",
      GITHUB_TOKEN: "t",
      HOME: "/home/me",
    });
    expect(env).toEqual({ PATH: "/bin", HOME: "/home/me" });
  });
});

describe("addedSince", () => {
  it("keeps only the lines the later diff adds that the earlier one did not", () => {
    const before = ["+++ b/src/a.ts", "+const limit = 2800;", " unchanged"].join("\n");
    const after = ["+++ b/src/a.ts", "+const limit = 2800;", "+const extra = 1;", "-removed", " unchanged"].join("\n");
    expect(addedSince(before, after)).toBe("+const extra = 1;");
    expect(addedSince(before, before)).toBe("");
  });
});

describe("changeProblems", () => {
  const diff = (...added: string[]) => ["+++ b/test/a.test.ts", ...added.map((line) => `+${line}`)].join("\n");

  it("finds nothing in an ordinary fix and its test", () => {
    const ordinary = diff(
      'import { createBooking } from "../src/bookings/create.ts";',
      'it("replays a booking", async () => {',
      "  expect(second.statusCode).toBe(200);",
      "});",
    );
    expect(changeProblems(ordinary)).toEqual([]);
    expect(changeProblems("")).toEqual([]);
  });

  it("names an absolute path, on any system", () => {
    for (const line of [
      'readFileSync("C:/Users/me/secret.txt")',
      "readFileSync('D:\\\\Projects\\\\x')",
      'readFileSync("/home/me/x")',
      'readFileSync("/Users/me/x")',
      "const p = `~/x`;",
    ]) {
      expect(changeProblems(diff(line))).toContain("an added line holds an absolute path");
    }
  });

  it("names a climb of two or more folders, but not an ordinary import from the source folder", () => {
    expect(changeProblems(diff('import x from "../../other/x.ts";'))).toContain(
      "an added line climbs two or more folders up",
    );
    expect(changeProblems(diff('import x from "../src/x.ts";'))).toEqual([]);
  });

  it("names a reach for the environment, the home folder or another process", () => {
    for (const line of ["const k = process.env.KEY;", "homedir()", 'import { exec } from "node:child_process";']) {
      expect(changeProblems(diff(line)).join(" ")).toMatch(/reaches for the environment/);
    }
  });

  it("names a word that gives the lab away, without repeating it", () => {
    const problems = changeProblems(diff("// see the FaultForge answer key"));
    expect(problems.join(" ")).toMatch(/a word that names the lab/);
    expect(problems.join(" ")).not.toMatch(/FaultForge/i);
  });

  it("reads only added lines: a removed or unchanged line is not the builder's writing", () => {
    expect(changeProblems(['-readFileSync("C:/x")', ' readFileSync("C:/y")'].join("\n"))).toEqual([]);
  });
});
