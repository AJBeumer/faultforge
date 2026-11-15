/**
 * The agent's network sandbox, for real (#330): the same setup the factory workflow runs, the same proxy and the
 * same launch the tick uses, then programs run as the agent's user. A host off the allow-list must fail however a
 * program reaches for it, through the proxy or around it; the hosts on it must still work.
 *
 * Linux only, with passwordless sudo, and only in CI or with FAULTFORGE_SANDBOX_TEST=1: it makes a system user,
 * iptables chains and ACLs, which a developer's own machine shouldn't get by surprise. Skipped otherwise.
 * `SANDBOX_TEST_GH_TOKEN`, when set (CI gives the job's read-only token), lets `gh api` read a repo.
 */
import { spawn, spawnSync } from "node:child_process";
import { lookup } from "node:dns/promises";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentEnv } from "../src/factory-agent-env.ts";
import { loadFactory } from "../src/factory-config.ts";
import { allowList, type EgressProxy, proxyEnv, sandboxedCommand, startEgressProxy } from "../src/factory-sandbox.ts";
import {
  nodePrefix,
  realSh,
  runPlan,
  sandboxProblems,
  setupPlan,
  stopAgentProcesses,
} from "../src/factory-sandbox-setup.ts";

const ROOT = join(import.meta.dirname, "../../..");
const linux = process.platform === "linux";
const sudo = linux && spawnSync("sudo", ["-n", "true"]).status === 0;
const opted = process.env.CI === "true" || process.env.FAULTFORGE_SANDBOX_TEST === "1";
const BLOCKED = "example.com";

const LOCK = {
  name: "sandbox-probe",
  version: "1.0.0",
  lockfileVersion: 3,
  requires: true,
  packages: {
    "": { name: "sandbox-probe", version: "1.0.0", dependencies: { "is-number": "7.0.0" } },
    "node_modules/is-number": {
      version: "7.0.0",
      resolved: "https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz",
      integrity: "sha512-41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng==",
      license: "MIT",
      engines: { node: ">=0.12.0" },
    },
  },
};

