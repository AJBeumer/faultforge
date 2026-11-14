import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FactoryConfig } from "./factory-config.ts";
import {
  copyEvidence,
  guardPrivateDir,
  isReviewedTicket,
  privateAccess,
  privateCheckoutsFor,
  privateUrl,
} from "./factory-private.ts";

describe("guardPrivateDir: a target run's guard still knows the template ids (AUD-H1, Qodo on PR 288)", () => {
  it("names the owner's private folder for a target ticket when it holds templates, never for a lab ticket", () => {
    const factory = {
      repos: { lab: { guard: "lab" }, target: { guard: "reviewed" } },
    } as unknown as FactoryConfig;
    expect(guardPrivateDir(factory, "lab")).toBeUndefined();
    const expected = existsSync(join(LAB_ROOT, "private", "templates")) ? join(LAB_ROOT, "private") : undefined;
    expect(guardPrivateDir(factory, "target")).toBe(expected);
  });
});

import { ROOT as LAB_ROOT } from "./paths.ts";

const FACTORY = {
  evidence: "private/raw-artifacts",
  repos: {
    lab: { github: "owner/lab", path: ".", guard: "lab" },
    target: { github: "owner/target", path: "../target", guard: "reviewed" },
  },
} as unknown as FactoryConfig;

describe("factory-private: a target ticket's run and the private repo (AUD-H2, #284)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ff-private-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("knows a reviewed repo's ticket from a lab ticket", () => {
    expect(isReviewedTicket(FACTORY, "target")).toBe(true);
    expect(isReviewedTicket(FACTORY, "lab")).toBe(false);
  });

  it("names the private checkouts a target ticket's agent is kept out of, and none for a lab ticket", () => {
    const runs = join(dir, "runs");
    const paths = privateCheckoutsFor(FACTORY, "target", runs, { FAULTFORGE_PRIVATE_DIR: join(dir, "elsewhere") });
    expect(paths).toEqual([join(LAB_ROOT, "private"), runs, join(dir, "elsewhere")]);
    expect(privateCheckoutsFor(FACTORY, "lab", runs, {})).toEqual([]);
  });

  it("in CI finds every private checkout still on disk: its own clone, the lab's folder, a Qodo-state worktree", () => {
    const runs = join(dir, "runs");
    const priv = join(dir, "lab", "private");
    const access = privateAccess("ci", priv, runs, { FAULTFORGE_PRIVATE_REPO: "o/p" });
    mkdirSync(runs, { recursive: true });
    expect(access.leftovers()).toEqual([]);
    for (const tree of [priv, join(runs, "private-source"), join(runs, "qodo-check-r1", "private")]) {
      mkdirSync(tree, { recursive: true });
      writeFileSync(join(tree, ".git"), "gitdir: x\n");
    }
    expect(access.leftovers().sort()).toEqual(
      [priv, join(runs, "private-source"), join(runs, "qodo-check-r1", "private")].sort(),
    );
    access.drop();
    expect(access.leftovers()).not.toContain(join(runs, "private-source"));
  });

  it("in CI needs the private repo's name to reach it, and builds its URL from that only", () => {
    expect(privateUrl({ FAULTFORGE_PRIVATE_REPO: "owner/store" })).toBe("https://github.com/owner/store.git");
    expect(() => privateUrl({})).toThrow(/FAULTFORGE_PRIVATE_REPO/);
    expect(() => privateUrl({ FAULTFORGE_PRIVATE_REPO: "https://evil/x y" })).toThrow();
  });

  it("carries the evidence folder over, but no link in it", () => {
    const from = join(dir, "from");
    mkdirSync(join(from, "reviews"), { recursive: true });
    writeFileSync(join(from, "reviews", "r.json"), "{}");
    const to = join(dir, "to");
    copyEvidence(from, to);
    expect(() => rmSync(join(to, "reviews", "r.json"))).not.toThrow();
    // A missing folder is nothing to carry.
    expect(() => copyEvidence(join(dir, "none"), to)).not.toThrow();
  });
});
