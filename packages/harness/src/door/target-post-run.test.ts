import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Reviewed } from "../../../../.claude/hooks/shared/repos.ts";
import { ticketWriter } from "../tickets/ticket-write.ts";
import { COMMAND_KINDS, type Gh, KINDS, main, type Post, Refused, sendPost } from "./target-post.ts";
import {
  AGENT_DOOR_KINDS,
  doorRunHolder,
  gateMarker,
  RUN_KIND_REASON,
  runGateRefusal,
  runMarkerPath,
  startDoorRun,
} from "./target-post-run.ts";

const DIR = mkdtempSync(join(tmpdir(), "door-run-"));
const APP: Reviewed = { github: "Owner/app", name: "app", folder: "app", checkout: join(DIR, "app") };
let n = 0;
/** A fresh marker path, no file there yet. */
const markerPath = () => join(DIR, `run-${n++}.json`);
const file = (text: string) => {
  const path = join(DIR, `text-${n++}.md`);
  writeFileSync(path, text);
  return path;
};
function fakeGh() {
  const calls: string[][] = [];
  const gh: Gh = (args) => {
    calls.push(args);
    return "https://github.com/Owner/app/pull/9\n";
  };
  return { gh, calls };
}

/** The command line for a kind, with the options it needs. */
function argv(kind: string): string[] {
  const title = file("Tidy the lookup");
  const body = file("A plain change.");
  const repo = ["--repo", "Owner/app"];
  if (kind === "push") return [kind, ...repo, "--branch", "tidy"];
  if (kind === "pr-create") return [kind, ...repo, "--head", "tidy", "--title-file", title, "--body-file", body];
  if (kind === "issue-create") return [kind, ...repo, "--title-file", title, "--body-file", body];
  return [kind, ...repo, "--number", "3", "--body-file", body];
}

const posts: Post[] = KINDS.filter((k) => k !== "push").map((kind) => ({
  kind,
  repo: "Owner/app",
  number: 3,
  body: "A plain change.",
  ...(kind === "pr-create" ? { title: "Tidy", head: "tidy", base: "main" } : {}),
  ...(kind === "label" ? { add: ["agent-working"] } : {}),
}));
const refusedPosts = posts.filter((p) => !(AGENT_DOOR_KINDS as readonly string[]).includes(p.kind));

