import { readFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configProblems, type FactoryConfig, loadFactory } from "./factory-config.ts";
import {
  ALLOWED_PORT,
  allowList,
  ciSandbox,
  connectTarget,
  type EgressProxy,
  hostAllowed,
  LOCAL_NOTICE,
  localSandbox,
  proxyEnv,
  sandboxedCommand,
  sandboxFor,
  startEgressProxy,
} from "./factory-sandbox.ts";
import { SANDBOX_HOME, SANDBOX_USER, type Sh } from "./factory-sandbox-setup.ts";

const root = join(import.meta.dirname, "../../..");
const raw = () => JSON.parse(readFileSync(join(root, "factory.json"), "utf8"));

describe("the allow-list in factory.json (#330)", () => {
  it("is exactly the hosts a run needs: a new one is a reviewed change to factory.json and to this test", () => {
    expect(allowList(loadFactory())).toEqual([
      "api.anthropic.com",
      "api.github.com",
      "github.com",
      "codeload.github.com",
      "objects.githubusercontent.com",
      "registry.npmjs.org",
    ]);
  });

  it("is required by the schema", () => {
    const config = raw();
    delete config.network;
    expect(configProblems(config)).not.toEqual([]);
  });

  it.each([
    ["a wildcard", "*.github.com"],
    ["an address", "140.82.112.3"],
    ["upper case", "GitHub.com"],
    ["a port", "github.com:22"],
    ["a scheme", "https://github.com"],
    ["a bare name", "localhost"],
    ["an empty name", ""],
  ])("refuses %s", (_what, host) => {
    const config = raw();
    config.network.allow = [host];
    expect(configProblems(config)).not.toEqual([]);
  });

  it("refuses an empty list, a repeated host and an unknown field", () => {
    for (const network of [
      { allow: [] },
      { allow: ["github.com", "github.com"] },
      { allow: ["github.com"], ports: [22] },
    ])
      expect(configProblems({ ...raw(), network })).not.toEqual([]);
  });

  it("is missing from a config without one, so a CI run can't start an agent from it", () => {
    expect(() => allowList({ evidence: "private/x", repos: {} })).toThrow(/no network.allow/);
  });
});

describe("hostAllowed", () => {
  const allow = ["github.com", "registry.npmjs.org"];

  it("allows a listed host on 443, in any case and with a final dot", () => {
    expect(hostAllowed(allow, "github.com", 443)).toBe(true);
    expect(hostAllowed(allow, "GitHub.COM", 443)).toBe(true);
    expect(hostAllowed(allow, "github.com.", 443)).toBe(true);
  });

  it.each([
    ["another port", "github.com", 22],
    ["plain http", "github.com", 80],
    ["a subdomain", "gist.github.com", 443],
    ["a lookalike suffix", "github.com.example.net", 443],
    ["a lookalike prefix", "evilgithub.com", 443],
    ["an address", "140.82.112.3", 443],
    ["an IPv6 literal", "[::1]", 443],
  ])("refuses %s", (_what, host, port) => {
    expect(hostAllowed(allow, host, port)).toBe(false);
  });
});

describe("connectTarget", () => {
  it("reads a CONNECT line, and nothing else", () => {
    expect(connectTarget("CONNECT github.com:443 HTTP/1.1")).toEqual({ host: "github.com", port: 443 });
    expect(connectTarget("CONNECT [::1]:443 HTTP/1.1")).toEqual({ host: "[::1]", port: 443 });
    expect(connectTarget("GET http://github.com/ HTTP/1.1")).toBeNull();
    expect(connectTarget("CONNECT github.com HTTP/1.1")).toBeNull();
    expect(connectTarget("CONNECT github.com:443 HTTP/1.1 extra")).toBeNull();
  });
});

/** Sends `request` to the proxy and returns everything it answers until it closes or 2 s pass. */
function ask(port: number, request: string, then?: string): Promise<string> {
  return new Promise((done) => {
    const socket = net.connect(port, "127.0.0.1");
    let answer = "";
    socket.on("data", (chunk) => {
      answer += chunk.toString();
      if (then && answer.includes("200 Connection Established") && !answer.includes(then)) socket.write(then);
    });
    const finish = () => {
      socket.destroy();
      done(answer);
    };
    socket.on("close", finish);
    socket.on("error", finish);
    setTimeout(finish, 2000);
    socket.write(request);
  });
}

