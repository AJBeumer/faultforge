import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { ownStartId, processStartId, sameProcess } from "../src/factory-process.ts";

describe("processStartId: the system's own record of a process's start (AUD-M19)", () => {
  it("is the same for this process every time it is read, and is what the lock records", () => {
    const id = processStartId(process.pid);
    expect(id).not.toBeNull();
    expect(processStartId(process.pid)).toBe(id);
    expect(ownStartId()).toBe(id);
    expect(sameProcess(process.pid, id ?? undefined)).toBe(true);
    expect(sameProcess(process.pid, "ticks:1")).toBe(false);
  }, 60_000);

  it("differs for another process", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"]);
    try {
      const other = processStartId(child.pid ?? 0);
      expect(other).not.toBeNull();
      expect(other).not.toBe(processStartId(process.pid));
    } finally {
      child.kill();
    }
  }, 60_000);
});
