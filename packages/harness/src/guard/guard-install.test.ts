import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { realSpelling } from "../shared/drive-spelling.ts";
import type { FactoryConfig } from "../shared/factory-config.ts";
import { telltales } from "../shared/neutral.ts";
import * as paths from "../shared/paths.ts";
import {
  CONFIG_KEY,
  guardInstall,
  guardInstalled,
  guardProblem,
  HOOKS,
  hookText,
  InstallRefused,
  installAll,
  installHooks,
  LAB_HOOKS,
  MARKER,
  main,
  mainCheckout,
  ORIGIN_KEY,
  PRIVATE_HOOKS,
  unguardedCheckouts,
} from "./guard-install.ts";

function repo(): { dir: string; git: (...args: string[]) => string } {
  const dir = mkdtempSync(join(tmpdir(), "guard-install-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  return { dir, git };
}

describe("installHooks", () => {
  it("writes the three hooks and the script setting, and a second run leaves the same files", () => {
    const { dir, git } = repo();
    const hooks = installHooks(dir, "C:\\somewhere\\git-guard.ts");
    const first = HOOKS.map((stage) => readFileSync(join(hooks, stage), "utf8"));
    expect(first.every((text) => text.includes(MARKER))).toBe(true);
    expect(git("config", "--get", CONFIG_KEY)).toBe("C:/somewhere/git-guard.ts");
    installHooks(dir, "C:\\somewhere\\git-guard.ts");
    expect(HOOKS.map((stage) => readFileSync(join(hooks, stage), "utf8"))).toEqual(first);
  });

  it("writes hooks whose text names nothing the guard would refuse", () => {
    for (const stage of HOOKS) expect(telltales(hookText(stage))).toEqual([]);
  });

  it("never overwrites a hook it didn't write", () => {
    const { dir } = repo();
    const file = join(dir, ".git", "hooks", "pre-push");
    writeFileSync(file, "#!/bin/sh\necho mine\n");
    expect(() => installHooks(dir, "x")).toThrow(InstallRefused);
    expect(readFileSync(file, "utf8")).toBe("#!/bin/sh\necho mine\n");
    expect(existsSync(join(dir, ".git", "hooks", "pre-commit"))).toBe(false);
  });

  it("refuses a checkout that keeps its hooks somewhere else", () => {
    const { dir, git } = repo();
    git("config", "core.hooksPath", ".githooks");
    expect(() => installHooks(dir, "x")).toThrow(/core.hooksPath/);
  });
});

describe("installHooks: what counts as its own hook", () => {
  it("doesn't take a hook that only mentions the marker somewhere", () => {
    const { dir } = repo();
    const file = join(dir, ".git", "hooks", "pre-commit");
    writeFileSync(file, `#!/bin/sh\necho mine\n${MARKER}\n`);
    expect(() => installHooks(dir, "x")).toThrow(InstallRefused);
    expect(readFileSync(file, "utf8")).toBe(`#!/bin/sh\necho mine\n${MARKER}\n`);
  });
});

describe("guardProblem: whether a checkout has git's own guard", () => {
  /** A real file to name as the guard script, so only the hooks decide. */
  const script = join(mkdtempSync(join(tmpdir(), "guard-script-")), "git-guard.ts");
  writeFileSync(script, "// stands in for the guard script\nexport function check(stage: string) {}\n");

  it("is missing before guard:install and present after it", () => {
    const { dir } = repo();
    expect(guardProblem(dir)).toMatch(/no guard pre-commit hook/);
    expect(guardInstalled(dir)).toBe(false);
    installHooks(dir, script);
    expect(guardProblem(dir)).toBeUndefined();
    expect(guardInstalled(dir)).toBe(true);
  });

  it("is missing when one hook is gone or changed, the script is gone, or hooks are read from elsewhere", () => {
    const changed = repo();
    const hooks = installHooks(changed.dir, script);
    writeFileSync(join(hooks, "pre-push"), "#!/bin/sh\nexit 0\n");
    expect(guardProblem(changed.dir)).toMatch(/no guard pre-push hook/);

    const gone = repo();
    rmSync(join(installHooks(gone.dir, script), "commit-msg"));
    expect(guardProblem(gone.dir)).toMatch(/no guard commit-msg hook/);

    const noScript = repo();
    installHooks(noScript.dir, join(tmpdir(), "no-such-guard-script.ts"));
    expect(guardProblem(noScript.dir)).toMatch(/no script that exists/);

    const elsewhere = repo();
    installHooks(elsewhere.dir, script);
    elsewhere.git("config", "core.hooksPath", ".nothing");
    expect(guardProblem(elsewhere.dir)).toMatch(/core.hooksPath/);
  });

  it("is missing when the script is some other file, or a hook can't be run", () => {
    const noop = repo();
    const other = join(mkdtempSync(join(tmpdir(), "guard-noop-")), "git-guard.ts");
    writeFileSync(other, "process.exit(0);\n");
    installHooks(noop.dir, other);
    expect(guardProblem(noop.dir)).toMatch(/not the git-level guard/);
    if (process.platform !== "win32") {
      const plain = repo();
      chmodSync(join(installHooks(plain.dir, script), "pre-push"), 0o644);
      expect(guardProblem(plain.dir)).toMatch(/not executable/);
    }
  });

  it("reads a relative script path from the checkout, as git does", () => {
    const { dir, git } = repo();
    installHooks(dir, script);
    writeFileSync(join(dir, "git-guard.ts"), readFileSync(script, "utf8"));
    git("config", "--local", CONFIG_KEY, "git-guard.ts");
    expect(guardProblem(dir)).toBeUndefined();
  });

  it("is missing for a folder git can't read", () => {
    expect(guardProblem(join(tmpdir(), "no-such-checkout-for-guard"))).toBeDefined();
  });

  it("lists every reviewed checkout in the factory config that lacks it", () => {
    const guarded = repo();
    installHooks(guarded.dir, script);
    const bare = repo();
    const factory = {
      evidence: "private/raw-artifacts",
      repos: {
        lab: { github: "o/lab", path: bare.dir, guard: "lab" },
        one: { github: "o/one", path: guarded.dir, guard: "reviewed" },
        two: { github: "o/two", path: bare.dir, guard: "reviewed" },
      },
    } as unknown as FactoryConfig;
    const problems = unguardedCheckouts(factory, tmpdir());
    // The bare lab lacks its link check, and the second reviewed checkout its guard.
    expect(problems).toHaveLength(2);
    expect(problems.every((p) => p.includes(bare.dir))).toBe(true);
  });
});

describe("the lab's own hooks", () => {
  const script = join(mkdtempSync(join(tmpdir(), "guard-script-")), "git-guard.ts");
  writeFileSync(script, "// stands in for the guard script\nexport function check(stage: string) {}\n");

  it("installs pre-commit, commit-msg and pre-push in the lab, each calling the lab's stage", () => {
    const { dir } = repo();
    const hooks = installHooks(dir, script, "lab");
    expect(LAB_HOOKS).toEqual(["pre-commit", "commit-msg", "pre-push"]);
    expect(readFileSync(join(hooks, "commit-msg"), "utf8")).toBe(hookText("commit-msg", "lab"));
    expect(readFileSync(join(hooks, "pre-commit"), "utf8")).toBe(hookText("pre-commit", "lab"));
    expect(hookText("pre-commit", "lab")).toContain("lab-pre-commit");
    expect(hookText("commit-msg", "lab")).toContain("lab-commit-msg");
    expect(hookText("pre-push", "lab")).toContain("lab-pre-push");
    expect(guardProblem(dir, "lab")).toBeUndefined();
    // The reviewed repo's pre-commit is another hook: the lab's doesn't count as one.
    expect(guardProblem(dir)).toMatch(/no guard pre-commit hook/);
  });

  it("is installed by guard:install in the checkout marked lab, beside the reviewed ones' hooks", () => {
    const labRepo = repo();
    const reviewed = repo();
    const factory = {
      evidence: "private/raw-artifacts",
      repos: {
        lab: { github: "o/lab", path: labRepo.dir, guard: "lab" },
        one: { github: "o/one", path: reviewed.dir, guard: "reviewed" },
      },
    } as unknown as FactoryConfig;
    expect(installAll(factory, tmpdir(), script)).toBe(0);
    expect(guardProblem(labRepo.dir, "lab")).toBeUndefined();
    expect(guardProblem(reviewed.dir)).toBeUndefined();
    expect(unguardedCheckouts(factory, tmpdir())).toEqual([]);
  });
});

describe("the private checkout's own hook", () => {
  const script = join(mkdtempSync(join(tmpdir(), "guard-script-")), "git-guard.ts");
  writeFileSync(script, "// stands in for the guard script\nexport function check(stage: string) {}\n");

  it("installs pre-push only, calling the private stage, and records the origin URL", () => {
    const { dir, git } = repo();
    git("remote", "add", "origin", "https://github.com/o/x-private.git");
    const hooks = installHooks(dir, script, "private");
    expect(PRIVATE_HOOKS).toEqual(["pre-push"]);
    expect(readFileSync(join(hooks, "pre-push"), "utf8")).toBe(hookText("pre-push", "private"));
    expect(hookText("pre-push", "private")).toContain("private-pre-push");
    expect(existsSync(join(hooks, "commit-msg"))).toBe(false);
    expect(git("config", "--get", ORIGIN_KEY)).toBe("https://github.com/o/x-private.git");
    expect(guardProblem(dir, "private")).toBeUndefined();
  });

  it("refuses a private checkout with no origin, and counts one with no recorded origin as unguarded", () => {
    const bare = repo();
    expect(() => installHooks(bare.dir, script, "private")).toThrow(/no origin/);
    const unrecorded = repo();
    unrecorded.git("remote", "add", "origin", "https://github.com/o/x-private.git");
    installHooks(unrecorded.dir, script, "private");
    unrecorded.git("config", "--unset", ORIGIN_KEY);
    expect(guardProblem(unrecorded.dir, "private")).toMatch(/no recorded origin/);
  });

  it("is installed by guard:install in the private checkout when there is one, and skipped when there isn't", () => {
    const labRepo = repo();
    const priv = join(labRepo.dir, "private");
    const factory = {
      evidence: "private/raw-artifacts",
      repos: { lab: { github: "o/lab", path: labRepo.dir, guard: "lab" } },
    } as unknown as FactoryConfig;
    expect(installAll(factory, tmpdir(), script, priv)).toBe(0);
    execFileSync("git", ["init", "-q", "-b", "main", priv]);
    execFileSync("git", ["-C", priv, "remote", "add", "origin", "https://github.com/o/x-private.git"]);
    expect(installAll(factory, tmpdir(), script, priv)).toBe(0);
    expect(guardProblem(priv, "private")).toBeUndefined();
  });
});

describe("unguardedCheckouts reports the private checkout", () => {
  const script = join(mkdtempSync(join(tmpdir(), "guard-script-")), "git-guard.ts");
  writeFileSync(script, "// stands in for the guard script\nexport function check(stage: string) {}\n");

  it("names a private checkout whose hook is gone, and nothing once it is installed", () => {
    const lab = repo();
    installHooks(lab.dir, script, "lab");
    const priv = join(lab.dir, "private");
    execFileSync("git", ["init", "-q", "-b", "main", priv]);
    execFileSync("git", ["-C", priv, "remote", "add", "origin", "https://github.com/o/x-private.git"]);
    const factory = {
      evidence: "private/raw-artifacts",
      repos: { lab: { github: "o/lab", path: lab.dir, guard: "lab" } },
    } as unknown as FactoryConfig;
    expect(unguardedCheckouts(factory, tmpdir(), priv)).toEqual([expect.stringMatching(/no guard pre-push hook/)]);
    installHooks(priv, script, "private");
    expect(unguardedCheckouts(factory, tmpdir(), priv)).toEqual([]);
    expect(unguardedCheckouts(factory, tmpdir(), join(tmpdir(), "no-such-private"))).toEqual([]);
  });
});

/** A linked worktree of `main`'s repo, at a fresh temp path. */
function worktreeOf(main: { dir: string; git: (...args: string[]) => string }, branch: string): string {
  // A commit needs an identity, and CI's runner sets no global one.
  main.git("config", "user.email", "guard-install-test@example.com");
  main.git("config", "user.name", "guard-install test");
  main.git("commit", "--allow-empty", "-q", "-m", "init");
  const linked = mkdtempSync(join(tmpdir(), "guard-worktree-"));
  rmSync(linked, { recursive: true, force: true });
  execFileSync("git", ["-C", main.dir, "worktree", "add", "-q", linked, "-b", branch]);
  return linked;
}

describe("mainCheckout: the repo's main checkout, from a linked worktree", () => {
  it("is undefined from the main checkout itself, and names it from a linked worktree", () => {
    const main = repo();
    expect(mainCheckout(main.dir)).toBeUndefined();
    const linked = worktreeOf(main, "a-worktree");
    // Compared by real spelling (the operating system's own, `realpathSync.native`): on Windows the temp
    // folder can be an 8.3 short name, which mkdtempSync's result keeps and git's own report writes out in
    // full. Plain `realpathSync` leaves the short name as it is, so it can't make the two equal.
    expect(realSpelling(mainCheckout(linked) ?? "")).toBe(realSpelling(main.dir));
  });

  it("still names the checkout itself when its git directory is stored elsewhere (--separate-git-dir) and core.worktree records it", () => {
    const dir = mkdtempSync(join(tmpdir(), "guard-install-"));
    const gitDir = mkdtempSync(join(tmpdir(), "guard-install-gitdir-"));
    execFileSync("git", ["init", "-q", "-b", "main", `--separate-git-dir=${gitDir}`, dir]);
    const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
    // `git init --separate-git-dir` doesn't record this on its own; a tool that relocates a git directory
    // after the fact (as opposed to a plain `.git` folder, where the parent is simply correct) must.
    git("config", "core.worktree", dir);
    const linked = worktreeOf({ dir, git }, "separate-git-dir-worktree");
    // The parent of the (separate) git directory is not the checkout; only the recorded core.worktree is.
    expect(realSpelling(mainCheckout(linked) ?? "")).toBe(realSpelling(dir));
  });
});

describe("guardInstall: refuses before writing anything", () => {
  const quiet = () => vi.spyOn(console, "error").mockImplementation(() => {});

  it("refuses an unknown argument with a usage line, and installs nothing", () => {
    const main = repo();
    const error = quiet();
    expect(guardInstall(["--bogus"], main.dir, "script-path")).toBe(1);
    expect(error.mock.calls.join("\n")).toMatch(/usage: npm run guard:install/);
    expect(existsSync(join(main.dir, ".git", "hooks", "pre-commit"))).toBe(false);
    expect(readFileSync(join(main.dir, ".git", "config"), "utf8")).not.toContain(CONFIG_KEY);
    error.mockRestore();
  });

  it("main defers privateDir (which loads factory.json) until past an argument refusal, never calling it", () => {
    const privateDir = vi.spyOn(paths, "privateDir").mockImplementation(() => {
      throw new Error("factory.json is missing or invalid");
    });
    const error = quiet();
    // The real ROOT is this checkout itself, not a worktree, so only the argument check can refuse here;
    // that is enough to show privateDir is read lazily, not evaluated at main's call to guardInstall.
    expect(main(["--bogus"])).toBe(1);
    expect(privateDir).not.toHaveBeenCalled();
    error.mockRestore();
    privateDir.mockRestore();
  });

  it("refuses a run from a linked worktree, naming the main checkout, and installs nothing", () => {
    const main = repo();
    const linked = worktreeOf(main, "another-worktree");
    const error = quiet();
    expect(guardInstall([], linked, "script-path")).toBe(1);
    expect(error.mock.calls.join("\n")).toContain(realSpelling(main.dir));
    expect(guardProblem(linked)).toBeDefined();
    expect(readFileSync(join(main.dir, ".git", "config"), "utf8")).not.toContain(CONFIG_KEY);
    error.mockRestore();
  });
});
