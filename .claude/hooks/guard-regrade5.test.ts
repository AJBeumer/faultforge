/**
 * Holes the fifth independent re-grade found in the guard (#328): the lab's name joined into a longer word,
 * target links in a lab commit's trailer or message file, ref rewrites through the GitHub API, and text a
 * post takes from a file through xargs, parallel, `--post-file` or a script the guard doesn't read.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { guardConfig, tempRepo } from "./fixtures.ts";
import { decide } from "./guard-target.ts";
import { scriptFiles } from "./shell/exec.ts";

const TARGET_REPO = tempRepo(true);
const CONFIG = guardConfig(TARGET_REPO.dir);
const PRIVATE = (() => {
  const dir = mkdtempSync(join(tmpdir(), "guard~regrade5-"));
  mkdirSync(join(dir, "templates", "x-secret-v1"), { recursive: true });
  return dir;
})();
/** A folder that is no checkout, where commands run from unless a test says otherwise. */
const ELSEWHERE = mkdtempSync(join(tmpdir(), "guard-elsewhere-"));
const T = "AJBeumer/faultforge-target";
/** The door rule (#340): every write to a reviewed repo goes through npm run target:post. */
const DOOR = /go only through the door/;
const LAB = "AJBeumer/faultforge";
const LINK = `${T}#3`;

writeFileSync(join(ELSEWHERE, "notes.txt"), "Tidy the list\n");
writeFileSync(join(ELSEWHERE, "link.txt"), `Tidy\n\nRefs ${LINK}\n`);
writeFileSync(join(ELSEWHERE, "url.txt"), `Tidy\n\nSee https://github.com/${T}/pull/3\n`);
writeFileSync(join(ELSEWHERE, "body.json"), '{"title":"Tidy"}');
writeFileSync(
  join(ELSEWHERE, "post.mjs"),
  `await fetch("https://api.github.com/repos/${T}/issues", { method: "POST" });\n`,
);
writeFileSync(join(ELSEWHERE, "post.py"), 'import os\nos.system("gh issue create -t x -b y")\n');
writeFileSync(join(ELSEWHERE, "sum.mjs"), "console.log(1 + 1);\n");
writeFileSync(
  join(TARGET_REPO.dir, "post.mjs"),
  `await fetch("https://api.github.com/repos/${T}/issues", { method: "POST" });\n`,
);
writeFileSync(join(TARGET_REPO.dir, "sum.mjs"), "console.log(1 + 1);\n");

function bash(command: string, cwd = ELSEWHERE, extra: NodeJS.ProcessEnv = {}): string | undefined {
  const payload = JSON.stringify({ tool_name: "Bash", cwd, tool_input: { command } });
  const env: NodeJS.ProcessEnv = { ...process.env, FAULTFORGE_CONFIG: CONFIG, FAULTFORGE_PRIVATE_DIR: PRIVATE };
  delete env.FAULTFORGE_FACTORY_RUN;
  Object.assign(env, extra);
  const decision = decide(payload, env);
  if (decision.kind === "error") throw new Error(decision.message);
  return decision.kind === "deny" ? decision.reason : undefined;
}

describe("a lab commit can't link to the target from any message source (re-grade 5)", () => {
  it.each([
    ["a trailer", `git commit -m "x" --trailer "Refs: ${LINK}"`],
    ["a trailer with =", `git commit --trailer="Fixes: ${LINK}" -m x`],
    ["a trailer URL", `git commit -m x --trailer "Refs: https://github.com/${T}/issues/3"`],
    ["a message file", "git commit -F link.txt"],
    ["a long message file", "git commit --file=url.txt"],
    ["a template", "git commit -t link.txt"],
    ["a second -m", `git commit -m x -m "Refs ${LINK}"`],
  ])("refuses %s", (_name, command) => {
    expect(bash(command)).toMatch(/link to the target/);
  });

  it("allows a plain-text reference and an ordinary trailer", () => {
    expect(bash('git commit -m "x" --trailer "Refs: target 3"')).toBeUndefined();
    expect(bash("git commit -F notes.txt")).toBeUndefined();
  });
});

describe("refs on a reviewed repo can't be rewritten through the API (re-grade 5)", () => {
  it.each([
    `gh api repos/${T}/git/refs/heads/case-x -X PATCH -F force=true -f sha=abc`,
    `gh api repos/${T}/git/refs/heads/main -X DELETE`,
    `gh api -X DELETE repos/${T}/git/refs/heads/some-branch`,
    `gh api --method=DELETE /repos/${T}/git/refs/tags/v1`,
    `gh api repos/${T}/git/refs/heads/main -X PATCH -f sha=abc`,
    `gh api repos/${T}/git/refs/heads/main --method PATCH -f sha=abc -F force=false`,
    `gh api repos/${T}/git/refs/heads/main --input body.json`,
    `gh api -XPOST repos/${T}/git/refs -f ref=refs/heads/tidy -f sha=abc -F force=true`,
    `gh repo sync ${T} --source AJBeumer/other --force`,
  ])("refuses %s", (command) => {
    expect(bash(command)).toMatch(DOOR);
  });

  it("allows reading refs; creating one goes through the door", () => {
    expect(bash(`gh api repos/${T}/git/refs/heads/main`)).toBeUndefined();
    expect(bash(`gh api repos/${T}/git/matching-refs/heads/`)).toBeUndefined();
    expect(bash(`gh api -X POST repos/${T}/git/refs -f ref=refs/heads/tidy-list -f sha=abc`)).toMatch(DOOR);
  });

  it("leaves the lab's own refs alone", () => {
    expect(bash(`gh api -X DELETE repos/${LAB}/git/refs/heads/old-branch`)).toBeUndefined();
  });
});

