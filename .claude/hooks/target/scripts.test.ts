/**
 * A script file run where it could post to a reviewed repo is read first (target/posted-files.ts, shell/exec.ts):
 * in a factory run, inside a reviewed checkout, or anywhere once its text or its command names a reviewed repo.
 * Commands that name no script file run unread. Scripts and folders are made up under the temp folder.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { askGuard, guardConfig, labWithPrivate, privateStore, REPOS, scratchFolder, tempRepo } from "../fixtures.ts";
import { scriptFiles } from "../shell/exec.ts";

const T = REPOS.target;
const POSTS = `await fetch("https://api.github.com/repos/${T}/issues", { method: "POST" });\n`;
const TARGET_REPO = tempRepo(true);
const CONFIG = guardConfig(TARGET_REPO.dir);
const PRIVATE = privateStore("guard~private-");
/** A folder that is no checkout, where commands run from unless a test says otherwise. */
const ELSEWHERE = scratchFolder("guard-elsewhere-", {
  "post.mjs": POSTS,
  "post.py": 'import os\nos.system("gh issue create -t x -b y")\n',
  "sum.mjs": "console.log(1 + 1);\n",
  "hook.cjs": `require("child_process").execSync("gh pr comment 3 -R ${T} -b x");\n`,
  "post_test.ts": POSTS,
});
mkdirSync(join(ELSEWHERE, "poster"), { recursive: true });
writeFileSync(join(ELSEWHERE, "poster", "__main__.py"), 'import os\nos.system("gh issue create -t x -b y")\n');
writeFileSync(join(TARGET_REPO.dir, "post.mjs"), POSTS);
writeFileSync(join(TARGET_REPO.dir, "sum.mjs"), "console.log(1 + 1);\n");

const bash = (command: string, cwd = ELSEWHERE, extra: NodeJS.ProcessEnv = {}) =>
  askGuard("Bash", { command }, cwd, { config: CONFIG, privateDir: PRIVATE, outsideRun: true }, extra);
const RUN = { FAULTFORGE_FACTORY_RUN: "run-1" };

describe("a script file run where it could post to a reviewed repo is read first", () => {
  it.each([
    ["node post.mjs", "a script that names the target"],
    ["npx tsx post.mjs", "a script run through npx"],
    ["python post.py", "a script that runs gh"],
    ["python3 -u post.py", "a script with interpreter flags"],
  ])("refuses %s in a factory run (%s)", (command) => {
    expect(bash(command, ELSEWHERE, RUN)).toMatch(/script/);
  });

  it("refuses a posting script run inside a reviewed checkout, or after moving into one", () => {
    expect(bash("node post.mjs", TARGET_REPO.dir)).toMatch(/script/);
    const dir = TARGET_REPO.dir.replace(/\\/g, "/");
    expect(bash(`cd ${dir} && node post.mjs`)).toMatch(/script/);
    expect(bash('cd "$WHERE" && node post.mjs')).toMatch(/script/);
  });

  it("refuses a script it can't read there", () => {
    expect(bash("node missing.mjs", TARGET_REPO.dir)).toMatch(/script/);
  });

  it("allows a script that names no reviewed repo and no write API", () => {
    expect(bash("node sum.mjs", TARGET_REPO.dir)).toBeUndefined();
    expect(bash("node sum.mjs", ELSEWHERE, RUN)).toBeUndefined();
  });

  it("leaves the owner's own scripts alone outside a run and outside a reviewed checkout, unless one names a reviewed repo", () => {
    expect(bash("node sum.mjs")).toBeUndefined();
    expect(bash("python post.py")).toBeUndefined();
    // A script whose text names a reviewed repo is read and refused from any folder.
    expect(bash("node post.mjs")).toMatch(/runs a script/);
  });

  it("reads a script run inside a substitution", () => {
    expect(bash("echo $(node post.mjs)", TARGET_REPO.dir)).toMatch(/script/);
    expect(bash("echo `node post.mjs`", TARGET_REPO.dir)).toMatch(/script/);
  });
});

