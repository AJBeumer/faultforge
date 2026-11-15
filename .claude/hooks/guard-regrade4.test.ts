/**
 * Holes the fourth independent re-grade found in the guard (#321): a backslash-newline line continuation that
 * splits a word, GitHub remote spellings the guard didn't read as `owner/name`, and folder moves whose
 * destination is a glob, a variable or a substitution.
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { guardConfig, tempRepo } from "./fixtures.ts";
import { githubRepo, navigationTargets, unreadableMove } from "./guard-repos.ts";
import { decide } from "./guard-target.ts";
import { joinContinuations } from "./shell-scan.ts";

const TARGET_REPO = tempRepo(true);
const CONFIG = guardConfig(TARGET_REPO.dir);
const PRIVATE = (() => {
  const dir = mkdtempSync(join(tmpdir(), "guard~regrade4-"));
  mkdirSync(join(dir, "templates", "x-secret-v1"), { recursive: true });
  return dir;
})();
/** A folder that is no checkout, where commands run from unless a test says otherwise. */
const ELSEWHERE = mkdtempSync(join(tmpdir(), "guard-elsewhere-"));

function bash(command: string, cwd = ELSEWHERE): string | undefined {
  const payload = JSON.stringify({ tool_name: "Bash", cwd, tool_input: { command } });
  const decision = decide(payload, { ...process.env, FAULTFORGE_CONFIG: CONFIG, FAULTFORGE_PRIVATE_DIR: PRIVATE });
  if (decision.kind === "error") throw new Error(decision.message);
  return decision.kind === "deny" ? decision.reason : undefined;
}

const T = "AJBeumer/faultforge-target";
const LAB = "AJBeumer/faultforge";
/** A path with forward slashes, as a shell command writes it. */
const at = (path: string) => path.replace(/\\/g, "/");

describe("a backslash-newline is joined as the shell joins it (re-grade 4)", () => {
  it("joins continuations outside single quotes and leaves them inside", () => {
    expect(joinContinuations('a "pla\\\nnted" b\\\nc')).toBe('a "planted" bc');
    expect(joinContinuations("a 'pla\\\nnted'")).toBe("a 'pla\\\nnted'");
    expect(joinContinuations("x \\\r\ny")).toBe("x y");
    expect(joinContinuations("cat <<'E'\npla\\\nnted\nE")).toBe("cat <<'E'\npla\\\nnted\nE");
    expect(joinContinuations("cat <<E\npla\\\nnted\nE")).toBe("cat <<E\nplanted\nE");
    expect(joinContinuations("a \\\\\nb")).toBe("a \\\\\nb");
  });

  it.each([
    ["a double-quoted body", `gh pr comment 3 -R ${T} -b "pla\\\nnted bug"`],
    ["a bare body", `gh pr comment 3 -R ${T} -b pla\\\nnted`],
    ["a commit message", 'git commit -m "Fix the pla\\\nnted bug"'],
    ["a heredoc body", `gh pr comment 3 -R ${T} --body-file - <<EOF\nthe pla\\\nnted bug\nEOF`],
  ])("refuses a giveaway word split in %s", (_name, command) => {
    const cwd = command.startsWith("git commit") ? TARGET_REPO.dir : ELSEWHERE;
    // As written, a bare continuation is a second line, which a write may not chain; joined, it says planted.
    expect(bash(command, cwd)).toMatch(/says planted|must run on its own/);
  });

  it("refuses a private id split by a continuation, even in a lab post", () => {
    expect(bash(`gh pr comment 3 -R ${LAB} -b "see x-sec\\\nret-v1"`)).toMatch(/still private/);
  });

  it("refuses a link to the target split by a continuation", () => {
    const command = `gh issue comment 5 -R ${LAB} --body "see https://github.com/${T.replace("target", "tar\\\nget")}/pull/3"`;
    expect(bash(command)).toMatch(/link to the target/);
  });

  it("keeps a backslash-newline inside single quotes as written, as the shell does", () => {
    expect(bash(`gh pr comment 3 -R ${T} -b 'pla\\\nnted'`)).toBeUndefined();
    expect(bash(`gh pr comment 3 -R ${T} -b "Tidy the\\\n list"`)).toBeUndefined();
  });
});

