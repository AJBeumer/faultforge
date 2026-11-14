/**
 * The guard against text built from a file or a program, GraphQL mutations and other writes, look-alike
 * characters, and commands that switch off git's own guard (#242).
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { guardConfig, tempRepo } from "./fixtures.ts";
import { decide } from "./guard-target.ts";

const LAB = "D:\\Projects\\FaultForge";
const TARGET = "D:\\Projects\\faultforge-target";
const CONFIG = guardConfig(tempRepo(true).dir);
const NO_PRIVATE = join(tmpdir(), "guard-built-no-private-folder");

function verdict(tool: string, command: string, cwd = LAB): string | undefined {
  const payload = JSON.stringify({ tool_name: tool, cwd, tool_input: { command } });
  const decision = decide(payload, { ...process.env, FAULTFORGE_CONFIG: CONFIG, FAULTFORGE_PRIVATE_DIR: NO_PRIVATE });
  if (decision.kind === "error") throw new Error(decision.message);
  return decision.kind === "deny" ? decision.reason : undefined;
}
const bash = (command: string, cwd?: string) => verdict("Bash", command, cwd);
const powershell = (command: string, cwd?: string) => verdict("PowerShell", command, cwd);

/** A file holding `text`, by a path with forward slashes that every shell reads the same way. */
function file(text: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "guard-built-")), "notes.txt");
  writeFileSync(path, text);
  return path.replace(/\\/g, "/");
}

const R = "-R AJBeumer/faultforge-target";