describe.skipIf(!(linux && sudo && opted))("the agent's network sandbox on Linux (#330)", { timeout: 200_000 }, () => {
  let work = "";
  let proxy: EgressProxy;
  const refused: string[] = [];

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), "ff-sandbox-"));
    const failed = runPlan(
      realSh,
      setupPlan({
        dirs: [work],
        // The repo for vitest, read-only, as Node's install is.
        readDirs: [nodePrefix(), ROOT],
        runner: process.env.USER ?? "runner",
        gitconfig: null,
        exists: existsSync,
      }),
    );
    expect(failed).toBeNull();
    expect(sandboxProblems()).toEqual([]);
    proxy = await startEgressProxy(allowList(loadFactory()), (line) => refused.push(line));
  }, 300_000);

  afterAll(async () => {
    stopAgentProcesses();
    await proxy?.close();
  });

  /**
   * Runs a command as the agent's user, as the tick starts the agent: behind the proxy, or with no proxy at all.
   * Never `spawnSync`: the proxy serves from this very process, and a blocked event loop would starve it.
   */
  function asAgent(
    command: string,
    args: string[],
    { proxied = true, env = {}, cwd = work }: { proxied?: boolean; env?: Record<string, string>; cwd?: string } = {},
  ): Promise<{ status: number | null; out: string }> {
    const launch = sandboxedCommand(command, args, {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      ...(proxied ? proxyEnv(proxy.port) : {}),
      ...env,
    });
    return new Promise((done) => {
      const child = spawn(launch.command, launch.args, { cwd, env: launch.env, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (chunk) => {
        out += chunk;
      });
      child.stderr.on("data", (chunk) => {
        out += chunk;
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), 180_000);
      child.on("error", (error) => {
        clearTimeout(timer);
        done({ status: null, out: `${out}${error.message}` });
      });
      child.on("close", (status) => {
        clearTimeout(timer);
        done({ status, out });
      });
    });
  }

  /** Inline code, as an agent would type it: `node -e`. */
  const inline = (code: string, proxied: boolean) => asAgent("node", ["-e", code], { proxied });

  describe("a host off the list fails", () => {
    it.each([true, false])("from curl (proxied: %s)", async (proxied) => {
      const { status, out } = await asAgent("curl", ["-sS", "-m", "15", `https://${BLOCKED}/`], { proxied });
      expect(status).not.toBe(0);
      expect(out).toMatch(proxied ? /CONNECT tunnel failed, response 403/ : /Could not resolve host|Failed to connect/);
    });

    it("even an allowed host, reached directly by its address instead of through the proxy", async () => {
      const { address } = await lookup("registry.npmjs.org", { family: 4 });
      const { status, out } = await asAgent(
        "curl",
        [
          "-sS",
          "-m",
          "15",
          "--noproxy",
          "*",
          "--resolve",
          `registry.npmjs.org:443:${address}`,
          "https://registry.npmjs.org/",
        ],
        { proxied: false },
      );
      expect(status).not.toBe(0);
      expect(out).toMatch(/Failed to connect|Connection refused|Couldn't connect/);
    });

    it.each([true, false])("from inline node -e with an aliased WebSocket (proxied: %s)", async (proxied) => {
      const code = `const W = globalThis["Web" + "Socket"]; const s = new W("wss://${BLOCKED}/");
s.onopen = () => { console.log("REACHED"); process.exit(0); };
s.onerror = () => { console.log("BLOCKED"); process.exit(3); };
setTimeout(() => { console.log("TIMEOUT"); process.exit(4); }, 20000);`;
      const { out } = await inline(code, proxied);
      expect(out).toContain("BLOCKED");
      expect(out).not.toContain("REACHED");
    });

    it.each([true, false])(
      "from inline node -e reaching fetch through [].constructor.constructor (proxied: %s)",
      async (proxied) => {
        const code = `const F = [].constructor.constructor; F("return fe" + "tch")()("https://${BLOCKED}/")
  .then(() => { console.log("REACHED"); process.exit(0); }, () => { console.log("BLOCKED"); process.exit(3); });`;
        const { out } = await inline(code, proxied);
        expect(out).toContain("BLOCKED");
        expect(out).not.toContain("REACHED");
      },
    );

    it.each([true, false])("from a script file (proxied: %s)", async (proxied) => {
      const script = join(work, `probe-${proxied}.mjs`);
      writeFileSync(
        script,
        `import https from "node:https";
https.get("https://${BLOCKED}/", () => { console.log("REACHED"); process.exit(0); })
  .on("error", () => { console.log("BLOCKED"); process.exit(3); });
`,
      );
      const { out } = await asAgent("node", [script], { proxied });
      expect(out).toContain("BLOCKED");
      expect(out).not.toContain("REACHED");
    });

    it("from a test file run by npx vitest", async () => {
      const dir = mkdtempSync(join(work, "vitest-"));
      spawnSync("chmod", ["-R", "a+rwX", dir]);
      writeFileSync(
        join(dir, "probe.test.mjs"),
        `it("reaches ${BLOCKED}", async () => { const r = await fetch("https://${BLOCKED}/"); expect(r.status).toBe(200); });\n`,
      );
      const { status, out } = await asAgent("npx", ["vitest", "run", "--root", dir, "--globals"], { cwd: ROOT });
      expect(status).not.toBe(0);
      expect(out).toMatch(/1 failed/);
      expect(out).not.toMatch(/1 passed/);
    });

    it("and no name can be looked up for it, so DNS carries nothing out", async () => {
      const code = `require("node:dns").promises.lookup("${BLOCKED}")
  .then(() => { console.log("RESOLVED"); process.exit(0); }, () => { console.log("BLOCKED"); process.exit(3); });`;
      expect((await inline(code, false)).out).toContain("BLOCKED");
      expect((await asAgent("getent", ["hosts", BLOCKED], { proxied: false })).status).not.toBe(0);
      if (spawnSync("which", ["resolvectl"]).status === 0)
        expect((await asAgent("resolvectl", ["query", BLOCKED], { proxied: false })).status).not.toBe(0);
    });

    it("and the proxy saw the refused requests, which never reached the network", async () => {
      expect(refused.some((line) => line.startsWith(`CONNECT ${BLOCKED}:443 `))).toBe(true);
    });
  });

  describe("the hosts on the list still work", () => {
    it("curl reaches the npm registry through the proxy", async () => {
      const { status, out } = await asAgent("curl", [
        "-sS",
        "-m",
        "30",
        "-o",
        "/dev/null",
        "-w",
        "%{http_code}",
        "https://registry.npmjs.org/",
      ]);
      expect(status).toBe(0);
      expect(out).toBe("200");
    });

    it("npm ci installs from the registry", async () => {
      const dir = mkdtempSync(join(work, "npm-"));
      writeFileSync(join(dir, "package.json"), JSON.stringify({ ...LOCK.packages[""], private: true }));
      writeFileSync(join(dir, "package-lock.json"), JSON.stringify(LOCK));
      spawnSync("chmod", ["-R", "a+rwX", dir]);
      const { status, out } = await asAgent("npm", ["ci", "--no-audit", "--no-fund"], { cwd: dir });
      expect(out).not.toMatch(/403|ECONNREFUSED|EAI_AGAIN/);
      expect(status).toBe(0);
      expect(existsSync(join(dir, "node_modules/is-number/package.json"))).toBe(true);
    });

    it("git reads from GitHub, and a push reaches GitHub's push endpoint (refused there only for want of credentials)", async () => {
      const repo = "https://github.com/AJBeumer/faultforge.git";
      const env = { GIT_TERMINAL_PROMPT: "0" };
      const read = await asAgent("git", ["ls-remote", repo, "HEAD"], { env });
      expect(read.status).toBe(0);
      expect(read.out).toMatch(/^[0-9a-f]{40}\tHEAD/);
      const dir = mkdtempSync(join(work, "git-"));
      spawnSync("chmod", ["-R", "a+rwX", dir]);
      const git = (...args: string[]) => asAgent("git", ["-C", dir, ...args], { env });
      expect((await git("init", "-q")).status).toBe(0);
      expect(
        (
          await git(
            "-c",
            "user.name=probe",
            "-c",
            "user.email=probe@example.com",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "probe",
          )
        ).status,
      ).toBe(0);
      const push = await git("push", repo, "HEAD:refs/heads/sandbox-probe");
      expect(push.status).not.toBe(0);
      expect(push.out).toMatch(/could not read Username|Authentication failed|terminal prompts disabled|denied/);
      expect(push.out).not.toMatch(/CONNECT tunnel failed|Failed to connect|Could not resolve/);
    });

    it("gh api reaches GitHub's API", async () => {
      const token = process.env.SANDBOX_TEST_GH_TOKEN;
      const { status, out } = await asAgent("gh", ["api", "repos/AJBeumer/faultforge", "--jq", ".full_name"], {
        env: { GH_TOKEN: token || "not-a-token" },
      });
      if (token) {
        expect(status).toBe(0);
        expect(out.trim()).toBe("AJBeumer/faultforge");
      } else expect(out).toMatch(/Bad credentials|HTTP 401/);
    });

    it("Claude Code reaches api.anthropic.com and nothing else (with an invalid key, the API's own 401 is the answer)", async () => {
      const cli = join(work, "cli");
      const install = spawnSync(
        "npm",
        ["install", "--prefix", cli, "--no-audit", "--no-fund", "@anthropic-ai/claude-code@2.1.197"],
        { encoding: "utf8", timeout: 240_000 },
      );
      expect(install.status, install.stderr).toBe(0);
      spawnSync("chmod", ["-R", "a+rX", cli]);
      const before = refused.length;
      const allowedBefore = proxy.counts().allowed;
      const claude = join(cli, "node_modules/.bin/claude");
      // The environment the tick gives the agent (factory-agent-env.ts), with a key the API will refuse.
      const agentLike = { ...agentEnv(process.env, {}).env, ANTHROPIC_API_KEY: "sk-ant-api03-not-a-real-key" };
      const version = await asAgent(claude, ["--version"]);
      expect(version.out, JSON.stringify(version)).toContain("2.1.197");
      const { status, out } = await asAgent(
        claude,
        ["-p", "Reply with OK", "--output-format", "stream-json", "--verbose", "--debug"],
        {
          env: agentLike,
        },
      );
      // For comparison when it fails: the same call written to a file by a shell as the agent, and as the runner.
      const file = join(work, "claude-out.txt");
      const viaFile = await asAgent(
        "/bin/sh",
        [
          "-c",
          `tty; echo "stdin: $(readlink /proc/self/fd/0)"; "${claude}" -p "Reply with OK" --output-format json < /dev/null > "${file}" 2>&1; echo "nulled exit $?"; cat "${file}"; GITHUB_ACTIONS=true "${claude}" -p "Reply with OK" --output-format json < /dev/null > "${file}" 2>&1; echo "gha exit $?"; cat "${file}"; ps -o pid,pgid,sid,tty,stat,comm -u "$(id -un)" 2>&1 | head; ls -t "$HOME"/.claude/debug/ | head -3`,
        ],
        { env: agentLike },
      );
      const asRunner = await new Promise<string>((done) => {
        const child = spawn(claude, ["-p", "Reply with OK", "--output-format", "json"], {
          cwd: work,
          env: { ...process.env, ...proxyEnv(proxy.port), ANTHROPIC_API_KEY: "sk-ant-api03-not-a-real-key" },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let text = "";
        child.stdout.on("data", (c) => {
          text += c;
        });
        child.stderr.on("data", (c) => {
          text += c;
        });
        child.on("close", (code) => done(`exit ${code}: ${text}`));
      });
      const seen = JSON.stringify({
        status,
        counts: proxy.counts(),
        refused: refused.slice(before),
        out: out.slice(-3000),
        viaFile: viaFile.out.slice(-9000),
        asRunner: asRunner.slice(-2000),
      });
      if (!/invalid x-api-key|Invalid API key|authentication_error|401/i.test(out)) console.log(viaFile.out);
      expect(out, seen).toMatch(/invalid x-api-key|Invalid API key|authentication_error|401/i);
      expect(proxy.counts().allowed).toBeGreaterThan(allowedBefore);
      expect(refused.slice(before)).toEqual([]);
    }, 300_000);
  });
});
