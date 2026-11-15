/**
 * The factory policy's share of the seventh re-grade (#338): a run may not read stored git credentials, another
 * process's environment through `ps`, or change the check script in package.json (or a script it runs).
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decide } from "./factory-policy.ts";
import { CHECK_SCRIPT_EDIT, checkScriptNames, checkScriptViolation } from "./factory-policy-check.ts";

const RUN = mkdtempSync(join(tmpdir(), "policy-run7-"));
const LAB = join(RUN, "faultforge");
mkdirSync(LAB, { recursive: true });
const ENV: NodeJS.ProcessEnv = {
  FAULTFORGE_FACTORY_RUN: "1",
  FAULTFORGE_RUN_ROOT: RUN,
  FAULTFORGE_TICKET_NUMBER: "999",
};

function policy(tool: string, input: object, cwd = LAB): string | undefined {
  const decision = decide(JSON.stringify({ tool_name: tool, cwd, tool_input: input }), ENV);
  if (decision.kind === "error") throw new Error(decision.message);
  return decision.kind === "deny" ? decision.reason : undefined;
}

describe("a run can't read stored credentials (re-grade 7)", () => {
  it.each([
    "printf 'host=github.com\\nprotocol=https\\n' | git credential fill",
    "git credential fill < req.txt",
    "git -c credential.helper= credential fill",
    "git -C repo credential approve",
    "git credential-store get",
    "git credential-manager get",
    "git-credential-manager get",
    "/usr/lib/git-core/git-credential-store get",
    "gh auth git-credential get",
  ])("refuses %s", (command) => {
    expect(policy("Bash", { command })).toMatch(/stored credentials/);
  });

  it("lets a commit message that says credential through", () => {
    expect(policy("Bash", { command: "git commit -F msg.txt" })).toBeUndefined();
    expect(policy("Bash", { command: 'git log --grep "credential fill"' })).toBeUndefined();
  });
});

describe("a run can't read another process's environment through ps (re-grade 7)", () => {
  it.each([
    "ps e",
    "ps eww",
    "ps eww -o command",
    "ps auxe",
    "ps axeww",
    "ps e -o pid,command",
    "ps -o pid -e e",
    "sudo ps e",
    "/bin/ps e",
    // Behind a value, an assignment or a shell (Qodo on PR 339).
    "ps -p 1 e",
    "ps -o pid,args e",
    "A=1 ps e",
    'sh -c "ps e"',
    "timeout 5 ps e",
  ])("refuses %s", (command) => {
    expect(policy("Bash", { command })).toMatch(/environment/);
  });

  it.each([
    "ps aux",
    "ps -ef",
    "ps -o pid,user",
    "ps -o user -p 1",
    "ps -e | grep node",
    // A format list after a combined option (Qodo on PR 339).
    "ps -eo pid,user",
    "ps -axo pid,etime,args",
    "ps -eo pid,ppid,cmd,%mem --sort=-%mem",
  ])("lets %s through", (command) => {
    expect(policy("Bash", { command })).toBeUndefined();
  });
});

describe("a run can't change the check script (re-grade 7)", () => {
  const PKG = {
    name: "x",
    scripts: {
      check: "npm run typecheck && npm run -s lint && npm test",
      typecheck: "tsc",
      lint: "biome check .",
      test: "vitest run",
      dev: "tsx watch src/server.ts",
    },
    dependencies: { a: "1.0.0" },
  };
  const pkgPath = () => {
    const dir = mkdtempSync(join(LAB, "pkg-"));
    const path = join(dir, "package.json");
    writeFileSync(path, `${JSON.stringify(PKG, null, 2)}\n`);
    return path;
  };

  it("follows the check through every script it runs, and each one's pre and post script", () => {
    const names = checkScriptNames(PKG.scripts);
    for (const name of ["check", "lint", "test", "typecheck", "precheck", "postcheck", "pretest", "postlint"])
      expect(names).toContain(name);
    expect(names).not.toContain("dev");
    expect(names).not.toContain("preprecheck");
  });

  it("follows npm with flags before run, npm -s test, yarn, pnpm and bun shorthand, and node --run (Qodo on PR 339)", () => {
    const names = checkScriptNames({
      check: "npm --silent run a && npm -s test && yarn b && pnpm c && bun run d && node --run e",
    });
    for (const name of ["a", "test", "b", "c", "d", "e"]) expect(names).toContain(name);
  });

  it("refuses adding a precheck script, which npm runs before the check (Qodo on PR 339)", () => {
    const path = pkgPath();
    expect(
      policy("Edit", { file_path: path, old_string: '"check":', new_string: '"precheck": "exit 0",\n    "check":' }),
    ).toContain(CHECK_SCRIPT_EDIT);
  });

  it.each([
    "npm pkg set scripts.check=true",
    "npm pkg set 'scripts.test'='echo ok'",
    "npm pkg delete scripts.lint",
    "npm pkg set --json 'scripts={}'",
    "npm set-script check true",
    "pnpm pkg set scripts.check=true",
  ])("refuses %s", (command) => {
    expect(policy("Bash", { command })).toMatch(/package\.json's scripts/);
  });

  it.each([`sed -i 's/vitest run/true/' package.json`, "echo '{}' > package.json", "cp /tmp/p.json package.json"])(
    "refuses a shell write to package.json: %s",
    (command) => {
      expect(policy("Bash", { command })).toMatch(/package\.json with the Edit or Write tool/);
    },
  );

  it("lets npm install and a read of package.json through", () => {
    expect(policy("Bash", { command: "npm install --save-dev vitest" })).toBeUndefined();
    expect(policy("Bash", { command: "cat package.json" })).toBeUndefined();
    expect(policy("Bash", { command: "npm pkg set version=1.2.3" })).toBeUndefined();
  });

  it("refuses an Edit, a MultiEdit or a Write that changes the check or a script it runs", () => {
    const path = pkgPath();
    const text = readFileSync(path, "utf8");
    expect(policy("Edit", { file_path: path, old_string: '"vitest run"', new_string: '"true"' })).toContain(
      CHECK_SCRIPT_EDIT,
    );
    expect(policy("Edit", { file_path: path, old_string: '"check":', new_string: '"check0":' })).toContain(
      CHECK_SCRIPT_EDIT,
    );
    expect(
      policy("MultiEdit", {
        file_path: path,
        edits: [{ old_string: '"tsc"', new_string: '"echo"' }],
      }),
    ).toContain(CHECK_SCRIPT_EDIT);
    expect(policy("Write", { file_path: path, content: text.replace("biome check .", "true") })).toContain(
      CHECK_SCRIPT_EDIT,
    );
    expect(policy("Write", { file_path: path, content: "not json" })).toMatch(/must stay a JSON object/);
  });

  it("lets other package.json edits through, and a new package.json", () => {
    const path = pkgPath();
    const text = readFileSync(path, "utf8");
    expect(policy("Edit", { file_path: path, old_string: '"1.0.0"', new_string: '"1.1.0"' })).toBeUndefined();
    expect(
      policy("Edit", { file_path: path, old_string: "tsx watch", new_string: "tsx watch --clear-screen=false" }),
    ).toBeUndefined();
    expect(policy("Write", { file_path: path, content: text.replace('"x"', '"y"') })).toBeUndefined();
    expect(checkScriptViolation("Write", { content: "{}" }, join(LAB, "new", "package.json"))).toBeUndefined();
    expect(checkScriptViolation("Write", { content: "{}" }, join(LAB, "notes.json"))).toBeUndefined();
  });
});
