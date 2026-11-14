/**
 * Holes the third independent re-grade found in the guard (#306): a giveaway ref name hidden behind the lab's
 * name, code run by an interpreter subprocess, gists and release assets, percent-escaped ids, and synonyms.
 * The pre-push history checks live in git-guard-history.test.ts.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { telltales } from "../../packages/harness/src/neutral.ts";
import { guardConfig, tempRepo } from "./fixtures.ts";
import { reviewedRepos, stripReviewedNames } from "./guard-repos.ts";
import { decide } from "./guard-target.ts";
import { builtCodeProblem } from "./shell-exec.ts";

const LAB = "D:\\Projects\\FaultForge";
const TARGET = "D:\\Projects\\faultforge-target";
const CONFIG = guardConfig(tempRepo(true).dir);
const PRIVATE = (() => {
  const dir = mkdtempSync(join(tmpdir(), "guard~regrade-"));
  mkdirSync(join(dir, "templates", "x-secret-v1"), { recursive: true });
  return dir;
})();

function bash(command: string, cwd = LAB): string | undefined {
  const payload = JSON.stringify({ tool_name: "Bash", cwd, tool_input: { command } });
  const decision = decide(payload, { ...process.env, FAULTFORGE_CONFIG: CONFIG, FAULTFORGE_PRIVATE_DIR: PRIVATE });
  if (decision.kind === "error") throw new Error(decision.message);
  return decision.kind === "deny" ? decision.reason : undefined;
}

/** A file in its own temp folder holding `text`, by a path with forward slashes. */
function file(name: string, text: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "guard-regrade-")), name);
  writeFileSync(path, text);
  return path.replace(/\\/g, "/");
}

const T = "AJBeumer/faultforge-target";

describe("the lab's name never hides a ref name (re-grade 3)", () => {
  it.each([
    "git push origin HEAD:faultforge/planted-bug",
    "git push origin HEAD:refs/heads/faultforge/planted-bug-ff-0012",
    "git push origin HEAD:refs/heads/x/faultforge/planted-bug",
    "git push origin faultforge/fix-list",
  ])("denies %s in the target", (command) => {
    expect(bash(command, TARGET)).toMatch(/names the lab|says planted|case id/);
  });

  it("denies a slash token with the lab's name in a post's text", () => {
    expect(bash(`gh pr comment 3 -R ${T} -b see-faultforge/planted-bug-here`)).toMatch(/names the lab|says planted/);
    expect(bash(`gh issue create -R ${T} --title faultforge/tidy --body ok`)).toMatch(/names the lab/);
  });

  it("still lets real paths and owner/name repo ids through", () => {
    expect(bash(`gh pr create -R ${T} --title Tidy --body ok`)).toBeUndefined();
    expect(bash(`gh pr create --repo=${T} --title Tidy --body ok`)).toBeUndefined();
    expect(bash("git -C D:/Projects/FaultForge status && git status", TARGET)).toBeUndefined();
    expect(bash(`gh api repos/${T}/issues/3/comments -f body=ok`)).toBeUndefined();
    expect(bash("git push -u origin tidy-list", TARGET)).toBeUndefined();
  });

  it("blanks only paths and repo ids, never a ref", () => {
    const reviewed = reviewedRepos(CONFIG);
    const strip = (text: string) => stripReviewedNames(reviewed, text).trim();
    expect(strip("../FaultForge/notes.md")).toBe("");
    expect(strip("D:\\Projects\\FaultForge\\x")).toBe("");
    expect(strip("/d/Projects/FaultForge")).toBe("");
    expect(strip("https://github.com/AJBeumer/faultforge/issues/3")).toBe("");
    expect(strip("AJBeumer/faultforge")).toBe("");
    expect(strip("--repo=AJBeumer/faultforge-target")).toBe("--repo=");
    expect(strip("HEAD:faultforge/planted-bug")).toBe("HEAD:faultforge/planted-bug");
    expect(strip("refs/heads/faultforge/x")).toBe("refs/heads/faultforge/x");
    expect(strip("fix/faultforge")).toBe("fix/faultforge");
  });
});

