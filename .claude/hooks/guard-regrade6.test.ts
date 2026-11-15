/**
 * Paths the sixth independent re-grade found open in the guard (#332): the private repo made public or its
 * history pushed elsewhere (N-A), the git-level guard switched off (N-B), lab history pushed into a reviewed repo
 * (N-C), script files that post from outside a reviewed checkout, and a private id written backwards.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { guardConfig, tempRepo } from "./fixtures.ts";
import { decide } from "./guard-target.ts";

const T = "AJBeumer/faultforge-target";
const L = "AJBeumer/faultforge";
const P = "AJBeumer/faultforge-private";
const TARGET_REPO = tempRepo(true);
const CONFIG = guardConfig(TARGET_REPO.dir);
/** The lab checkout, with the private checkout inside it as `private/`, as the owner keeps them. */
const LAB = tempRepo(true);
LAB.git("remote", "add", "lab", `https://github.com/${L}.git`);
const PRIVATE = join(LAB.dir, "private");
mkdirSync(join(PRIVATE, "templates", "x-secret-v1"), { recursive: true });
execFileSync("git", ["init", "-q", "-b", "main", PRIVATE]);
execFileSync("git", ["-C", PRIVATE, "remote", "add", "origin", `https://github.com/${P}.git`]);
execFileSync("git", ["-C", PRIVATE, "remote", "add", "lab", `https://github.com/${L}.git`]);
/** A lab clone with a second remote that points at the target. */
const LAB_T = tempRepo(true);
LAB_T.git("remote", "add", "t", `https://github.com/${T}.git`);
/** A folder that is no checkout. */
const ELSEWHERE = mkdtempSync(join(tmpdir(), "guard-elsewhere6-"));
writeFileSync(join(ELSEWHERE, "vis.json"), '{"private": false}');
writeFileSync(
  join(ELSEWHERE, "post.rb"),
  `require 'net/http'; Net::HTTP.post(URI('https://api.github.com/repos/${T}/issues'), '{}')\n`,
);
writeFileSync(
  join(ELSEWHERE, "send.mjs"),
  'await fetch("https://api.github.com/repos/" + process.argv[2] + "/issues");\n',
);
writeFileSync(join(ELSEWHERE, "sum.mjs"), "console.log(1 + 1);\n");

function ask(tool: string, input: object, cwd: string): string | undefined {
  const env: NodeJS.ProcessEnv = { ...process.env, FAULTFORGE_CONFIG: CONFIG, FAULTFORGE_PRIVATE_DIR: PRIVATE };
  delete env.FAULTFORGE_FACTORY_RUN;
  const decision = decide(JSON.stringify({ tool_name: tool, cwd, tool_input: input }), env);
  if (decision.kind === "error") throw new Error(decision.message);
  return decision.kind === "deny" ? decision.reason : undefined;
}
const bash = (command: string, cwd = ELSEWHERE) => ask("Bash", { command }, cwd);

