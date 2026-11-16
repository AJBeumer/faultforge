/**
 * How the hooks scan a shell command: a backslash-newline joined as the shell joins it, and every command, however
 * crafted, read in time linear in its length, up to the most the guard reads. Folders are made up under the temp
 * folder; the private template id is made up.
 */
import { describe, expect, it } from "vitest";
import {
  askGuard,
  growth,
  guardConfig,
  LINEAR_BOUND,
  privateStore,
  REPOS,
  scratchFolder,
  tempRepo,
} from "../fixtures.ts";
import { joinContinuations, MAX_COMMAND_CHARS } from "./scan.ts";

describe("a backslash-newline is joined as the shell joins it", () => {
  const config = guardConfig(tempRepo(true).dir);
  const privateDir = privateStore("guard~regrade4-");
  const elsewhere = scratchFolder("guard-elsewhere-");
  const bash = (command: string) => askGuard("Bash", { command }, elsewhere, { config, privateDir });

  it("joins continuations outside single quotes and leaves them inside", () => {
    expect(joinContinuations('a "pla\\\nnted" b\\\nc')).toBe('a "planted" bc');
    expect(joinContinuations("a 'pla\\\nnted'")).toBe("a 'pla\\\nnted'");
    expect(joinContinuations("x \\\r\ny")).toBe("x y");
    expect(joinContinuations("cat <<'E'\npla\\\nnted\nE")).toBe("cat <<'E'\npla\\\nnted\nE");
    expect(joinContinuations("cat <<E\npla\\\nnted\nE")).toBe("cat <<E\nplanted\nE");
    expect(joinContinuations("a \\\\\nb")).toBe("a \\\\\nb");
  });

  it("refuses a private id split by a continuation, even in a lab post", () => {
    expect(bash(`gh pr comment 3 -R ${REPOS.lab} -b "see x-sec\\\nret-v1"`)).toMatch(/still private/);
  });

  it("refuses a link to the target split by a continuation", () => {
    const command = `gh issue comment 5 -R ${REPOS.lab} --body "see https://github.com/${REPOS.target.replace("target", "tar\\\nget")}/pull/3"`;
    expect(bash(command)).toMatch(/link to the target/);
  });
});

describe("a crafted command can't outrun the hook (AUD-M4)", () => {
  const config = guardConfig(tempRepo(true).dir);
  const privateDir = privateStore("guard~private-", ["idempotency-guard-bypass-v1"]);
  const bash = (command: string) => askGuard("Bash", { command }, "D:\\Projects\\FaultForge", { config, privateDir });
  const post = 'gh pr create --repo AJBeumer/faultforge-target --title Tidy --body "planted bug" ';
  // At `k` quarters of the old wall-clock test's 6 KB; `growth` compares k = 1 with k = 8 (re-grade 7).
  it.each([
    ["heredoc openers in a comment", (k: number) => `${post}# ${"<<A ".repeat(113 * k)}${"\n".repeat(1125 * k)}`],
    ["heredoc openers in the open", (k: number) => `${post}${"<<A ".repeat(200 * k)}\n${"x\n".repeat(375 * k)}`],
    ["unclosed quotes", (k: number) => `${post}${"\"'".repeat(375 * k)}${"\n".repeat(750 * k)}`],
    ["repeated git words", (k: number) => `${post}; ${"git ".repeat(375 * k)}`],
    ["repeated cd words", (k: number) => `${post}; ${"cd ".repeat(500 * k)}`],
    ["repeated flags", (k: number) => `${post}${"-m -t -b -F ".repeat(125 * k)}`],
  ])("decides %s in time linear in the command's length", (_name, make) => {
    expect(make(4).length).toBeGreaterThan(6000);
    expect(bash(make(4))).toBeDefined();
    expect(growth((k) => bash(make(k)))).toBeLessThan(LINEAR_BOUND);
  });

  it("refuses a command longer than it reads", () => {
    expect(bash(`echo ${"x".repeat(MAX_COMMAND_CHARS)}`)).toMatch(/more than the \d+ the guard reads/);
  });
});
