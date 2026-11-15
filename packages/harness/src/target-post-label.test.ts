/**
 * The door's `label` kind (#345): the factory's runner moves a reviewed repo's ticket labels through it, and it checks
 * every label name it sends.
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Reviewed } from "../../../.claude/hooks/guard-repos.ts";
import { type Gh, main, SendFailed, sendPost } from "./target-post.ts";

const DIR = mkdtempSync(join(tmpdir(), "target-post-label-"));
const PRIVATE = join(DIR, "private");
mkdirSync(join(PRIVATE, "templates", "x-secret-v1"), { recursive: true });
const ENV = { ...process.env, FAULTFORGE_PRIVATE_DIR: PRIVATE, FAULTFORGE_GUARD_PRIVATE_DIR: PRIVATE };
const APP: Reviewed = { github: "Owner/app", name: "app", folder: "app", checkout: join(DIR, "app") };

function fakeGh(fail?: (args: string[]) => Error | undefined) {
  const calls: string[][] = [];
  const gh: Gh = (args) => {
    calls.push(args);
    const error = fail?.(args);
    if (error) throw error;
    return "";
  };
  return { gh, calls };
}

function run(argv: string[], gh: Gh) {
  const err: string[] = [];
  const code = main(argv, { gh, env: ENV, reviewed: [APP], log: () => {}, error: (l) => err.push(l) });
  return { code, err: err.join("\n") };
}

describe("target:post label (#345)", () => {
  it("adds every label in one edit, then removes each other label on its own", () => {
    const fake = fakeGh();
    const { code } = run(
      ["label", "--number", "7", "--add", "agent-working", "--remove", "ready-for-agent", "--remove", "needs help"],
      fake.gh,
    );
    expect(code).toBe(0);
    expect(fake.calls).toEqual([
      ["issue", "edit", "7", "--repo", "github.com/Owner/app", "--add-label", "agent-working"],
      ["api", "--hostname", "github.com", "-X", "DELETE", "repos/Owner/app/issues/7/labels/ready-for-agent"],
      ["api", "--hostname", "github.com", "-X", "DELETE", "repos/Owner/app/issues/7/labels/needs%20help"],
    ]);
  });

  it("refuses a label name that gives the case away, names a private template or addresses Qodo, and sends nothing", () => {
    for (const name of ["planted", "pl4nted-bug", "x-secret-v1", "@qodo", "FF-9001"]) {
      for (const flag of ["--add", "--remove"]) {
        const fake = fakeGh();
        const { code, err } = run(["label", "--number", "7", "--add", "ok", flag, name], fake.gh);
        expect(code, `${flag} ${name}`).toBe(2);
        expect(err).toMatch(/refused/);
        expect(err).not.toContain("x-secret-v1");
        expect(fake.calls).toEqual([]);
      }
    }
  });

  it("refuses a name gh would split or GitHub can't hold: a comma, a line break, blank, over 50 characters", () => {
    for (const name of ["ok,planted", "a\nb", "  ", "x".repeat(51)]) {
      const fake = fakeGh();
      expect(() =>
        sendPost({ kind: "label", repo: "Owner/app", number: 7, add: [name] }, { gh: fake.gh, env: ENV }),
      ).toThrow(/refused/);
      expect(fake.calls).toEqual([]);
    }
  });

  it("refuses a post that adds and removes the same label, or moves none", () => {
    const fake = fakeGh();
    expect(() =>
      sendPost({ kind: "label", repo: "Owner/app", number: 7, add: ["a"], remove: ["a"] }, { gh: fake.gh, env: ENV }),
    ).toThrow(/both added and removed/);
    expect(() => sendPost({ kind: "label", repo: "Owner/app", number: 7 }, { gh: fake.gh, env: ENV })).toThrow(
      /at least one label/,
    );
    expect(run(["label", "--number", "7"], fake.gh).code).toBe(1);
    expect(fake.calls).toEqual([]);
  });

  it("takes --add and --remove only for a label post, and needs --number", () => {
    const fake = fakeGh();
    expect(run(["label", "--add", "a"], fake.gh).code).toBe(1);
    expect(run(["push", "--branch", "x", "--add", "a"], fake.gh).code).toBe(1);
    expect(fake.calls).toEqual([]);
  });

  it("keeps gh's own error as the failure's cause, and says how far a part-way send got (exit 3)", () => {
    const gone = Object.assign(new Error("Command failed"), { stderr: "Label does not exist (HTTP 404)" });
    const fake = fakeGh((args) => (args[0] === "api" ? gone : undefined));
    try {
      sendPost({ kind: "label", repo: "Owner/app", number: 7, add: ["a"], remove: ["b"] }, { gh: fake.gh, env: ENV });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SendFailed);
      expect((error as SendFailed).cause).toBe(gone);
      expect((error as SendFailed).message).toMatch(/after 1 of 2 calls/);
    }
    expect(run(["label", "--number", "7", "--remove", "b"], fake.gh).code).toBe(3);
  });
});
