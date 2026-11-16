import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { killOnExit, killTree, type ProcessLike } from "./factory-kill.ts";

/** A fake runner process: signals and exit are events a test emits; `exit` records its code. */
function fakeProcess() {
  const emitter = new EventEmitter();
  const exits: number[] = [];
  const proc: ProcessLike = {
    on: (event, listener) => emitter.on(event, listener),
    off: (event, listener) => emitter.off(event, listener),
    exit: (code) => {
      exits.push(code);
    },
  };
  return { proc, emitter, exits };
}

describe("killOnExit: killing the runner kills the agent's tree (AUD-M19)", () => {
  for (const [signal, code] of [
    ["SIGTERM", 143],
    ["SIGINT", 130],
    ["SIGHUP", 129],
  ] as const) {
    it(`${signal} ends the agent's tree, then the runner exits ${code}`, () => {
      const killed: number[] = [];
      const f = fakeProcess();
      killOnExit(4242, (pid) => killed.push(pid), f.proc);
      f.emitter.emit(signal);
      expect(killed).toEqual([4242]);
      expect(f.exits).toEqual([code]);
    });
  }

  it("the runner's own exit ends the agent's tree too, once", () => {
    const killed: number[] = [];
    const f = fakeProcess();
    killOnExit(4242, (pid) => killed.push(pid), f.proc);
    f.emitter.emit("exit", 0);
    f.emitter.emit("exit", 0);
    expect(killed).toEqual([4242]);
  });

  it("once the agent ended on its own, nothing is killed and no handler is left behind", () => {
    const killed: number[] = [];
    const f = fakeProcess();
    const stop = killOnExit(4242, (pid) => killed.push(pid), f.proc);
    stop();
    f.emitter.emit("SIGTERM");
    f.emitter.emit("exit", 0);
    expect(killed).toEqual([]);
    expect(f.exits).toEqual([]);
    expect(f.emitter.eventNames()).toEqual([]);
  });

  it("a kill that fails still lets the runner exit", () => {
    const f = fakeProcess();
    killOnExit(
      4242,
      () => {
        throw new Error("not permitted");
      },
      f.proc,
    );
    f.emitter.emit("SIGTERM");
    expect(f.exits).toEqual([143]);
  });
});

describe("killTree on Windows: a failed taskkill is a failure (Qodo on PR 268)", () => {
  it.skipIf(process.platform !== "win32")("passes a refused kill on, and takes 'not found' as already gone", () => {
    expect(() => killTree(4242, process.kill, () => ({ status: 1, stderr: "Access is denied." }))).toThrow(
      /taskkill couldn't end pid 4242 \(exit 1\): Access is denied/,
    );
    expect(() => killTree(4242, process.kill, () => ({ status: 128 }))).not.toThrow();
    expect(() => killTree(4242, process.kill, () => ({ status: 0 }))).not.toThrow();
  });
});
