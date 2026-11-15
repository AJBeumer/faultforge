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

describe("revert:check runs a PR's tests as the sandbox user in a CI run (#335)", () => {
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

  it("shares the scratch copy with the sandbox user, and the runner whatever that user makes in it", () => {
    const { sh, calls } = recorder();
    shareWithSandbox("/tmp/revert-check-1", sh, "runner");
    expect(calls).toEqual([
      [
        "sudo",
        "-n",
        "setfacl",
        "-R",
        "-m",
        `u:${SANDBOX_USER}:rwX,d:u:${SANDBOX_USER}:rwX,d:u:runner:rwX`,
        "/tmp/revert-check-1",
      ],
    ]);
    expect(() => shareWithSandbox("/tmp/revert-check-1", recorder(1).sh, "runner")).toThrow(/couldn't share/);
  });

  it("removes the scratch copy as root, whatever the tests did to their own files", () => {
    const { sh, calls } = recorder();
    removeShared("/tmp/revert-check-1", sh);
    expect(calls).toEqual([["sudo", "-n", "rm", "-rf", "--", "/tmp/revert-check-1"]]);
  });

  it("never runs the tests unsandboxed when a sandbox was asked for and isn't in place", () => {
    expect(() => testSetup(true, recorder(1).sh)).toThrow(/no sandbox for the tests/);
    // Without --sandbox (the owner's PC): the tests run as the caller, as before.
    expect(testSetup(false)).toEqual({ runTests: runVitest });
  });
});
