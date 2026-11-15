import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { COMMAND_KINDS } from "../../packages/harness/src/target-post.ts";
import { decide } from "./factory-policy.ts";
import { AGENT_DOOR_KINDS, doorKindViolation } from "./factory-policy-door.ts";
import { GROWTH_FACTOR, growth, LINEAR_BOUND } from "./fixtures.ts";

const RUN = resolve("/runs/20261115-0100-target-7");
const RUN_ENV = { FAULTFORGE_FACTORY_RUN: "test", FAULTFORGE_RUN_ROOT: RUN };
const OUTSIDE = { FAULTFORGE_FACTORY_RUN: "", FAULTFORGE_RUN_ROOT: "" };
const bash = (command: string) => JSON.stringify({ tool_name: "Bash", cwd: RUN, tool_input: { command } });
const door = (kind: string) => `npm run target:post -- ${kind} --repo Owner/app --number 3 --body-file b.md`;

const allowed: readonly string[] = AGENT_DOOR_KINDS;
const others = COMMAND_KINDS.filter((kind) => !allowed.includes(kind));

describe("factory policy: the door kinds a run's agent may use (#347)", () => {
  it("allows push, pr-create and pr-edit, and every one is a kind the door takes", () => {
    expect([...AGENT_DOOR_KINDS]).toEqual(["push", "pr-create", "pr-edit"]);
    for (const kind of AGENT_DOOR_KINDS) expect(COMMAND_KINDS).toContain(kind);
  });

  it("has a refusal test below for each of the door's other kinds", () => {
    expect([...others].sort()).toEqual(["issue-comment", "issue-create", "issue-edit", "pr-close", "pr-comment"]);
  });

  it.each(others)("refuses %s during a run, naming the allowed kinds", (kind) => {
    const decision = decide(bash(door(kind)), RUN_ENV);
    expect(decision).toMatchObject({ kind: "deny" });
    expect((decision as { reason: string }).reason).toContain("takes only push, pr-create, pr-edit");
  });

  it.each([
    "npm run target:post -- push --repo Owner/app --branch tidy",
    "npm run target:post -- pr-create --repo Owner/app --head tidy --title-file t.md --body-file b.md",
    "npm run target:post -- pr-edit --repo Owner/app --number 3 --body-file b.md",
    // Qodo on PR 349: a branch may carry any name, a kind's included.
    "npm run target:post -- push --repo Owner/app --branch pr-comment",
  ])("lets %s through during a run", (command) => {
    expect(decide(bash(command), RUN_ENV)).toEqual({ kind: "allow" });
  });

  it.each(COMMAND_KINDS.map((kind) => door(kind)))("leaves the owner's %s alone outside a run", (command) => {
    expect(decide(bash(command), OUTSIDE)).toEqual({ kind: "allow" });
  });

  it.each([
    ["a kind split by empty quotes", "npm run target:post -- pr-co''mment --number 3 --body-file b.md"],
    ["a kind in a variable", 'npm run target:post -- "$K" --number 3 --body-file b.md'],
    ["npm's own options first", "npm run target:post --silent -- pr-close --number 3 --body-file b.md"],
    ["the run-script spelling", "npm run-script target:post -- issue-create --title-file t --body-file b"],
    ["inside bash -c", 'bash -c "npm run target:post -- pr-comment --number 3 --body-file b.md"'],
    ["inside a substitution", "echo $(npm run target:post -- pr-comment --number 3 --body-file b.md)"],
    ["after an allowed call", "npm run target:post -- push --branch x && npm run target:post -- pr-close --number 3"],
    ["a kind from a pipe", "echo pr-close | xargs npm run target:post --"],
    ["the door's script run by path", "node packages/harness/src/target-post-cli.ts issue-comment --number 3"],
    ["the door's script by path, kind in a variable", 'npx tsx packages/harness/src/target-post-cli.ts "$K"'],
    ["the door's module in inline code", `node -e "import('./packages/harness/src/target-post.ts').then(m => m)"`],
    ["the runner's send function", "npx tsx scripts/x.ts sendPost"],
    ["the door run from code", `node -e "require('child_process').execSync('npm run target:post -- ' + k)"`],
    // Qodo on PR 349, round 1: a backslash bash drops, and the script's name in a variable.
    ["an escaped colon in the script's name", "npm run target\\:post -- pr-close --number 3 --body-file b.md"],
    ["the script's name in a variable", 'export S=target:post; npm run "$S" -- pr-close --number 3 --body-file b.md'],
    ["an escaped colon with a kind in a variable", 'npm run target\\:post -- "$K" --number 3 --body-file b.md'],
    // Round 2: an npm option's value taken for the subcommand, and a module and kind passed in variables.
    ["npm options with values", 'K=issue-comment npm --prefix . run target:post -- "$K" --number 3'],
    ["a workspace option", 'npm -w pkg run "$S" -- "$K" --number 3'],
    [
      "a module and kind assembled in code",
      `M=target-post.ts K=issue-comment node -e 'import("./packages/harness/src/"+process.env.M).then(m=>m.main([process.env.K,"--repo","Owner/app","--number","3","--body-file","b.md"]))'`,
    ],
    ["a module path from a variable alone", `node -e 'import(process.env.M).then(m => m.main(["x"]))'`],
    ["a script path in a variable", 'node "$P" pr-comment --number 3'],
    ["yarn's shorthand", 'yarn "$S" -- "$K" --number 3'],
    ["node --run", 'node --run "$S" -- "$K" --number 3'],
    ["a subcommand in a variable", 'npm "$R" target:post -- "$K" --number 3'],
  ])("refuses %s", (_name, command) => {
    expect(doorKindViolation(command)).toBeDefined();
    expect(decide(bash(command), RUN_ENV)).toMatchObject({ kind: "deny" });
  });

  it.each([
    // Qodo on PR 349: reading the door's files, or searching for a kind, runs nothing.
    "cat packages/harness/src/target-post.ts README",
    "grep sendPost packages/harness/src/target-post.ts",
    "grep -R pr-close packages/harness/src",
    "cat packages/harness/src/target-post.ts",
    "npx vitest run packages/harness/src/target-post.test.ts",
    `node -e "console.log(require('node:fs').readdirSync('.'))"`,
    `node -e "require(\\"node:fs\\")"`,
    "npm run check",
    "npm test -- --grep 'a (b)'",
    "git push origin tidy",
  ])("doesn't refuse %s", (command) => {
    expect(doorKindViolation(command)).toBeUndefined();
  });

  it("decides in time linear in the command's length", () => {
    expect(GROWTH_FACTOR).toBeGreaterThan(1);
    const ratio = growth((k) => {
      doorKindViolation("npm run target:post -- push ".repeat(200 * k));
      doorKindViolation(`npm run target:post ${"--x ".repeat(1000 * k)}`);
      doorKindViolation(`node -e "${"import('./a.ts');".repeat(200 * k)}"`);
    });
    expect(ratio).toBeLessThan(LINEAR_BOUND);
  });
});
