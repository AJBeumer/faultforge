/**
 * Two refusals of harmless local work (#318), lifted without reopening a hole: inline `node -e` code that only
 * reads files and prints, and a file outside every checkout (a temp or scratch folder) that names a private
 * template. The private id is made up.
 */
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { guardConfig, tempRepo } from "./fixtures.ts";
import { decide } from "./guard-target.ts";
import { BUILT_CODE_REASON, INLINE_NETWORK_REASON } from "./shell-exec.ts";

const TARGET = tempRepo(true);
const CONFIG = guardConfig(TARGET.dir);
const PRIVATE = (() => {
  const dir = mkdtempSync(join(tmpdir(), "guard~local-private-"));
  mkdirSync(join(dir, "templates", "x-secret-v1"), { recursive: true });
  return dir;
})();
const SCRATCH = mkdtempSync(join(tmpdir(), "guard-scratch-"));

function decision(tool: string, input: object, cwd = SCRATCH): string | undefined {
  const payload = JSON.stringify({ tool_name: tool, cwd, tool_input: input });
  const result = decide(payload, { ...process.env, FAULTFORGE_CONFIG: CONFIG, FAULTFORGE_PRIVATE_DIR: PRIVATE });
  if (result.kind === "error") throw new Error(result.message);
  return result.kind === "deny" ? result.reason : undefined;
}
const bash = (command: string) => decision("Bash", { command });

describe("inline node code that only reads files and prints is allowed (#318)", () => {
  it.each([
    `node -e "const fs=require('fs'); console.log(JSON.parse(fs.readFileSync('a.json','utf8')).x)"`,
    `node -e "for (const f of ['a.json','b.json']) console.log(require('./' + f).verdict)"`,
    `node -e "for (const f of ['a','b']) console.log(require('../data/' + f + '.json').id)"`,
    'node -e \'for (const f of ["a","b"]) console.log(require(`./out/${f}.json`).id)\'',
    `node -e "console.log(require('D:/Projects/x/' + name).id)"`,
    `node -e "console.log(['a','b'].join(' \\u2192 '))"`,
    `node -e "console.log('C:\\\\update\\\\notes')"`,
  ])("allows %s", (command) => {
    expect(bash(command)).toBeUndefined();
  });

  it.each([
    `node -e "require('child_process').execSync('ls')"`,
    `node -e "const {exec} = require('child_process'); exec('ls')"`,
    `node -e "require('child_process').spawn('ls')"`,
    `node -e "require('child\\x5fprocess').execSync('ls')"`,
    `node -e "require('child\\u005fprocess').execSync('ls')"`,
    `node -e "require('child\\137process').execSync('ls')"`,
    'node -e \'const x = "process"; require(`child_${x}`).execSync("ls")\'',
    `node -e "require('./' ? 'child_process' : 'x').execSync('ls')"`,
    `node -e "require('./' + f.slice(2)).execSync('ls')"`,
    'node -e \'require(`./${require("child_process").execSync("ls")}`)\'',
    `node -e "const m = 'child_' + 'process'; require(m)"`,
    // Quotes of two kinds: JavaScript reads `'./a" + '` as one string (Qodo on PR 323).
    "node <<'EOF'\nrequire('./a\" + ', require(`child_process`).execSync(`calc`))//')\nEOF",
    "node <<'EOF'\nrequire('./a\" + ', require(`child_${'process'}`).execSync(`calc`))//')\nEOF",
    `node -e "require('./a\\\\' + require('child_process'))"`,
  ])("still refuses code that starts a program: %s", (command) => {
    expect(bash(command)).toBe(BUILT_CODE_REASON);
  });

  it.each([
    `node -e "fetch('https://example.com')"`,
    `node -e "fe\\u0074ch('https://example.com')"`,
    `node -e "globalThis['fe\\x74ch']('https://example.com')"`,
  ])("still refuses code that makes a network call: %s", (command) => {
    expect(bash(command)).toMatch(
      new RegExp(`${INLINE_NETWORK_REASON.slice(0, 30)}|${BUILT_CODE_REASON.slice(0, 30)}`),
    );
  });
});

describe("a file outside every checkout may name a private template (#318)", () => {
  it("allows a Write or an Edit in a temp or scratch folder", () => {
    const file = join(SCRATCH, "analysis.mjs");
    expect(decision("Write", { file_path: file, content: "const id = 'x-secret-v1';\n" })).toBeUndefined();
    const edit = { file_path: file, old_string: "a", new_string: "x-secret-v1" };
    expect(decision("Edit", edit)).toBeUndefined();
    expect(
      decision("Write", { file_path: join(SCRATCH, "new", "deep", "x.md"), content: "x-secret-v1" }),
    ).toBeUndefined();
  });

  it("still refuses one in the lab, in a reviewed checkout, or in any other checkout", () => {
    const lab = tempRepo();
    lab.git("remote", "add", "origin", "https://github.com/AJBeumer/faultforge.git");
    const other = tempRepo();
    for (const file of [
      join(lab.dir, "docs", "notes.md"),
      join(TARGET.dir, "notes.md"),
      join(other.dir, "x", "notes.md"),
      join(SCRATCH, "faultforge-target", "notes.md"),
    ]) {
      expect(decision("Write", { file_path: file, content: "x-secret-v1" })).toMatch(/still private/);
      expect(decision("Edit", { file_path: file, old_string: "a", new_string: "x-secret-v1" })).toMatch(
        /still private/,
      );
    }
  });

  it("still refuses one through a link from a scratch folder into a checkout", () => {
    const lab = tempRepo();
    mkdirSync(join(lab.dir, "docs"));
    const link = join(mkdtempSync(join(tmpdir(), "guard-scratch-link-")), "docs");
    symlinkSync(join(lab.dir, "docs"), link, "junction");
    expect(decision("Write", { file_path: join(link, "notes.md"), content: "x-secret-v1" })).toMatch(/still private/);
  });

  it("still refuses one through a link that leads nowhere yet, or a file that is a link (Qodo on PR 323)", () => {
    const lab = tempRepo();
    const scratch = mkdtempSync(join(tmpdir(), "guard-scratch-dangling-"));
    symlinkSync(join(lab.dir, "not-yet"), join(scratch, "later"), "junction");
    expect(decision("Write", { file_path: join(scratch, "later", "x.md"), content: "x-secret-v1" })).toMatch(
      /still private/,
    );
    writeFileSync(join(lab.dir, "notes.md"), "notes\n");
    try {
      symlinkSync(join(lab.dir, "notes.md"), join(scratch, "notes.md"), "file");
    } catch {
      return; // this machine may not make file links (Windows without the right); the folder link above still ran
    }
    expect(
      decision("Edit", { file_path: join(scratch, "notes.md"), old_string: "notes", new_string: "x-secret-v1" }),
    ).toMatch(/still private/);
  });

  it("still refuses one in a folder named like the lab, even one that doesn't exist yet", () => {
    for (const name of ["FaultForge", "faultforge"]) {
      const file = join(SCRATCH, name, "docs", "notes.md");
      expect(decision("Write", { file_path: file, content: "x-secret-v1" })).toMatch(/still private/);
    }
  });
});
