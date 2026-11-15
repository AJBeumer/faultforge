/**
 * The door's `label` kind (#345): the factory's runner moves a reviewed repo's ticket labels through `sendPost`, which
 * checks every label name it sends. The command doesn't take it: an agent run could otherwise move labels itself.
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Reviewed } from "../../../.claude/hooks/guard-repos.ts";
import { type Gh, main, type Post, SendFailed, sendPost } from "./target-post.ts";

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

/** A label post on Owner/app#7, sent with `gh`. */
const label = (gh: Gh, labels: Pick<Post, "add" | "remove">) =>
  sendPost({ kind: "label", repo: "Owner/app", number: 7, ...labels }, { gh, env: ENV });

/** The error a label post throws, or undefined when it was sent. */
function thrown(gh: Gh, labels: Pick<Post, "add" | "remove">): Error | undefined {
  try {
    label(gh, labels);
    return undefined;
  } catch (error) {
    return error as Error;
  }
}

describe("the door's label kind (#345)", () => {
  it("adds every label in one edit, then removes each other label on its own", () => {
    const fake = fakeGh();
    label(fake.gh, { add: ["agent-working"], remove: ["ready-for-agent", "needs help"] });
    expect(fake.calls).toEqual([
      ["issue", "edit", "7", "--repo", "github.com/Owner/app", "--add-label", "agent-working"],
      ["api", "--hostname", "github.com", "-X", "DELETE", "repos/Owner/app/issues/7/labels/ready-for-agent"],
      ["api", "--hostname", "github.com", "-X", "DELETE", "repos/Owner/app/issues/7/labels/needs%20help"],
    ]);
  });

  it("refuses a label name that gives the case away, names a private template or addresses Qodo, and sends nothing", () => {
    for (const name of ["planted", "pl4nted-bug", "x-secret-v1", "@qodo", "FF-9001"]) {
      for (const side of ["add", "remove"] as const) {
        const fake = fakeGh();
        const error = thrown(fake.gh, { add: ["ok"], [side]: side === "add" ? ["ok", name] : [name] });
        expect(error?.message, `${side} ${name}`).toMatch(/refused/);
        expect(error?.message).not.toContain("x-secret-v1");
        expect(fake.calls).toEqual([]);
      }
    }
  });

  it("refuses a name gh would split or GitHub can't hold: a comma, a line break, blank, over 50 characters", () => {
    for (const name of ["ok,planted", "a\nb", "  ", "x".repeat(51)]) {
      const fake = fakeGh();
      expect(thrown(fake.gh, { add: [name] })?.message).toMatch(/refused/);
      expect(fake.calls).toEqual([]);
    }
  });

  it("refuses a post that adds and removes the same label, or moves none", () => {
    const fake = fakeGh();
    expect(thrown(fake.gh, { add: ["a"], remove: ["a"] })?.message).toMatch(/both added and removed/);
    expect(thrown(fake.gh, {})?.message).toMatch(/at least one label/);
    expect(fake.calls).toEqual([]);
  });

  it("keeps gh's own error as the failure's cause, and says how far a part-way send got", () => {
    const gone = Object.assign(new Error("Command failed"), { stderr: "Label does not exist (HTTP 404)" });
    const fake = fakeGh((args) => (args[0] === "api" ? gone : undefined));
    const error = thrown(fake.gh, { add: ["a"], remove: ["b"] });
    expect(error).toBeInstanceOf(SendFailed);
    expect(error?.cause).toBe(gone);
    expect(error?.message).toMatch(/after 1 of 2 calls/);
  });

  it("isn't a command: npm run target:post refuses label with exit 1, so only the runner moves labels (Qodo on PR 346)", () => {
    const fake = fakeGh();
    const err: string[] = [];
    const code = main(["label", "--number", "7"], {
      gh: fake.gh,
      env: ENV,
      reviewed: [APP],
      log: () => {},
      error: (l) => err.push(l),
    });
    expect(code).toBe(1);
    expect(err.join("\n")).not.toMatch(/\blabel\b.*,|, label\b/);
    expect(fake.calls).toEqual([]);
  });
});