describe("the script files a command runs are found past its runner, options and redirects", () => {
  it("finds the script a runner is given, past options and redirects, and none for code from stdin", () => {
    expect(scriptFiles("node --require ./hook.js post.mjs > out.txt").map((s) => s.file)).toEqual([
      "./hook.js",
      "post.mjs",
    ]);
    expect(scriptFiles("node > out.txt post.mjs").map((s) => s.file)).toEqual(["post.mjs"]);
    expect(scriptFiles("node < post.mjs").map((s) => s.file)).toEqual(["post.mjs"]);
    expect(scriptFiles("deno run -A post.ts").map((s) => s.file)).toEqual(["post.ts"]);
    expect(scriptFiles("pwsh -File post.ps1").map((s) => s.file)).toEqual(["post.ps1"]);
    expect(scriptFiles("python3 - <<'EOF'\nimport os\nEOF")).toEqual([]);
    expect(scriptFiles("node -e 'console.log(1)'")).toEqual([]);
    expect(scriptFiles("npx vitest run")).toEqual([]);
  });

  it.each(["bun install", "deno test", "deno fmt", "bash -lc 'npm test'", "php -r 'echo 1;'", "sh -ec 'npm test'"])(
    "lets %s run in a factory run: no script file is named",
    (command) => {
      expect(scriptFiles(command)).toEqual([]);
      expect(bash(command, ELSEWHERE, RUN)).toBeUndefined();
    },
  );

  it("reads tsx watch's file, a local preload, a local python module and a script run as the program", () => {
    expect(scriptFiles("tsx watch post.mjs").map((s) => s.file)).toEqual(["post.mjs"]);
    expect(bash("node -r ./hook.cjs sum.mjs", ELSEWHERE, RUN)).toMatch(/script/);
    expect(bash("python -m poster", ELSEWHERE, RUN)).toMatch(/script/);
    expect(bash("./post.mjs", ELSEWHERE, RUN)).toMatch(/script/);
  });

  it("lets an installed python module and a package preload run", () => {
    expect(bash("python -m pytest", ELSEWHERE, RUN)).toBeUndefined();
    expect(bash("node --import tsx sum.mjs", ELSEWHERE, RUN)).toBeUndefined();
  });

  it("lets a fixed-string search run in the target", () => {
    expect(bash("grep -F pattern README.md", TARGET_REPO.dir)).toBeUndefined();
  });

  it("reads the script files a deno or bun subcommand is given", () => {
    expect(bash("deno test ./post_test.ts", ELSEWHERE, RUN)).toMatch(/script/);
    expect(bash("bun test post_test.ts", ELSEWHERE, RUN)).toMatch(/script/);
    expect(bash("bun add lodash", ELSEWHERE, RUN)).toBeUndefined();
  });
});

describe("a script that names a reviewed repo is read in an owner's session too", () => {
  const config = guardConfig(tempRepo(true).dir);
  const { lab, privateDir } = labWithPrivate();
  const elsewhere = scratchFolder("guard-elsewhere6-", {
    "post.rb": `require 'net/http'; Net::HTTP.post(URI('https://api.github.com/repos/${T}/issues'), '{}')\n`,
    "send.mjs": 'await fetch("https://api.github.com/repos/" + process.argv[2] + "/issues");\n',
    "sum.mjs": "console.log(1 + 1);\n",
  });
  const ask = (command: string, cwd = elsewhere) =>
    askGuard("Bash", { command }, cwd, { config, privateDir, outsideRun: true });

  it("refuses a script whose text names a reviewed repo, from any folder", () => {
    expect(ask("ruby post.rb")).toMatch(/runs a script/);
    expect(ask(`node ${join(elsewhere, "post.rb").replace(/\\/g, "/")}`, lab.dir)).toMatch(/runs a script/);
  });

  it("refuses a script that writes to GitHub when the command names a reviewed repo", () => {
    expect(ask(`node send.mjs ${T}`)).toMatch(/runs a script/);
  });

  it("still runs the owner's other scripts", () => {
    expect(ask("node sum.mjs")).toBeUndefined();
    expect(ask(`node sum.mjs ${T}`)).toBeUndefined();
    expect(ask(`node send.mjs ${REPOS.lab}`)).toBeUndefined();
  });
});
