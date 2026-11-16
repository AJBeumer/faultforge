/**
 * The door is the only harness code that writes to the reviewed repository (#340): no other module under
 * `packages/harness/src` calls gh with a write verb, a gh API method, or git push, except those listed here with
 * the repo they write to, which is never the reviewed one. A new write anywhere else fails this test until it goes
 * through `target-post.ts` or is listed with its reason.
 */
import { readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { OWN_FILES } from "../../../../.claude/hooks/self/own-files.ts";
import { SRC, sourceFiles, sourcePath } from "../repo/sources.ts";

/** The door's own folder; the other modules are read from every area. */
const DOOR = import.meta.dirname;

/** A gh write verb, a gh API method, or a git push, as code spells them: quoted words in an argument list. */
const WRITE_CALL =
  /["'](?:issue|pr|label|release|repo)["'],\s*["'](?:create|edit|comment|close|reopen|merge|review|delete|lock|transfer|upload)["']|["']push["'],|["']-X["'],|["']--method["'],|["']send-pack["']/;

/** Modules that write elsewhere, and where. Each is checked to still write only there. */
const ELSEWHERE: Record<string, string> = {
  "alert.ts": "the lab's own issues (its repo is the lab's, from factory.json)",
  "rules-propose.ts": "the lab's own issues (rule proposals)",
  "factory-evidence.ts": "git push of the private evidence repo",
  "factory-keep.ts": "git push of the private evidence repo",
  "factory-sandbox-setup.ts": "iptables' -X, which drops a firewall chain: no GitHub call at all",
  // The runner's comments and labels on the ticket it works: a reviewed repo's go through the door (#345).
  "ticket-write.ts": "the runner's comments and labels on a lab ticket; a reviewed repo's go through sendPost",
};

function writers(): string[] {
  return sourceFiles()
    .filter((f) => !basename(f).startsWith("target-post"))
    .filter((f) => WRITE_CALL.test(readFileSync(join(SRC, f), "utf8")))
    .map((f) => basename(f))
    .sort();
}

describe("one door to the reviewed repository (#340)", () => {
  it("finds the door's own writes, so the pattern still matches real code", () => {
    const door = readFileSync(join(DOOR, "target-post-push.ts"), "utf8");
    expect(WRITE_CALL.test(door)).toBe(true);
  });

  it("has no module but the door writing with gh or git, outside the listed ones", () => {
    expect(writers()).toEqual(Object.keys(ELSEWHERE).sort());
  });

  it("lists no factory module that writes to GitHub: the runner's comments and labels go through the door (#345)", () => {
    // The factory modules left only push the private evidence repo, or make no GitHub call at all.
    const factory = Object.keys(ELSEWHERE).filter((f) => f.startsWith("factory-"));
    expect(factory.sort()).toEqual(["factory-evidence.ts", "factory-keep.ts", "factory-sandbox-setup.ts"]);
    for (const file of factory) expect(ELSEWHERE[file], file).toMatch(/private evidence repo|no GitHub call/);
    expect(ELSEWHERE["factory-deps.ts"]).toBeUndefined();
    expect(readFileSync(sourcePath("factory-deps.ts"), "utf8")).toMatch(/\bticketWriter\(/);
    expect(readFileSync(sourcePath("ticket-write.ts"), "utf8")).toMatch(/\bsendPost\(/);
  });

  it("sends case:ticket's issue and case:pr's PR through the door", () => {
    for (const file of ["case-ticket.ts", "case-pr.ts"]) {
      const text = readFileSync(sourcePath(file), "utf8");
      expect(text, file).toMatch(/\bsendPost\(/);
      expect(text, file).not.toMatch(/child_process/);
    }
  });

  it("imports only files the guard holds, so no module it loads can change what it sends (Qodo on PR 344)", () => {
    const root = join(SRC, "../../..");
    const held = (path: string) => {
      const rel = relative(root, path).replace(/\\/g, "/").toLowerCase();
      return OWN_FILES.some((own) => (own.endsWith("/") ? rel.startsWith(own) : rel === own));
    };
    const door = readdirSync(DOOR).filter((f) => /^target-post[\w-]*\.ts$/.test(f) && !f.endsWith(".test.ts"));
    expect(door.sort()).toEqual(["target-post-cli.ts", "target-post-push.ts", "target-post-run.ts", "target-post.ts"]);
    for (const file of door) {
      expect(held(join(DOOR, file)), file).toBe(true);
      const imports = [...readFileSync(join(DOOR, file), "utf8").matchAll(/from "(\.[^"]+)"|import\("(\.[^"]+)"\)/g)];
      for (const m of imports)
        expect(held(resolve(DOOR, m[1] ?? m[2] ?? "")), `${file} imports ${m[1] ?? m[2]}`).toBe(true);
    }
  });
});
