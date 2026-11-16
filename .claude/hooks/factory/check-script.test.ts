/**
 * A factory run may change a package.json, but not the check script or any script the check runs
 * (factory/check-script.ts), by a file tool or a shell command. The run folder is made up under the temp folder.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { policyRun } from "../fixtures.ts";
import { CHECK_SCRIPT_EDIT, checkScriptNames, checkScriptViolation } from "./check-script.ts";

const { LAB, policy } = policyRun("policy-run7-", true);

describe("a run can't change the check script", () => {
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
    // node --run runs no pre or post script (Qodo on PR 339, second round).
    expect(names).toContain("prea");
    expect(names).not.toContain("pree");
    expect(names).not.toContain("poste");
  });

  it("reads t and tst as test only in npm's shorthand, never after run (Qodo on PR 339, third round)", () => {
    expect(checkScriptNames({ check: "npm run t && node --run tst" })).toContain("t");
    expect(checkScriptNames({ check: "npm run t && node --run tst" })).toContain("tst");
    expect(checkScriptNames({ check: "npm t" })).toContain("test");
    expect(checkScriptNames({ check: "npm run t" })).not.toContain("test");
    // A node option before --run (Qodo on PR 339, fourth review).
    expect(checkScriptNames({ check: "node --no-warnings --run lint" })).toContain("lint");
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