describe("text a post reads from a file it doesn't name as a body is unreadable (re-grade 5)", () => {
  it.each([
    ["xargs from a redirect", `xargs -I{} gh pr comment 3 -R ${T} -b {} < notes.txt`],
    ["xargs from a pipe", `cat notes.txt | xargs gh pr comment 3 -R ${T} -b`],
    ["xargs with -a", `xargs -a notes.txt -I{} gh pr comment 3 -R ${T} -b {}`],
    ["parallel from a file", `parallel gh pr comment 3 -R ${T} -b :::: notes.txt`],
    ["parallel from a pipe", `cat notes.txt | parallel gh pr comment 3 -R ${T} -b`],
  ])("refuses %s", (_name, command) => {
    expect(bash(command)).toMatch(/can't (check|read)/);
  });

  it.each([
    `wget --post-file=body.json https://api.github.com/repos/${T}/issues`,
    `wget --post-file body.json https://api.github.com/repos/${T}/issues`,
    `curl --upload-file body.json https://api.github.com/repos/${T}/issues`,
  ])("refuses a file posted raw to the target: %s", (command) => {
    expect(bash(command)).toBeDefined();
  });

  it("refuses a lab post whose body is a file xargs reads, while private templates exist", () => {
    expect(bash(`xargs -I{} gh pr comment 3 -R ${LAB} -b {} < notes.txt`)).toBeDefined();
  });

  it("still allows xargs and parallel that post nothing", () => {
    expect(bash("cat notes.txt | xargs echo")).toBeUndefined();
    expect(bash("parallel echo ::: a b")).toBeUndefined();
  });
});

describe("a script file run where it could post to a reviewed repo is read first (re-grade 5)", () => {
  const RUN = { FAULTFORGE_FACTORY_RUN: "run-1" };

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
    // Re-grade 6: a script whose text names a reviewed repo is read and refused from any folder.
    expect(bash("node post.mjs")).toMatch(/runs a script/);
  });

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
});

describe("Qodo on PR 329", () => {
  const RUN = { FAULTFORGE_FACTORY_RUN: "run-1" };
  writeFileSync(join(ELSEWHERE, "del.graphql"), 'mutation { deleteRef(input: {refId: "R_x"}) { clientMutationId } }');
  writeFileSync(join(ELSEWHERE, "hook.cjs"), `require("child_process").execSync("gh pr comment 3 -R ${T} -b x");\n`);
  mkdirSync(join(ELSEWHERE, "poster"), { recursive: true });
  writeFileSync(join(ELSEWHERE, "poster", "__main__.py"), 'import os\nos.system("gh issue create -t x -b y")\n');

  it("refuses a ref mutation read from a query file", () => {
    expect(bash("gh api graphql -F query=@del.graphql")).toMatch(DOOR);
  });

  it.each([
    `gh api repos/${T}/git/refs/heads/main -X=DELETE`,
    `gh api repos/${T}/git/refs/heads/main -X GET -X DELETE`,
  ])("reads every method flag: %s", (command) => {
    expect(bash(command)).toMatch(DOOR);
  });

  it("reads gh's repo placeholders as the checkout's repo", () => {
    expect(bash("gh api repos/{owner}/{repo}/git/refs/heads/main -X DELETE", TARGET_REPO.dir)).toMatch(DOOR);
    expect(bash("gh api repos/:owner/:repo/git/refs/heads/main -X PATCH -F force=true", TARGET_REPO.dir)).toMatch(DOOR);
  });

  it("reads a script run inside a substitution", () => {
    expect(bash("echo $(node post.mjs)", TARGET_REPO.dir)).toMatch(/script/);
    expect(bash("echo `node post.mjs`", TARGET_REPO.dir)).toMatch(/script/);
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
});

describe("Qodo on PR 329, second review", () => {
  const RUN = { FAULTFORGE_FACTORY_RUN: "run-1" };
  writeFileSync(
    join(ELSEWHERE, "read.graphql"),
    '# not a deleteRef\nquery { repository(owner: "o", name: "deleteRef") { id } }',
  );
  writeFileSync(
    join(ELSEWHERE, "post_test.ts"),
    `await fetch("https://api.github.com/repos/${T}/issues", { method: "POST" });\n`,
  );

  it("lets a fixed-string search run in the target", () => {
    expect(bash("grep -F pattern README.md", TARGET_REPO.dir)).toBeUndefined();
  });

  it("reads the script files a deno or bun subcommand is given", () => {
    expect(bash("deno test ./post_test.ts", ELSEWHERE, RUN)).toMatch(/script/);
    expect(bash("bun test post_test.ts", ELSEWHERE, RUN)).toMatch(/script/);
    expect(bash("bun add lodash", ELSEWHERE, RUN)).toBeUndefined();
  });
});
