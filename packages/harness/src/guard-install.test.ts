import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONFIG_KEY, HOOKS, hookText, InstallRefused, installHooks, MARKER } from "./guard-install.ts";
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