describe("code an interpreter runs as a subprocess is built code (re-grade 3)", () => {
  it.each([
    ["perl system", `perl -e 'system("git","push","--force")'`],
    ["perl backticks", "perl -e 'print `git push -f`'"],
    ["perl exec", `perl -e 'exec "git push -f"'`],
    ["python subprocess", `python -c "import subprocess;subprocess.run(['g'+'it','pu'+'sh','--for'+'ce'])"`],
    ["python os.system", `python3 -c "import os;os.system('git push -f')"`],
    ["python decode then exec", `python3 -c "import base64,os;os.system(base64.b64decode('Z2l0IHB1c2ggLWY='))"`],
    ["python exec of decoded code", `python -c "import base64;exec(base64.b64decode('cHJpbnQoMSk='))"`],
    ["python os.popen", `python -c "import os;os.popen('git push -f')"`],
    ["node child_process", `node -e "require('child_process').execSync('git push --force')"`],
    ["node child_process import", `node -e "import('node:child_process').then(c=>c.spawnSync('git',['push']))"`],
    ["node eval of decoded code", `node -e "eval(atob('Y29uc29sZS5sb2coMSk='))"`],
    ["ruby system", `ruby -e 'system("git push -f")'`],
    ["php shell_exec", `php -r 'shell_exec("git push -f");'`],
    ["a heredoc to python", "python3 <<'EOF'\nimport subprocess\nsubprocess.run(['git','push'])\nEOF"],
  ])("refuses %s", (_name, command) => {
    expect(builtCodeProblem(command)).toBeDefined();
    expect(bash(command, TARGET)).toBeDefined();
  });

  it("allows inline code that runs nothing", () => {
    expect(builtCodeProblem(`node -e "console.log(require('fs').readdirSync('.'))"`)).toBeUndefined();
    expect(builtCodeProblem(`python -c "import json;print(json.dumps({'a':1}))"`)).toBeUndefined();
    expect(builtCodeProblem(`perl -ne 'print if /x/' file.txt`)).toBeUndefined();
    expect(builtCodeProblem("node scripts/build.js")).toBeUndefined();
  });
});

describe("gists and release assets are posts (re-grade 3)", () => {
  const giveaway = file("notes.txt", "Fixes the planted bug\n");
  const named = file("idnote.txt", "see x-secret-v1\n");
  const clean = file("clean.txt", "Filter bookings by status.\n");

  it.each([
    ["a public gist", (f: string) => `gh gist create --public ${f}`],
    ["a secret gist", (f: string) => `gh gist create ${f}`],
    ["a gist with a description first", (f: string) => `gh gist create -d notes ${f}`],
    ["a release with an asset", (f: string) => `gh release create v1 -R ${T} ${f}`],
    ["a release upload", (f: string) => `gh release upload v1 -R ${T} ${f}`],
  ])("reads the files of %s for a private id", (_name, command) => {
    expect(bash(command(named))).toMatch(/still private/);
  });

  it("reads a target release's asset for a giveaway word, and allows a clean one", () => {
    expect(bash(`gh release create v1 -R ${T} ${giveaway}`)).toMatch(/says planted/);
    expect(bash(`gh release upload v1 -R ${T} ${giveaway}`)).toMatch(/says planted/);
    expect(bash(`gh release create v1 -R ${T} ${clean}`)).toBeUndefined();
  });

  it("refuses a gist of a file in private storage", () => {
    const answer = join(PRIVATE, "ground-truth.jsonl").replace(/\\/g, "/");
    writeFileSync(answer, '{"caseId":"FF-9001"}\n');
    expect(bash(`gh gist create --public ${answer}`)).toMatch(/private storage/);
    expect(bash(`gh gist create ${answer}`)).toMatch(/private storage/);
    expect(bash(`gh release create v1 -R ${T} ${answer}#notes`)).toMatch(/private storage/);
  });

  it("allows a gist of a clean file", () => {
    expect(bash(`gh gist create ${clean}`)).toBeUndefined();
  });
});

describe("percent-escaped private ids (re-grade 3)", () => {
  it.each(["uses x%2Dsecret%2Dv1", "uses x%2dsecret%2dv1", "uses %78-secret-v1", "uses x%252Dsecret%252Dv1"])(
    "denies an API field %s",
    (body) => {
      expect(bash(`gh api repos/AJBeumer/faultforge/issues/5/comments -f body="${body}"`)).toMatch(/still private/);
    },
  );
});

describe("synonyms for a planted bug (re-grade 3)", () => {
  it.each([
    "this bug was injected on purpose for the reviewer benchmark",
    "a seeded defect",
    "seeded bugs in the list route",
    "the bug was deliberately introduced",
    "an intentionally introduced bug",
    "a bug introduced on purpose",
    "a deliberate bug",
    "an intentional defect",
  ])("flags %s", (text) => {
    expect(telltales(text)).not.toEqual([]);
  });

  it("denies one in a target PR comment", () => {
    expect(bash(`gh pr comment 3 -R ${T} -b "this bug was injected on purpose"`)).toBeDefined();
  });

  it.each([
    "Seed the database with two bookings",
    "Inject the clock so tests can fix the time",
    "Dependency injection for the repository",
    "The bug was introduced in 1.2 and fixed here",
    "Deliberately return 404 for a missing booking",
    "Intentionally left blank",
    "Seeded random numbers make the test repeatable",
  ])("leaves ordinary text alone: %s", (text) => {
    expect(telltales(text)).toEqual([]);
  });
});
