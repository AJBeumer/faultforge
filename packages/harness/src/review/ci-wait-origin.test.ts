import { describe, expect, it } from "vitest";
import { type Git, originIs, originProblem } from "./ci-wait-origin.ts";

const HTTPS = "https://github.com/owner/lab.git";
const SSH = "git@github.com:owner/lab.git";

/** A fake git: origin's addresses, and the config keys that are set. */
function fakeGit(fetch: string, push: string, config: Record<string, string> = {}): Git {
  return (_cwd, ...args) => {
    if (args[0] === "remote") return args.includes("--push") ? push : fetch;
    if (args[0] === "config") {
      const key = args.at(-1) ?? "";
      const found = args.includes("--get-regexp")
        ? Object.entries(config)
            .filter(([name]) => /^url\..*\.(insteadof|pushinsteadof)$/i.test(name))
            .map(([name, value]) => `${name} ${value}`)
            .join("\n")
        : (config[key] ?? "");
      if (!found) throw new Error("exit 1"); // like git: no such key
      return found;
    }
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
}

describe("originProblem", () => {
  it("accepts an origin that fetches from and pushes to the repository only", () => {
    expect(originProblem(".", "owner/lab", fakeGit(HTTPS, HTTPS), {})).toBeUndefined();
    expect(originProblem(".", "owner/lab", fakeGit(SSH, SSH), {})).toBeUndefined();
  });

  it("refuses another repository among the addresses, fetched from or pushed to", () => {
    expect(originProblem(".", "owner/lab", fakeGit(`${HTTPS}\nhttps://github.com/x/y`, HTTPS), {})).toMatch(
      /not github.com\/owner\/lab/,
    );
    expect(originProblem(".", "owner/lab", fakeGit(HTTPS, "https://github.com/x/y"), {})).toMatch(/not github/);
  });

  it("refuses a URL rewrite in git's config", () => {
    const git = fakeGit(HTTPS, HTTPS, { "url.https://github.com/x/.insteadof": "https://github.com/owner/" });
    expect(originProblem(".", "owner/lab", git, {})).toMatch(/rewrites remote addresses/);
  });

  it("refuses an ssh push through a command of its own, in the config or the environment", () => {
    expect(originProblem(".", "owner/lab", fakeGit(SSH, SSH, { "core.sshCommand": "ssh -p 2222 other" }), {})).toMatch(
      /command of its own/,
    );
    expect(originProblem(".", "owner/lab", fakeGit(SSH, SSH), { GIT_SSH_COMMAND: "ssh -o ProxyCommand=x" })).toMatch(
      /command of its own/,
    );
    expect(originProblem(".", "owner/lab", fakeGit(SSH, SSH), { GIT_SSH: "plink" })).toMatch(/command of its own/);
  });

  it("leaves an https push alone whatever ssh command is set: TLS to github.com decides there", () => {
    const git = fakeGit(HTTPS, HTTPS, { "core.sshCommand": "ssh other" });
    expect(originProblem(".", "owner/lab", git, { GIT_SSH: "plink" })).toBeUndefined();
  });
});

describe("originIs", () => {
  it("is false when origin can't be read", () => {
    const broken: Git = () => {
      throw new Error("not a git repository");
    };
    expect(originIs(".", "owner/lab", broken)).toBe(false);
  });
});