describe("text built from a file is read and checked (#242)", () => {
  const giveaway = file("Fixes the planted bug\n");
  const clean = file("Filter bookings by status.\n");

  it.each([
    ["--body with $(cat f)", (f: string) => `gh pr create ${R} --title Tidy --body "$(cat ${f})"`],
    ["--body with $(< f)", (f: string) => `gh pr create ${R} --title Tidy --body "$(< ${f})"`],
    ["--body with backticks", (f: string) => `gh pr create ${R} --title Tidy --body "\`cat ${f}\`"`],
    ["a pipe into --body-file -", (f: string) => `cat ${f} | gh pr create ${R} --title Tidy --body-file -`],
    ["a PR comment with $(cat f)", (f: string) => `gh pr comment 3 ${R} --body "$(cat ${f})"`],
  ])("denies %s when the file holds a giveaway word, and allows a clean one", (_name, command) => {
    expect(bash(command(giveaway))).toMatch(/says planted/);
    expect(bash(command(clean))).toBeUndefined();
  });

  it("denies $(Get-Content f) in PowerShell", () => {
    expect(powershell(`gh pr create ${R} --title Tidy --body "$(Get-Content ${giveaway})"`)).toMatch(/says planted/);
    expect(powershell(`gh pr create ${R} --title Tidy --body "$(Get-Content -Raw ${clean})"`)).toBeUndefined();
  });

  it("refuses a body built by a program, as a substitution or a pipe", () => {
    expect(bash(`gh pr create ${R} --title Tidy --body "$(node -e "console.log('hi')")"`)).toMatch(/can't check/);
    expect(bash(`node gen.js | gh pr create ${R} --title Tidy --body-file -`)).toMatch(/piped in|must run on its own/);
  });

  it("refuses a program's output wherever it sits in a post to a reviewed repo (Qodo on PR 266)", () => {
    expect(bash(`gh pr create ${R} --head "$(echo tidy-list)" --title Tidy --body "Small cleanup."`)).toMatch(
      /can't check/,
    );
    expect(bash(`gh label create "$(node -e 'x')" ${R}`)).toMatch(/can't check/);
    expect(bash(`gh pr create ${R} --title Tidy --body="Notes"$(cat ${giveaway})`)).toMatch(/says planted|can't check/);
    expect(bash(`node gen.js | cat | gh pr comment 1 ${R} --body-file -`)).toMatch(/piped in|must run on its own/);
    expect(bash(`cat <(node gen.js) | gh pr comment 1 ${R} --body-file -`)).toMatch(/program|must run on its own/);
    expect(powershell(`gh pr comment 1 ${R} --body (node -e "x")`)).toMatch(/program/);
  });

  it("reads past a redirect after a piped file, and leaves PowerShell's escaped text alone (Qodo on PR 266)", () => {
    expect(bash(`cat ${clean} 2>/dev/null | gh pr comment 12 ${R} --body-file -`)).toBeUndefined();
    expect(powershell(`gh pr comment 12 ${R} --body "Write \`$(node) in the docs"`)).toBeUndefined();
  });

  it("counts only the GraphQL keyword as harmless, not a body's own word (Qodo on PR 266)", () => {
    const body = file('{"query":"mutation { addComment(input: {body: \\"mutation testing\\"}) { x } }"}');
    expect(bash(`gh api graphql --input ${body}`)).toMatch(/says mutation/);
  });

  it("reads a substituted file in a lab post for a link to the target", () => {
    const link = file("see https://github.com/AJBeumer/faultforge-target/issues/3\n");
    expect(bash(`gh issue create --title x --body "$(cat ${link})"`)).toMatch(/link to the target/);
  });
});

describe("other ways to write to a reviewed repo (#242)", () => {
  it("denies a GraphQL mutation with a giveaway word or a lab link", () => {
    const mutation = (body: string) =>
      `gh api graphql -f query='mutation { addComment(input: {subjectId: "X", body: "${body}"}) { clientMutationId } }'`;
    expect(bash(mutation("the planted bug"))).toMatch(/says planted/);
    expect(bash(mutation("see https://github.com/AJBeumer/faultforge/issues/3"))).toMatch(/names the lab/);
    expect(bash(mutation("Thanks, merged."))).toBeUndefined();
  });

  it("checks gh repo edit, gh workflow run and git notes add", () => {
    expect(bash('gh repo edit AJBeumer/faultforge-target --description "FaultForge test bed"')).toMatch(
      /names the lab/,
    );
    expect(bash(`gh workflow run ci.yml ${R} -f note="planted bug"`)).toMatch(/says planted/);
    expect(bash('git notes add -m "the planted bug"', TARGET)).toMatch(/says planted/);
    expect(bash('gh repo edit AJBeumer/faultforge-target --description "Booking API"')).toBeUndefined();
  });
});

describe("look-alike and invisible characters (#242)", () => {
  it.each([
    ["a Cyrillic a", "Fix the pl\u0430nted bug"],
    ["a Cyrillic o and e", "Update the l\u0435dg\u0435r for c\u043ese"],
    ["a zero-width space", "Fault\u200BForge"],
    ["a non-breaking hyphen in a case id", "FF\u20110012"],
    ["full-width letters", "\uFF50\uFF4C\uFF41\uFF4E\uFF54\uFF45\uFF44 bug"],
  ])("catches a word written with %s", (_name, message) => {
    expect(bash(`git commit -m "${message}"`, TARGET)).toBeDefined();
  });
});

describe("git's own guard can't be switched off in a reviewed checkout (#242)", () => {
  it.each([
    'git commit --no-verify -m "Tidy"',
    'git commit -nm "Tidy"',
    'git commit -n -m "Tidy"',
    "git push --no-verify origin tidy",
    "git -c core.hooksPath=/dev/null push origin tidy",
    "git config core.hooksPath .nothing",
    'git "--no-verify" commit -m Tidy',
    'git commit "-n" -m Tidy',
    "git commit --no-veri -m Tidy",
    "git push --no-verif origin tidy",
    'git -c "$KEY=/dev/null" push origin tidy',
  ])("denies %s", (command) => {
    expect(bash(command, TARGET)).toMatch(/guard hooks must run/);
  });

  it("allows -n inside a message, and --no-verify outside a reviewed checkout", () => {
    expect(bash('git commit -m "Handle the -n option"', TARGET)).toBeUndefined();
    expect(bash('git commit --no-verify -m "Tidy"', LAB)).toBeUndefined();
  });
});

describe("holes found in the second review of PR 266", () => {
  it("counts a GraphQL query read from a file, in any spelling, as a mutation", () => {
    // Named relative to the folder it runs in, so only the file's text can be what is refused.
    const query = file('mutation { addComment(input: {body: "the planted bug"}) { x } }');
    const dir = join(query, "..");
    expect(bash("gh api graphql --field query=@notes.txt", dir)).toMatch(/says planted/);
    expect(bash('gh api graphql -F "query=@notes.txt"', dir)).toMatch(/says planted/);
  });

  it("finds the repo of gh repo edit after its flags, and in a quote-split gh", () => {
    expect(bash('gh repo edit --description "planted bug" AJBeumer/faultforge-target')).toMatch(/says planted/);
    expect(bash("g''h repo edit AJBeumer/faultforge-target --description 'planted bug'")).toMatch(/says planted/);
  });

  it("reads a file behind a nested substitution in a lab post", () => {
    const link = file("see https://github.com/AJBeumer/faultforge-target/issues/3\n");
    expect(bash(`gh issue create --title x --body "$(echo $(cat ${link}))"`)).toMatch(/link to the target/);
  });

  it("refuses a post chained after a step that could rewrite the file it reads", () => {
    const notes = file("Small cleanup.\n");
    expect(bash(`node gen.js > ${notes}; gh pr comment 1 ${R} --body "$(cat ${notes})"`)).toMatch(
      /must run on its own/,
    );
  });

  it("decides a long run of git options that never reaches -C in well under a second", () => {
    const started = performance.now();
    bash(`git ${"--a ".repeat(200)}log`);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