describe("every GitHub remote spelling reads as owner/name (re-grade 4)", () => {
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
    expect(bash("git push --force origin main", clone.dir)).toMatch(/Force pushes/);
    expect(bash("git push origin HEAD:planted-bug", clone.dir)).toMatch(/says planted/);
  });

  it.each([
    `git push --force ssh://git@ssh.github.com:443/${T}.git main`,
    `git push --force git@ssh.github.com:${T}.git main`,
    `git push --force SSH://GIT@SSH.GITHUB.COM:443/${T.toUpperCase()}.GIT main`,
  ])("refuses a force push to the URL in %s", (command) => {
    expect(bash(command)).toMatch(/Force pushes/);
  });

  it("refuses a giveaway branch pushed to an SSH URL with a port", () => {
    expect(bash(`git push ssh://git@ssh.github.com:443/${T}.git HEAD:planted-bug`)).toMatch(/says planted/);
  });
});

describe("a move whose destination can't be read touches every reviewed repo (re-grade 4)", () => {
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
    expect(bash(command)).toMatch(/Force pushes/);
  });

  it("refuses a giveaway PR title after a move it can't read", () => {
    expect(bash('cd "$TARGET_DIR" && gh pr create --title "planted bug" --body x')).toMatch(/says planted/);
    expect(bash(`cd ${glob} && gh pr create --title "planted bug" --body x`)).toMatch(/says planted/);
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
    expect(bash('cd "$HOME/x" && git push origin tidy-list')).toBeUndefined();
    expect(bash(`cd ${at(ELSEWHERE)} && git push --force origin main`)).toBeUndefined();
  });

  it("reads a move only where the shell acts on it, never in a message (Qodo on PR 322)", () => {
    expect(bash(`git commit -m 'the planted bug: run cd "$DIR" first'`)).toBeUndefined();
    expect(bash(`gh pr create -R ${LAB} --title "Tidy" --body 'then git -C "$X" status'`)).toBeUndefined();
  });

  it("still sees a real move after text that looks like a flag (Qodo on PR 322, second review)", () => {
    expect(bash(`printf ' --message x'; cd "$DIR" && git push --force origin main`)).toMatch(/Force pushes/);
    expect(bash(`printf " -m x"; cd "$DIR" && git push --force origin main`)).toMatch(/Force pushes/);
    expect(unreadableMove('echo "$(cd "$DIR" && git push origin main)"', ELSEWHERE)).toBe(true);
  });

  it("reads single-quoted text and a lone % as written (Qodo on PR 322)", () => {
    expect(unreadableMove("cd '$DIR'", ELSEWHERE)).toBe(false);
    expect(unreadableMove("git -C '$(x)' status", ELSEWHERE)).toBe(false);
    expect(unreadableMove("cd 100%done", ELSEWHERE)).toBe(false);
    expect(unreadableMove("cd %USERPROFILE%", ELSEWHERE)).toBe(true);
    expect(unreadableMove("cd -", ELSEWHERE)).toBe(true);
  });

  it("counts a wildcard with more matches than the guard follows as unreadable, without walking them (Qodo on PR 322)", () => {
    const many = mkdtempSync(join(tmpdir(), "guard-many-"));
    for (let i = 0; i < 40; i++) mkdirSync(join(many, `d${i}`));
    expect(navigationTargets(`cd ${at(many)}/*`, ELSEWHERE)).toEqual([]);
    expect(unreadableMove(`cd ${at(many)}/*`, ELSEWHERE)).toBe(true);
    expect(navigationTargets(`cd ${at(many)}/d1?`, ELSEWHERE)).toHaveLength(10);
  });
});

describe("a GitHub URL counts only where github.com is the host (Qodo on PR 322)", () => {
  it("reads nothing from github.com in another host's path", () => {
    expect(githubRepo("https://gitlab.com/github.com/AJBeumer/faultforge-target.git")).toBeUndefined();
    expect(bash("git push --force https://gitlab.com/github.com/AJBeumer/faultforge-target.git main")).toBeUndefined();
  });
});