describe("the door's run gate (#347)", () => {
  it("allows push, pr-create and pr-edit, all kinds the command takes", () => {
    expect([...AGENT_DOOR_KINDS]).toEqual(["push", "pr-create", "pr-edit"]);
    for (const kind of AGENT_DOOR_KINDS) expect(COMMAND_KINDS).toContain(kind);
    expect(refusedPosts.map((p) => p.kind).sort()).toEqual(
      ["issue-comment", "issue-create", "issue-edit", "label", "pr-close", "pr-comment"].sort(),
    );
  });

  it.each(COMMAND_KINDS.filter((k) => !(AGENT_DOOR_KINDS as readonly string[]).includes(k)))(
    "main refuses %s with exit 2 during a run, naming the allowed kinds, and sends nothing",
    (kind) => {
      const marker = markerPath();
      const run = startDoorRun("r1", marker);
      const f = fakeGh();
      const errors: string[] = [];
      const code = main(argv(kind), { reviewed: [APP], gh: f.gh, runMarker: marker, error: (l) => errors.push(l) });
      run.end();
      expect(code).toBe(2);
      expect(f.calls).toEqual([]);
      expect(errors.join("\n")).toContain("the door takes only push, pr-create, pr-edit");
    },
  );

  it.each(refusedPosts.map((p) => [p.kind, p] as const))(
    "sendPost refuses %s during a run, called directly, without the runner key",
    (_kind, post) => {
      const marker = markerPath();
      const run = startDoorRun("r1", marker);
      const f = fakeGh();
      expect(() => sendPost(post, { gh: f.gh, runMarker: marker })).toThrow(Refused);
      expect(() => sendPost(post, { gh: f.gh, runMarker: marker, runnerKey: "a guess" })).toThrow(RUN_KIND_REASON);
      expect(f.calls).toEqual([]);
      run.end();
    },
  );

  it.each(["pr-create", "pr-edit"])("lets %s through during a run", (kind) => {
    const marker = markerPath();
    const run = startDoorRun("r1", marker);
    const f = fakeGh();
    expect(main(argv(kind), { reviewed: [APP], gh: f.gh, runMarker: marker, log: () => {} })).toBe(0);
    expect(f.calls).toHaveLength(1);
    expect(runGateRefusal("push", { marker })).toBeUndefined();
    run.end();
  });

  it("sends every kind outside a run", () => {
    const marker = markerPath();
    for (const post of posts) {
      const f = fakeGh();
      sendPost(post, { gh: f.gh, runMarker: marker });
      expect(f.calls.length).toBeGreaterThan(0);
    }
  });

  it("sends the runner's own writes with the run's key, and only this run's", () => {
    const marker = markerPath();
    const run = startDoorRun("r1", marker);
    for (const post of refusedPosts) {
      const f = fakeGh();
      sendPost(post, { gh: f.gh, runMarker: marker, runnerKey: run.key });
      expect(f.calls.length).toBeGreaterThan(0);
    }
    run.end();
    const next = startDoorRun("r2", marker);
    expect(runGateRefusal("pr-close", { marker, runnerKey: run.key })).toContain(RUN_KIND_REASON);
    next.end();
  });

  it("never writes the key itself in the marker", () => {
    const marker = markerPath();
    const run = startDoorRun("r1", marker);
    const text = readFileSync(marker, "utf8");
    expect(text).not.toContain(run.key);
    expect(JSON.parse(text)).toMatchObject({ run: "r1", pid: process.pid });
    run.end();
    expect(existsSync(marker)).toBe(false);
  });

  it.runIf(process.platform !== "win32")("writes a marker only its owner may change", () => {
    const marker = markerPath();
    const run = startDoorRun("r1", marker);
    expect(statSync(marker).mode & 0o022).toBe(0);
    run.end();
  });

  it("fails closed on a marker it can't read: the runner's key can't match", () => {
    const marker = markerPath();
    writeFileSync(marker, "not json");
    expect(runGateRefusal("issue-comment", { marker, runnerKey: "x" })).toContain(RUN_KIND_REASON);
    // A new run replaces a stale marker of the runner's own.
    const run = startDoorRun("r3", marker);
    expect(runGateRefusal("issue-comment", { marker, runnerKey: run.key })).toBeUndefined();
    run.end();
  });

  it("leaves a marker that is no longer this run's", () => {
    const marker = markerPath();
    const first = startDoorRun("r1", marker);
    const second = startDoorRun("r2", marker);
    first.end();
    expect(existsSync(marker)).toBe(true);
    second.end();
    expect(existsSync(marker)).toBe(false);
  });

  it("finds the marker at a path no environment variable moves", () => {
    const saved = { ...process.env };
    const before = [runMarkerPath("linux"), runMarkerPath("win32")];
    try {
      for (const name of ["TMPDIR", "TMP", "TEMP", "HOME", "USERPROFILE", "HOMEPATH", "APPDATA"])
        process.env[name] = join(DIR, "elsewhere");
      expect([runMarkerPath("linux"), runMarkerPath("win32")]).toEqual(before);
    } finally {
      process.env = saved;
    }
  });

  it("the runner's ticket writer passes the key while a run is marked, so its comments and labels still go", () => {
    const marker = markerPath();
    const holder = doorRunHolder(marker);
    const f = fakeGh();
    const w = ticketWriter([], { door: f.gh, guardReviewed: ["Owner/app"], runnerKey: holder.key, runMarker: marker });
    holder.start("r1");
    w.comment("Owner/app", 3, "Done.");
    w.addLabels("Owner/app", 3, ["agent-done"]);
    w.removeLabel("Owner/app", 3, "agent-working");
    expect(f.calls.map((c) => c.slice(0, 2))).toEqual([
      ["issue", "comment"],
      ["issue", "edit"],
      ["api", "--hostname"],
    ]);
    // Without the key, the same write is refused while the run is marked.
    const agent = ticketWriter([], { door: f.gh, guardReviewed: ["Owner/app"], runMarker: marker });
    expect(() => agent.comment("Owner/app", 3, "Done.")).toThrow(Refused);
    holder.end();
    expect(existsSync(marker)).toBe(false);
  });

  it("reads the fixed marker for every send with the door's own gh or git, whatever marker a caller names (Qodo on PR 349)", () => {
    const named = markerPath();
    expect(gateMarker(true, named)).toBe(runMarkerPath());
    expect(gateMarker(true)).toBe(runMarkerPath());
    // Only a caller with a sender of its own (a test's fake) reads the marker it names.
    expect(gateMarker(false, named)).toBe(named);
    expect(gateMarker(false)).toBeUndefined();
  });

  it("has no way to move the fixed marker: nothing exported sets it", async () => {
    const gate = await import("./target-post-run.ts");
    expect(Object.keys(gate).sort()).toEqual(
      [
        "AGENT_DOOR_KINDS",
        "RUN_KIND_REASON",
        "doorRunHolder",
        "gateMarker",
        "runGateRefusal",
        "runMarkerPath",
        "startDoorRun",
      ].sort(),
    );
  });
});
