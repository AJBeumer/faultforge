import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FactoryConfig } from "./factory-config.ts";
import {
  CONFIG_KEY,
  guardInstalled,
  guardProblem,
  HOOKS,
  hookText,
  InstallRefused,
  installHooks,
  MARKER,
  unguardedCheckouts,
} from "./guard-install.ts";
import { telltales } from "./neutral.ts";

function repo(): { dir: string; git: (...args: string[]) => string } {
  const dir = mkdtempSync(join(tmpdir(), "guard-install-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  return { dir, git };
}

describe("installHooks (#191)", () => {
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

describe("installHooks: what counts as its own hook (Qodo on PR 213)", () => {
  it("doesn't take a hook that only mentions the marker somewhere", () => {
    const { dir } = repo();
    const file = join(dir, ".git", "hooks", "pre-commit");
    writeFileSync(file, `#!/bin/sh\necho mine\n${MARKER}\n`);
    expect(() => installHooks(dir, "x")).toThrow(InstallRefused);
    expect(readFileSync(file, "utf8")).toBe(`#!/bin/sh\necho mine\n${MARKER}\n`);
  });
});

describe("guardProblem: whether a checkout has git's own guard (#242)", () => {
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

  it("is missing when the script is some other file, or a hook can't be run (Qodo on PR 266)", () => {
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
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(bare.dir);
  });
});
