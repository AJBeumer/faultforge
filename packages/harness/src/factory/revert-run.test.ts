import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SANDBOX_HOME, SANDBOX_USER, type Sh } from "./factory-sandbox-setup.ts";
import { removeShared, runVitest, type Spawn, sandboxedSpawn, shareWithSandbox, testSetup } from "./revert-run.ts";

/** A fake shell that records each call and answers with `status`. */
function recorder(status = 0) {
  const calls: string[][] = [];
  const sh: Sh = (command, args) => {
    calls.push([command, ...args]);
    return { status, stdout: "", stderr: status ? "denied" : "" };
  };
  return { sh, calls };
}

describe("revert:check runs a PR's tests as the sandbox user in a CI run", () => {
  it("starts the program through sudo as the sandbox user, the environment kept by name, not by value", () => {
    const seen: { command: string; args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
    const spawn: Spawn = (command, args, options) => {
      seen.push({ command, args, env: options.env });
      return { status: 0 };
    };
    sandboxedSpawn(spawn)("/usr/bin/node", ["vitest.mjs", "run", "a.test.ts"], {
      cwd: "/tmp/x",
      env: { PATH: "/usr/bin", CI: "1", NODE_ENV: "test", HOME: "/home/runner" },
      encoding: "utf8",
      timeout: 1000,
    });
    const call = seen[0];
    expect(call?.command).toBe("sudo");
    expect(call?.args.slice(0, 4)).toEqual(["-n", "-u", SANDBOX_USER, "--preserve-env=CI,NODE_ENV"]);
    expect(call?.args).toContain(`HOME=${SANDBOX_HOME}`);
    expect(call?.args.slice(-4)).toEqual(["/usr/bin/node", "vitest.mjs", "run", "a.test.ts"]);
    // The runner's home never reaches the tests.
    expect(call?.args.join(" ")).not.toContain("/home/runner");
  });

  it("shares one copy with the sandbox user, and only lets it pass through the scratch folder", () => {
    const { sh, calls } = recorder();
    shareWithSandbox("/tmp/revert-check-1", "/tmp/revert-check-1/with", sh, "runner");
    expect(calls).toEqual([
      ["sudo", "-n", "setfacl", "-m", `u:${SANDBOX_USER}:x`, "/tmp/revert-check-1"],
      ["sudo", "-n", "setfacl", "-R", "-m", `u:${SANDBOX_USER}:rwX`, "/tmp/revert-check-1/with"],
      [
        "sudo",
        "-n",
        "find",
        "/tmp/revert-check-1/with",
        "-type",
        "d",
        "-exec",
        "setfacl",
        "-m",
        `d:u:${SANDBOX_USER}:rwX,d:u:runner:rwX`,
        "{}",
        "+",
      ],
    ]);
    // setfacl refuses a default entry on a file, so a recursive call never carries one.
    for (const call of calls.filter((c) => c.includes("-R"))) expect(call.join(" ")).not.toMatch(/\bd:u:/);
    expect(() => shareWithSandbox("/tmp/r", "/tmp/r/with", recorder(1).sh, "runner")).toThrow(/couldn't share/);
  });

  it("reads no report a test replaced with a link", (context) => {
    const dir = mkdtempSync(join(tmpdir(), "revert-run-"));
    try {
      try {
        symlinkSync(join(dir, "probe-target"), join(dir, "probe"));
      } catch {
        context.skip(); // Windows without the right to make links: the link can't be made here, so can't be tested.
      }
      mkdirSync(join(dir, "node_modules", "vitest"), { recursive: true });
      writeFileSync(join(dir, "node_modules", "vitest", "vitest.mjs"), "");
      const elsewhere = join(dir, "elsewhere.json");
      writeFileSync(elsewhere, JSON.stringify({ testResults: [{ assertionResults: [{ status: "passed" }] }] }));
      const spawn: Spawn = (_command, args) => {
        const out = String(args.find((a) => a.startsWith("--outputFile="))).slice("--outputFile=".length);
        symlinkSync(elsewhere, out);
        return { status: 0 };
      };
      expect(runVitest(dir, ["a.test.ts"], spawn)).toMatchObject({ ran: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("removes the scratch copy as root, whatever the tests did to their own files", () => {
    const { sh, calls } = recorder();
    removeShared("/tmp/revert-check-1", sh);
    expect(calls).toEqual([["sudo", "-n", "rm", "-rf", "--", "/tmp/revert-check-1"]]);
  });

  it("never runs the tests unsandboxed when a sandbox was asked for and isn't in place", () => {
    expect(() => testSetup(true, recorder(1).sh)).toThrow(/no sandbox for the tests/);
    // Without --sandbox (the owner's PC) the tests run as the caller.
    expect(testSetup(false)).toEqual({ runTests: runVitest });
  });
});