describe("the egress proxy", () => {
  const open: { close(): unknown }[] = [];
  afterEach(async () => {
    for (const thing of open.splice(0)) await thing.close();
  });

  async function echoServer(): Promise<number> {
    const server = net.createServer((socket) => socket.pipe(socket));
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    open.push({ close: () => new Promise((closed) => server.close(closed)) });
    const address = server.address();
    return typeof address === "object" && address ? address.port : 0;
  }

  async function proxy(allow: string[], port?: number): Promise<{ proxy: EgressProxy; refused: string[] }> {
    const refused: string[] = [];
    const started = await startEgressProxy(allow, (line) => refused.push(line), port);
    open.push(started);
    return { proxy: started, refused };
  }

  it("tunnels to a listed host and port, bytes both ways", async () => {
    const echo = await echoServer();
    const { proxy: p } = await proxy(["localhost"], echo);
    const answer = await ask(p.port, `CONNECT localhost:${echo} HTTP/1.1\r\nHost: localhost\r\n\r\n`, "ping");
    expect(answer).toContain("HTTP/1.1 200 Connection Established");
    expect(answer).toContain("ping");
    expect(p.counts()).toEqual({ allowed: 1, refused: 0 });
  });

  it("refuses a host not on the list, without connecting, and reports the request line privately", async () => {
    const echo = await echoServer();
    const { proxy: p, refused } = await proxy(["github.com"], echo);
    const answer = await ask(p.port, `CONNECT 127.0.0.1:${echo} HTTP/1.1\r\n\r\n`);
    expect(answer).toMatch(/^HTTP\/1\.1 403 Forbidden/);
    expect(refused).toEqual([`CONNECT 127.0.0.1:${echo} HTTP/1.1`]);
    expect(p.counts()).toEqual({ allowed: 0, refused: 1 });
  });

  it("refuses a listed host on another port, and plain HTTP", async () => {
    const { proxy: p } = await proxy(["localhost"]);
    expect(await ask(p.port, "CONNECT localhost:22 HTTP/1.1\r\n\r\n")).toMatch(/^HTTP\/1\.1 403/);
    expect(await ask(p.port, "GET http://localhost/ HTTP/1.1\r\nHost: localhost\r\n\r\n")).toMatch(/^HTTP\/1\.1 403/);
    expect(p.counts().refused).toBe(2);
  });

  it("answers 502 when a listed host can't be reached", async () => {
    const echo = await echoServer();
    await open.shift()?.close(); // the port is free again: nothing listens there
    const { proxy: p } = await proxy(["localhost"], echo);
    expect(await ask(p.port, `CONNECT localhost:${echo} HTTP/1.1\r\n\r\n`)).toMatch(/^HTTP\/1\.1 502/);
  });

  it("tunnels only to port 443 unless a test says otherwise", () => {
    expect(ALLOWED_PORT).toBe(443);
  });
});

