import { describe, expect, it } from "vitest";
import { BUILDER_TOOLS, builderArgs, builderDeny, builderEnv, NO_PUSH, readLocalReview } from "./gate-trial-real.ts";

/** An answer in the shape `qodo review --json` gives: findings with a `location`, and state lists of ids. */
function answer(extra: object = {}): Record<string, unknown> {
  return {
    findings: [
      {
        id: "f1",
        title: "A retry is refused",
        description: "The second call fails.",
        category: "Correctness",
        action_level: "action_required",
        location: { file_path: "src/a.ts", start_line: 23, end_line: 27, side: "right" },
      },
      {
        id: "f2",
        title: "No test",
        category: "Testability",
        action_level: "remediation_recommended",
        location: { file_path: "src/a.ts", start_line: 23, end_line: 26 },
      },
    ],
    finding_state: { complete: false, introduced: ["f1", "f2"], resolved: [], still_open: [], dismissed: [] },
    meta: { coverage: { complete: true }, skipped_files: [] },
    ...extra,
  };
}
const read = (payload: unknown, trace = "") => readLocalReview(`${JSON.stringify(payload)}${trace}`, "saved.json");

describe("readLocalReview", () => {
  it("reads every open finding with its label, file and lines, and where the answer was saved", () => {
    const review = read(answer());
    expect(review.complete).toBe(true);
    expect(review.evidence).toBe("saved.json");
    expect(review.open).toEqual([
      {
        id: "f1",
        severity: "action_required",
        title: "A retry is refused",
        category: "Correctness",
        file: "src/a.ts",
        lines: [23, 27],
        description: "The second call fails.",
      },
      {
        id: "f2",
        severity: "remediation_recommended",
        title: "No test",
        category: "Testability",
        file: "src/a.ts",
        lines: [23, 26],
        description: null,
      },
    ]);
  });

  it("reads an answer that ends with the CLI's trace line", () => {
    expect(read(answer(), "\n  trace 3a27381a47e9d9b7ec6cb123f79a30b8\n").open).toHaveLength(2);
  });

  it("leaves out a finding the answer lists as resolved or dismissed, by id or as a whole finding", () => {
    const state = { resolved: ["f1"], dismissed: [{ id: "f2" }] };
    expect(read(answer({ finding_state: state })).open).toEqual([]);
  });

  it("keeps a finding with no label or no place: the gate decides what an unlabelled finding means", () => {
    const review = read(answer({ findings: [{ id: "f3", title: "Odd" }] }));
    expect(review.open).toEqual([
      { id: "f3", severity: null, title: "Odd", category: null, file: null, lines: null, description: null },
    ]);
  });

  it("is incomplete, never clean, when coverage wasn't complete or a file was skipped", () => {
    expect(read(answer({ meta: { coverage: { complete: false } } })).complete).toBe(false);
    expect(read(answer({ meta: {} })).complete).toBe(false);
    expect(read(answer({ meta: { coverage: { complete: true }, skipped_files: ["src/b.ts"] } })).complete).toBe(false);
  });

  it("is incomplete with nothing open for an error answer, a missing findings list, or output that isn't JSON", () => {
    for (const out of [
      { error: { message: "base commit is not pushed" } },
      { meta: { coverage: { complete: true } } },
    ]) {
      expect(read(out)).toEqual({ complete: false, open: [], evidence: "saved.json" });
    }
    expect(readLocalReview("", "saved.json").complete).toBe(false);
    expect(readLocalReview("not json", "saved.json").complete).toBe(false);
    expect(read(null).complete).toBe(false);
  });

  it("is incomplete when a finding can't be read, so a broken entry never drops out silently", () => {
    expect(read(answer({ findings: [{ title: "No id" }] })).complete).toBe(false);
    expect(read(answer({ findings: ["text"] })).complete).toBe(false);
  });
});

describe("the builder's confinement", () => {
  it("allows files and the repository's own checks, and no tool that reaches further", () => {
    expect(BUILDER_TOOLS).toContain("Read");
    expect(BUILDER_TOOLS).toContain("Bash(npm test:*)");
    for (const tool of ["Bash", "WebFetch", "WebSearch", "Task", "Agent", "Skill"]) {
      expect(BUILDER_TOOLS).not.toContain(tool);
    }
    expect(
      BUILDER_TOOLS.filter((t) => t.startsWith("Bash(")).every((t) => !/git (push|commit|remote)|curl|gh /.test(t)),
    ).toBe(true);
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
    const deny = builderDeny("D:\\Projects\\FaultForge");
    expect(deny).toContain("Read(//d/Projects/**)");
    expect(deny).toContain("Read(//D/Projects/**)");
    expect(deny).toContain("Grep(//d/Projects/**)");
    expect(deny).toHaveLength(10);
    expect(builderDeny("/home/me/work/faultforge")).toContain("Read(//home/me/work/**)");
  });

  it("passes the builder no variable of this project, of Qodo or of GitHub", () => {
    const env = builderEnv({
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

  it("uses a push address no host answers", () => {
    expect(NO_PUSH).toMatch(/^no-push:/);
  });
});
