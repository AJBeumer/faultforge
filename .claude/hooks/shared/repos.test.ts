/**
 * How the guard recognises a reviewed repository in a command: by a remote in any spelling GitHub accepts, by a
 * clone's remote whatever its folder is called, through every way a command moves into a checkout, and never by
 * the lab's name inside a ref. Folders and repos are made up under the temp folder.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { askGuard, DOOR, guardConfig, privateStore, REPOS, scratchFolder, tempRepo } from "../fixtures.ts";
import { githubRepo, navigationTargets, reviewedRepos, stripReviewedNames, unreadableMove } from "./repos.ts";

const T = REPOS.target;
const LAB = REPOS.lab;
/** A path with forward slashes, as a shell command writes it. */
const at = (path: string) => path.replace(/\\/g, "/");

/** A reviewed checkout with an origin, private storage, and a folder that is no checkout to run from. */
const TARGET_REPO = tempRepo(true);
const CONFIG = guardConfig(TARGET_REPO.dir);
const PRIVATE = privateStore("guard~private-");
const ELSEWHERE = scratchFolder("guard-elsewhere-");
const bash = (command: string, cwd = ELSEWHERE) =>
  askGuard("Bash", { command }, cwd, { config: CONFIG, privateDir: PRIVATE });

describe("the lab's name never hides a ref name", () => {
  const LAB_DIR = "D:\\Projects\\FaultForge";
  const TARGET_DIR = "D:\\Projects\\faultforge-target";
  const config = guardConfig(tempRepo(true).dir);
  const privateDir = privateStore("guard~private-");
  const ask = (command: string, cwd = LAB_DIR) => askGuard("Bash", { command }, cwd, { config, privateDir });

  it.each([
    "git push origin HEAD:faultforge/planted-bug",
    "git push origin HEAD:refs/heads/faultforge/planted-bug-ff-0012",
    "git push origin HEAD:refs/heads/x/faultforge/planted-bug",
    "git push origin faultforge/fix-list",
  ])("denies %s in the target", (command) => {
    expect(ask(command, TARGET_DIR)).toMatch(/go only through the door/);
  });

  it("reads owner/name repo ids and paths as written: reads pass, writes go through the door", () => {
    expect(ask(`gh pr create -R ${T} --title Tidy --body ok`)).toMatch(/go only through the door/);
    expect(ask(`gh pr create --repo=${T} --title Tidy --body ok`)).toMatch(/go only through the door/);
    expect(ask("git -C D:/Projects/FaultForge status && git status", TARGET_DIR)).toBeUndefined();
    expect(ask(`gh api repos/${T}/issues/3/comments -f body=ok`)).toMatch(/go only through the door/);
    expect(ask("git push -u origin tidy-list", TARGET_DIR)).toMatch(/go only through the door/);
  });

  it("blanks only paths and repo ids, never a ref", () => {
    const reviewed = reviewedRepos(config);
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

describe("every GitHub remote spelling reads as owner/name", () => {
  it.each([
    "https://github.com/AJBeumer/faultforge-target",
    "https://github.com/AJBeumer/faultforge-target.git",
    "https://github.com/AJBeumer/faultforge-target/",
    "https://www.github.com/AJBeumer/faultforge-target",
    "HTTPS://GITHUB.COM/AJBEUMER/FAULTFORGE-TARGET.GIT",
    "git@github.com:AJBeumer/faultforge-target.git",
    "git@ssh.github.com:AJBeumer/faultforge-target.git",
    "ssh://git@github.com/AJBeumer/faultforge-target.git",
    "ssh://git@github.com:22/AJBeumer/faultforge-target",
    "ssh://git@ssh.github.com:443/AJBeumer/faultforge-target.git",
    "git://github.com/AJBeumer/faultforge-target.git",
    "https://user@github.com:443/AJBeumer/faultforge-target.git",
  ])("reads %s", (url) => {
    expect(githubRepo(url)).toBe("ajbeumer/faultforge-target");
  });

  it("reads nothing from a URL on another host", () => {
    expect(githubRepo("https://gitlab.com/AJBeumer/faultforge-target.git")).toBeUndefined();
    expect(githubRepo("https://github.com.example.org/AJBeumer/faultforge-target")).toBeUndefined();
  });

  it.each([
    "ssh://git@ssh.github.com:443/AJBeumer/faultforge-target.git",
    "git@ssh.github.com:AJBeumer/faultforge-target.git",
    "ssh://git@github.com:22/AJBeumer/faultforge-target",
    "SSH://GIT@SSH.GITHUB.COM:443/AJBEUMER/FAULTFORGE-TARGET.GIT",
  ])("guards a clone whose remote is %s", (url) => {
    const clone = tempRepo();
    clone.git("remote", "add", "origin", url);
    expect(bash("git push --force origin main", clone.dir)).toMatch(DOOR);
    expect(bash("git push origin HEAD:planted-bug", clone.dir)).toMatch(DOOR);
  });

  it.each([
    `git push --force ssh://git@ssh.github.com:443/${T}.git main`,
    `git push --force git@ssh.github.com:${T}.git main`,
    `git push --force SSH://GIT@SSH.GITHUB.COM:443/${T.toUpperCase()}.GIT main`,
  ])("refuses a force push to the URL in %s", (command) => {
    expect(bash(command)).toMatch(/go only through the door|only from its own checkout/);
    expect(bash(command, TARGET_REPO.dir)).toMatch(DOOR);
  });
});

describe("a GitHub URL counts only where github.com is the host", () => {
  it("reads nothing from github.com in another host's path", () => {
    expect(githubRepo("https://gitlab.com/github.com/AJBeumer/faultforge-target.git")).toBeUndefined();
    expect(bash("git push --force https://gitlab.com/github.com/AJBeumer/faultforge-target.git main")).toBeUndefined();
  });
});

describe("a move whose destination can't be read touches every reviewed repo", () => {
  const dir = at(TARGET_REPO.dir);
  const glob = `${dir.slice(0, -1)}[${dir.slice(-1)}]`;

  it.each([
    ["a glob path", `cd ${glob} && git push --force origin main`],
    ["a star", `cd ${dir.slice(0, -1)}* && git push --force origin main`],
    ["an unset variable", 'cd "$TARGET_DIR" && git push --force origin main'],
    ["git -C with a substitution", `git -C $(echo ${dir}) push --force origin main`],
    ["git -C with a variable", 'git -C "$WHERE" push --force origin main'],
    ["a second -C with a variable", `git -C ${at(ELSEWHERE)} -C "$WHERE" push --force origin main`],
  ])("refuses a force push after %s", (_name, command) => {
    expect(bash(command)).toMatch(DOOR);
  });

  it("refuses a giveaway PR title after a move it can't read", () => {
    expect(bash('cd "$TARGET_DIR" && gh pr create --title "planted bug" --body x')).toMatch(DOOR);
    expect(bash(`cd ${glob} && gh pr create --title "planted bug" --body x`)).toMatch(DOOR);
  });

  it("tells unreadable moves from readable ones", () => {
    expect(unreadableMove('cd "$X" && ls', ELSEWHERE)).toBe(true);
    expect(unreadableMove("git -C $(pwd) status", ELSEWHERE)).toBe(true);
    expect(unreadableMove("cd `pwd`", ELSEWHERE)).toBe(true);
    expect(unreadableMove(`cd ${at(ELSEWHERE)} && ls`, ELSEWHERE)).toBe(false);
    expect(unreadableMove(`cd ${glob}`, ELSEWHERE)).toBe(false);
    expect(unreadableMove("git status", ELSEWHERE)).toBe(false);
  });

  it("still allows reads and clean writes elsewhere", () => {
    expect(bash('cd "$TARGET_DIR" && git status')).toBeUndefined();
    expect(bash('cd "$HOME/x" && git push origin tidy-list')).toMatch(DOOR);
    expect(bash(`cd ${at(ELSEWHERE)} && git push --force origin main`)).toBeUndefined();
  });

  it("reads a move only where the shell acts on it, never in a message", () => {
    expect(bash(`git commit -m 'the planted bug: run cd "$DIR" first'`)).toBeUndefined();
    expect(bash(`gh pr create -R ${LAB} --title "Tidy" --body 'then git -C "$X" status'`)).toBeUndefined();
  });

  it("still sees a real move after text that looks like a flag", () => {
    expect(bash(`printf ' --message x'; cd "$DIR" && git push --force origin main`)).toMatch(DOOR);
    expect(bash(`printf " -m x"; cd "$DIR" && git push --force origin main`)).toMatch(DOOR);
    expect(unreadableMove('echo "$(cd "$DIR" && git push origin main)"', ELSEWHERE)).toBe(true);
  });

  it("reads a substitution's own command, nested quotes and all", () => {
    const command = 'echo "$(printf "%s" x; cd "$DIR"; git push --force origin main)"';
    expect(unreadableMove(command, ELSEWHERE)).toBe(true);
    expect(bash(command)).toBeDefined();
    expect(unreadableMove('echo "$(printf \'%s\' x; echo `cd "$DIR"`)"', ELSEWHERE)).toBe(true);
  });

  it("reads single-quoted text and a lone % as written", () => {
    expect(unreadableMove("cd '$DIR'", ELSEWHERE)).toBe(false);
    expect(unreadableMove("git -C '$(x)' status", ELSEWHERE)).toBe(false);
    expect(unreadableMove("cd 100%done", ELSEWHERE)).toBe(false);
    expect(unreadableMove("cd %USERPROFILE%", ELSEWHERE)).toBe(true);
    expect(unreadableMove("cd -", ELSEWHERE)).toBe(true);
  });

  it("counts a wildcard with more matches than the guard follows as unreadable, without walking them", () => {
    const many = mkdtempSync(join(tmpdir(), "guard-many-"));
    for (let i = 0; i < 40; i++) mkdirSync(join(many, `d${i}`));
    expect(navigationTargets(`cd ${at(many)}/*`, ELSEWHERE)).toEqual([]);
    expect(unreadableMove(`cd ${at(many)}/*`, ELSEWHERE)).toBe(true);
    expect(navigationTargets(`cd ${at(many)}/d1?`, ELSEWHERE)).toHaveLength(10);
  });
});

/** The guard as the clone tests ask it: from the lab's usual folder, with a released template in private storage. */
const LAB_DIR = "D:\\Projects\\FaultForge";
const CLONE_ASKING = {
  config: guardConfig(tempRepo(true).dir),
  privateDir: privateStore("guard~private-", ["idempotency-guard-bypass-v1"]),
};
const verdict = (tool: string, input: object, cwd = LAB_DIR, extra: NodeJS.ProcessEnv = {}) =>
  askGuard(tool, input, cwd, CLONE_ASKING, extra);
const inClone = (command: string, cwd?: string, extra?: NodeJS.ProcessEnv) => verdict("Bash", { command }, cwd, extra);

describe("a second clone of a reviewed repo is recognised by its remote", () => {
  const clone = tempRepo();
  clone.git("remote", "add", "origin", "https://github.com/AJBeumer/faultforge-target.git");
  const dir = clone.dir;

  it("guards pushes and edits there although its folder has another name", () => {
    expect(inClone("git push origin main", dir)).toMatch(DOOR);
    expect(inClone("git push --force origin main", dir)).toMatch(DOOR);
    expect(inClone(`cd "${dir.replace(/\\/g, "/")}" && git push --force origin main`)).toMatch(DOOR);
    expect(verdict("Write", { file_path: join(dir, "src", "x.ts"), content: "// planted here" })).toMatch(
      /says planted/,
    );
  });

  it("reads that clone's own pending content before a commit", () => {
    writeFileSync(join(dir, "notes.md"), "The answer key lives elsewhere.\n");
    expect(inClone('git commit -am "Tidy"', dir)).toMatch(/answer key/);
    execFileSync("git", ["-C", dir, "clean", "-fdq"]);
    expect(inClone('git commit -am "Tidy"', dir)).toBeUndefined();
  });

  it("finds it through a worktree's .git file too", () => {
    const worktree = join(mkdtempSync(join(tmpdir(), "guard-wt-")), "elsewhere");
    clone.git("worktree", "add", "-q", worktree);
    expect(inClone("git push origin main", worktree)).toMatch(DOOR);
  });
});

describe("a clone of a reviewed repo is found through git's options, ~, a URL alias and a bare clone", () => {
  it("lets a second clone commit when the configured checkout is missing", () => {
    const repo = tempRepo();
    repo.git("remote", "add", "origin", "https://github.com/AJBeumer/faultforge-target.git");
    const clone = repo.dir;
    const extra = { FAULTFORGE_CONFIG: guardConfig(join(tmpdir(), "no-such-checkout-here")) };
    expect(inClone('git commit --allow-empty -m "Tidy"', clone, extra)).toBeUndefined();
    expect(inClone("git push origin main", clone, extra)).toMatch(DOOR);
  });

  it("finds a clone through repeated -C options, through ~, and a bare clone", () => {
    const clone = tempRepo();
    clone.git("remote", "add", "origin", "https://github.com/AJBeumer/faultforge-target.git");
    const parent = at(join(clone.dir, ".."));
    const name = at(clone.dir).split("/").pop() ?? "";
    expect(inClone(`git -C "${parent}" -C ${name} push --force origin main`)).toMatch(DOOR);
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = parent;
    process.env.USERPROFILE = parent;
    try {
      expect(inClone(`cd ~/${name} && git push --force origin main`)).toMatch(DOOR);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    const alias = tempRepo();
    alias.git("config", "url.https://github.com/.insteadOf", "gh:");
    alias.git("remote", "add", "origin", "gh:AJBeumer/faultforge-target.git");
    expect(inClone("git push --force origin main", alias.dir)).toMatch(DOOR);
    const bare = mkdtempSync(join(tmpdir(), "guard-bare-"));
    execFileSync("git", ["init", "-q", "--bare", bare]);
    execFileSync("git", ["-C", bare, "remote", "add", "origin", "https://github.com/AJBeumer/faultforge-target.git"]);
    expect(inClone("git push --force origin main", bare)).toMatch(DOOR);
  });

  it("sees -C after other git options", () => {
    const clone = tempRepo();
    clone.git("remote", "add", "origin", "https://github.com/AJBeumer/faultforge-target.git");
    const dir = clone.dir.replace(/\\/g, "/");
    expect(inClone(`git --no-pager -C "${dir}" push origin main`)).toMatch(DOOR);
    expect(inClone(`git -c core.pager=cat -C "${dir}" push --force origin main`)).toMatch(DOOR);
  });
});