describe("the agent's launch", () => {
  const env = {
    PATH: "/opt/node/bin:/usr/bin",
    HOME: "/home/runner",
    GH_TOKEN: "ghp_secret",
    XDG_RUNTIME_DIR: "/run/user/1001",
    TMPDIR: "/home/runner/work/_temp/only-mine",
  };

  it("runs it as the sandbox user, keeping variables by name only: no value is on the command line", () => {
    const launch = sandboxedCommand("claude", ["-p", "x"], env);
    expect(launch.command).toBe("sudo");
    expect(launch.args.slice(0, 3)).toEqual(["-n", "-u", SANDBOX_USER]);
    expect(launch.args).toContain("--preserve-env=GH_TOKEN");
    expect(launch.args.join(" ")).not.toContain("ghp_secret");
    expect(launch.args).toContain("PATH=/opt/node/bin:/usr/bin");
    expect(launch.args).toContain(`HOME=${SANDBOX_HOME}`);
    expect(launch.args.join(" ")).not.toMatch(/\/home\/runner|XDG_RUNTIME_DIR/);
    // Its own temp folder, never the runner's, which it may not be able to write in.
    expect(launch.args).toContain("TMPDIR=/tmp");
    expect(launch.args.slice(-3)).toEqual(["claude", "-p", "x"]);
  });

  it("points every spelling of the proxy variables at the proxy, keeps loopback direct, and turns off Claude Code's other traffic", () => {
    const vars = proxyEnv(4321);
    for (const name of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"])
      expect(vars[name]).toBe("http://127.0.0.1:4321");
    expect(vars.NO_PROXY).toBe("localhost,127.0.0.1,::1");
    expect(vars.NODE_USE_ENV_PROXY).toBe("1");
    expect(vars.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
  });

  it("logs 'no network sandbox: local mode' in a local run, and starts the agent as it is", async () => {
    const events: [string, Record<string, unknown> | undefined][] = [];
    const launch = await localSandbox.open(
      "claude",
      ["-p"],
      env,
      (e, d) => events.push([e, d]),
      () => {},
    );
    expect(events).toEqual([["network-sandbox", { mode: "local", message: LOCAL_NOTICE }]]);
    expect(LOCAL_NOTICE).toBe("no network sandbox: local mode");
    expect(launch).toMatchObject({ command: "claude", args: ["-p"], env });
    expect(sandboxFor("local", loadFactory())).toBe(localSandbox);
  });

  it("documents the local mode's missing sandbox in docs/factory-trigger.md", () => {
    expect(readFileSync(join(root, "docs/factory-trigger.md"), "utf8")).toContain(LOCAL_NOTICE);
  });

  /** A fake shell where the sandbox is in place, or not (`broken`). */
  const shell =
    (broken = false, calls: string[][] = []): Sh =>
    (command, args) => {
      calls.push([command, ...args]);
      const line = [command, ...args].join(" ");
      if (line === `id -u ${SANDBOX_USER}`) return { status: broken ? 1 : 0, stdout: "998\n", stderr: "" };
      if (line === `id -nG ${SANDBOX_USER}`) return { status: 0, stdout: `${SANDBOX_USER}\n`, stderr: "" };
      if (line.startsWith("sudo -n -l -U"))
        return { status: 0, stdout: `User ${SANDBOX_USER} is not allowed to run sudo on runner.\n`, stderr: "" };
      if (/tables -w -S /.test(line))
        return {
          status: 0,
          stdout:
            "-N FF_AGENT\n-A FF_AGENT -o lo -p udp -j REJECT\n-A FF_AGENT -o lo -p tcp -j REJECT\n-A FF_AGENT -o lo -j ACCEPT\n-A FF_AGENT -p tcp -j REJECT\n-A FF_AGENT -j REJECT\n",
          stderr: "",
        };
      if (line.includes("/dev/tcp/")) return { status: 1, stdout: "", stderr: "bash: connect: Connection refused\n" };
      return { status: 0, stdout: "", stderr: "" };
    };

  it("in a CI run, refuses to start the agent when the sandbox isn't in place", async () => {
    const sandbox = ciSandbox(loadFactory(), shell(true));
    await expect(
      sandbox.open(
        "claude",
        [],
        env,
        () => {},
        () => {},
      ),
    ).rejects.toThrow(/no network sandbox, so the agent wasn't started: there is no ffagent user/);
  });

  it("in a CI run, starts the agent as the sandbox user behind the proxy, then kills that user's processes and logs counts only", async () => {
    const calls: string[][] = [];
    const events: [string, Record<string, unknown> | undefined][] = [];
    const refused: string[] = [];
    const factory: FactoryConfig = { ...loadFactory() };
    const launch = await ciSandbox(factory, shell(false, calls)).open(
      "claude",
      ["-p"],
      env,
      (e, d) => events.push([e, d]),
      (line) => refused.push(line),
    );
    expect(launch.command).toBe("sudo");
    expect(launch.env.HTTPS_PROXY).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(launch.env.GH_TOKEN).toBe("ghp_secret");
    const port = Number(launch.env.HTTPS_PROXY?.split(":").at(-1));
    expect(await ask(port, "CONNECT example.com:443 HTTP/1.1\r\n\r\n")).toMatch(/^HTTP\/1\.1 403/);
    expect(refused).toEqual(["CONNECT example.com:443 HTTP/1.1"]);
    await launch.close();
    expect(calls).toContainEqual(["sudo", "-n", "pkill", "-KILL", "-u", SANDBOX_USER]);
    expect(events.map(([e]) => e)).toEqual(["network-sandbox", "network-egress"]);
    expect(events[1]?.[1]).toEqual({ allowed: 0, refused: 1 });
    expect(JSON.stringify(events)).not.toContain("example.com");
  });
});