describe("the private repo stays private (re-grade 6, N-A)", () => {
  it.each([
    `gh repo edit ${P} --visibility public --accept-visibility-change-consequences`,
    "gh repo edit --visibility=internal",
    `gh api -X PATCH repos/${P} -f private=false`,
    `gh api -X PATCH repos/${P} -F private=false`,
    `gh api -X PATCH repos/${P} -f visibility=public`,
    `gh api -X PATCH repos/${P} --input vis.json`,
    `curl -X PATCH https://api.github.com/repos/${P} -d '{"private": false}'`,
  ])("refuses a visibility change to public: %s", (command) => {
    expect(bash(command)).toMatch(/stays private/);
  });

  it("refuses a new repo made from the private checkout", () => {
    expect(bash("gh repo create leak --public --source=private --push", LAB.dir)).toMatch(/stays private/);
    expect(bash("gh repo create leak --private --source private", LAB.dir)).toMatch(/stays private/);
    expect(bash("gh repo create leak --public --source=. --push", PRIVATE)).toMatch(/stays private/);
  });

  it.each([
    [`git -C private push https://github.com/${L}.git HEAD:refs/heads/x`, LAB.dir],
    [`git push https://github.com/${L}.git HEAD:refs/heads/x`, PRIVATE],
    ["git push lab main", PRIVATE],
    ["cd private && git push lab main", LAB.dir],
    [`git push --repo=https://github.com/${L}.git`, PRIVATE],
    [`git remote set-url origin https://github.com/${L}.git`, PRIVATE],
    ["git remote add copy ../elsewhere", PRIVATE],
    [`git config remote.origin.pushurl https://github.com/${L}.git`, PRIVATE],
    ["git config branch.main.pushRemote lab", PRIVATE],
    ["git clone private ../copy", LAB.dir],
    [`git clone https://github.com/${P}.git copy`, ELSEWHERE],
    ["git fetch ./private main", LAB.dir],
  ])("refuses private history going anywhere but its origin: %s", (command, cwd) => {
    expect(bash(command, cwd)).toMatch(/stays private/);
  });

  it("still lets the private history go to its own origin, and reads its settings", () => {
    expect(bash("git push origin main", PRIVATE)).toBeUndefined();
    expect(bash("git push", PRIVATE)).toBeUndefined();
    expect(bash("git -C private push origin HEAD", LAB.dir)).toBeUndefined();
    expect(bash(`git push https://github.com/${P}.git main`, PRIVATE)).toBeUndefined();
    expect(bash("git config --get remote.origin.url", PRIVATE)).toBeUndefined();
    expect(bash("git remote -v", PRIVATE)).toBeUndefined();
    expect(bash("git fetch origin", LAB.dir)).toBeUndefined();
  });

  it("lets other repos be made and edited", () => {
    expect(bash("gh repo create scratch --public")).toBeUndefined();
    expect(bash(`gh repo edit ${L} --visibility private --accept-visibility-change-consequences`)).toBeUndefined();
    expect(bash(`gh repo edit ${L} --description "Tidy"`)).toBeUndefined();
  });
});

describe("the git-level guard can't be switched off (re-grade 6, N-B)", () => {
  const places = [
    ["a reviewed checkout", TARGET_REPO.dir],
    ["the lab", LAB.dir],
    ["the private checkout", PRIVATE],
  ];
  it.each(
    places.flatMap(([where, dir]) =>
      [
        "git config review-guard.script /dev/null",
        "git config --unset review-guard.script",
        "git config --unset-all review-guard.script",
        "git config --remove-section review-guard",
        "git config --file .git/config review-guard.script x",
        "git -c review-guard.script=/dev/null commit -m tidy",
        "git config core.hooksPath /tmp",
        "git -c core.hooksPath=/tmp commit -m tidy",
        "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/tmp git commit -m tidy",
        `git config --global url.https://github.com/${L}.git.insteadOf https://github.com/${P}.git`,
        "rm .git/hooks/pre-push",
        "echo 'exit 0' > .git/hooks/pre-commit",
        "cp /dev/null .git/hooks/pre-push",
        "cd .git && rm hooks/pre-push",
        'rm "$(git rev-parse --git-path hooks)/pre-push"',
      ].map((command) => [where, command, dir]),
    ),
  )("refuses it in %s: %s", (_where, command, dir) => {
    expect(bash(command as string, dir as string)).toMatch(/git-level guard/);
  });

  it("refuses it in PowerShell", () => {
    expect(ask("PowerShell", { command: "Remove-Item .git\\hooks\\pre-push" }, TARGET_REPO.dir)).toMatch(
      /git-level guard/,
    );
  });

  it("refuses the file tools in a .git folder", () => {
    for (const dir of [TARGET_REPO.dir, LAB.dir, PRIVATE]) {
      const hook = join(dir, ".git", "hooks", "pre-push");
      expect(ask("Write", { file_path: hook, content: "#!/bin/sh\nexit 0\n" }, dir)).toMatch(/\.git folder/);
      const config = join(dir, ".git", "config");
      expect(ask("Edit", { file_path: config, old_string: "a", new_string: "b" }, dir)).toMatch(/\.git folder/);
    }
  });

  it("still lets the settings and hooks be read, and the words be written in a message", () => {
    expect(bash("git config --get review-guard.script", TARGET_REPO.dir)).toBeUndefined();
    expect(bash("cat .git/hooks/pre-push", TARGET_REPO.dir)).toBeUndefined();
    expect(bash("ls .git/hooks", LAB.dir)).toBeUndefined();
    expect(bash("grep -rn review-guard .claude", LAB.dir)).toBeUndefined();
    expect(bash('git commit -m "Refuse core.hooksPath and review-guard changes"', LAB.dir)).toBeUndefined();
    expect(ask("Write", { file_path: join(LAB.dir, ".gitignore"), content: "x\n" }, LAB.dir)).toBeUndefined();
    expect(ask("Write", { file_path: join(LAB.dir, ".github", "x.yml"), content: "x\n" }, LAB.dir)).toBeUndefined();
  });
});

describe("lab history never goes into a reviewed repo (re-grade 6, N-C)", () => {
  it.each([
    [`git push https://github.com/${T}.git main:refs/heads/tidy`, LAB.dir],
    [`git push git@github.com:${T}.git HEAD:refs/heads/tidy`, LAB.dir],
    ["git push t HEAD:refs/heads/tidy", LAB_T.dir],
    [`git push ${TARGET_REPO.dir.replace(/\\/g, "/")} HEAD:refs/heads/tidy`, LAB.dir],
    [`git -C ${LAB.dir.replace(/\\/g, "/")} push https://github.com/${T}.git HEAD:refs/heads/tidy`, ELSEWHERE],
  ])("refuses %s", (command, cwd) => {
    expect(bash(command, cwd)).toMatch(/only from its own checkout/);
  });

  it("refuses an issue transferred into a reviewed repo", () => {
    expect(bash(`gh issue transfer 5 ${T}`, LAB.dir)).toMatch(/transferred/);
    expect(bash(`gh issue transfer 5 faultforge-target -R ${L}`)).toMatch(/transferred/);
    expect(
      bash(
        `gh api graphql -f query='mutation{transferIssue(input:{issueId:"I_1",repositoryId:"R_1"}){issue{number}}}'`,
      ),
    ).toMatch(/transferred/);
    expect(bash(`gh issue transfer 5 ${L}-notes -R ${L}`)).toBeUndefined();
  });

  it("still lets a reviewed checkout push to its own repo", () => {
    expect(bash("git push origin HEAD:refs/heads/tidy", TARGET_REPO.dir)).toBeUndefined();
    expect(bash(`git push https://github.com/${T}.git HEAD:refs/heads/tidy`, TARGET_REPO.dir)).toBeUndefined();
  });
});

describe("a script that names a reviewed repo is read in an owner's session too (re-grade 6)", () => {
  it("refuses a script whose text names a reviewed repo, from any folder", () => {
    expect(bash("ruby post.rb")).toMatch(/runs a script/);
    expect(bash(`node ${join(ELSEWHERE, "post.rb").replace(/\\/g, "/")}`, LAB.dir)).toMatch(/runs a script/);
  });

  it("refuses a script that writes to GitHub when the command names a reviewed repo", () => {
    expect(bash(`node send.mjs ${T}`)).toMatch(/runs a script/);
  });

  it("still runs the owner's other scripts", () => {
    expect(bash("node sum.mjs")).toBeUndefined();
    expect(bash(`node sum.mjs ${T}`)).toBeUndefined();
    expect(bash(`node send.mjs ${L}`)).toBeUndefined();
  });
});

describe("a private id written backwards is still the id (re-grade 6)", () => {
  it("refuses it in a lab post", () => {
    expect(bash(`gh pr create -R ${L} -t x -b "uses 1v-terces-x"`)).toMatch(/still private/);
    expect(bash(`gh pr create -R ${L} -t x -b "uses 1V_TERCES_X"`)).toMatch(/still private/);
  });
});
