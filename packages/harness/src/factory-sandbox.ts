/**
 * The agent's network sandbox, the runner's half (#330, AUD-H2). In a CI run the agent runs as its own user
 * (`factory-sandbox-setup.ts`), whose packets the operating system lets reach loopback only. On loopback the
 * runner serves a small proxy that tunnels (`CONNECT`) to the hosts in `factory.json`'s `network.allow` on port
 * 443, and to nothing else: no other host, no other port, no plain HTTP, and no lookup of a refused name. The
 * agent is told about the proxy (`HTTPS_PROXY`); a program that ignores it has no route out at all, so a test
 * runner, a script or inline code reaches no other host however it is spelled. The proxy runs inside the runner's
 * own process, as the runner's user, which the agent can't signal or change.
 *
 * On the owner's PC (local mode) there is no sandbox: the run log says "no network sandbox: local mode".
 */
import net from "node:net";
import type { FactoryConfig } from "./factory-config.ts";
import { realSh, SANDBOX_HOME, SANDBOX_USER, type Sh, sandboxProblems } from "./factory-sandbox-setup.ts";
import type { Logger } from "./factory-tick-deps.ts";
import type { RunMode } from "./factory-workspace.ts";

/** The run-log line of a run without a sandbox. */
export const LOCAL_NOTICE = "no network sandbox: local mode";

/** The only port the proxy tunnels to. */
export const ALLOWED_PORT = 443;

/** The allow-list from `factory.json`, lower case. A config without one has no sandbox to give. */
export function allowList(factory: FactoryConfig): string[] {
  const hosts = factory.network?.allow ?? [];
  if (!hosts.length) throw new Error("factory.json has no network.allow list");
  return hosts.map((h) => h.toLowerCase());
}

/** Whether a `CONNECT` target is allowed: an exact host on the list (a final dot ignored), on port 443. */
export function hostAllowed(allow: readonly string[], host: string, port: number, only = ALLOWED_PORT): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  return port === only && allow.includes(name);
}

/** A `CONNECT host:port` request line, or null for anything else. IPv6 literals in brackets are kept whole. */
export function connectTarget(line: string): { host: string; port: number } | null {
  const match = line.match(/^CONNECT (\[[^\]\s]+\]|[^\s:]+):(\d{1,5}) HTTP\/1\.[01]$/);
  return match ? { host: match[1] as string, port: Number(match[2]) } : null;
}

export interface EgressProxy {
  port: number;
  /** Tunnels opened and requests refused so far. */
  counts(): { allowed: number; refused: number };
  close(): Promise<void>;
}

/** What one program can hold of the proxy: its request head's size and time, and open connections in all. */
export interface ProxyLimits {
  headBytes: number;
  headMs: number;
  connections: number;
}
export const PROXY_LIMITS: ProxyLimits = { headBytes: 8192, headMs: 30_000, connections: 256 };

/**
 * Starts the allow-listing proxy on 127.0.0.1, on a free port. `onRefused` hears each refused request line
 * (which can carry data a program tried to send out, so it belongs in private storage only).
 */
export function startEgressProxy(
  allow: readonly string[],
  onRefused: (line: string) => void,
  /** Only the tests change it, to tunnel to a server of their own. */
  port = ALLOWED_PORT,
  limits: ProxyLimits = PROXY_LIMITS,
): Promise<EgressProxy> {
  let allowed = 0;
  let refused = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("error", () => client.destroy());
    // A client that never finishes its request is dropped, so idle ones can't pile up (Qodo on PR 334).
    client.setTimeout(limits.headMs, () => client.destroy());
    let head = Buffer.alloc(0);
    const refuse = (line: string) => {
      refused++;
      onRefused(line.slice(0, 300));
      client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    };
    const onData = (chunk: Buffer) => {
      // Measured before it is kept: a request head never grows past the limit in memory.
      if (head.length + chunk.length > limits.headBytes) {
        client.off("data", onData);
        return refuse("(request head too long)");
      }
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) return;
      client.off("data", onData);
      client.setTimeout(0);
      const line = head.subarray(0, head.indexOf("\r\n")).toString("latin1");
      const target = connectTarget(line);
      if (!target || !hostAllowed(allow, target.host, target.port, port)) return refuse(line);
      allowed++;
      let established = false;
      const upstream = net.connect(target.port, target.host.replace(/\.$/, ""), () => {
        established = true;
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        const rest = head.subarray(end + 4);
        if (rest.length) upstream.write(rest);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      sockets.add(upstream);
      upstream.on("close", () => {
        sockets.delete(upstream);
        client.destroy();
      });
      upstream.on("error", () => {
        if (!client.destroyed && !established)
          client.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        else client.destroy();
      });
      client.on("close", () => upstream.destroy());
    };
    client.on("data", onData);
  });
  server.maxConnections = limits.connections;
  return new Promise((ready, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      ready({
        port: typeof address === "object" && address ? address.port : 0,
        counts: () => ({ allowed, refused }),
        close: () =>
          new Promise((closed) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => closed());
          }),
      });
    });
  });
}

/** The variables that send a program through the proxy, in every spelling the agent's tools read. */
export function proxyEnv(port: number): Record<string, string> {
  const url = `http://127.0.0.1:${port}`;
  const local = "localhost,127.0.0.1,::1";
  return {
    HTTPS_PROXY: url,
    https_proxy: url,
    HTTP_PROXY: url,
    http_proxy: url,
    NO_PROXY: local,
    no_proxy: local,
    // Node 24's own fetch and http honour the variables above only with this (a script the agent writes).
    NODE_USE_ENV_PROXY: "1",
    // Claude Code then needs api.anthropic.com alone: no telemetry, error reports or update checks.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
}

/**
 * Variables that name the runner's own user or its folders, which the agent's user gets its own of. The temp
 * folder too: the runner's can be one only it may write in.
 */
const RUNNER_ONLY = /^(PATH|HOME|USER|LOGNAME|TMPDIR|TMP|TEMP|XDG_\w+)$/;
/** The agent's temp folder: the system's, where every user may write (sticky, so not into another's files). */
export const SANDBOX_TMP = "/tmp";

/**
 * The command that starts `binary` as the agent's user: `sudo -n -u ffagent`, keeping the agent's environment by
 * name (never its values on the command line, which every user can read), then `env` for the path and the
 * user's own home. `sudo` keeps its own safe path, so the agent's `PATH` is set after it.
 */
export function sandboxedCommand(
  binary: string,
  args: string[],
  env: Record<string, string>,
): { command: string; args: string[]; env: Record<string, string> } {
  const kept = Object.keys(env).filter((name) => !RUNNER_ONLY.test(name));
  return {
    command: "sudo",
    args: [
      "-n",
      "-u",
      SANDBOX_USER,
      ...(kept.length ? [`--preserve-env=${kept.join(",")}`] : []),
      "--",
      "/usr/bin/env",
      `PATH=${env.PATH ?? "/usr/bin:/bin"}`,
      `HOME=${SANDBOX_HOME}`,
      `USER=${SANDBOX_USER}`,
      `LOGNAME=${SANDBOX_USER}`,
      `TMPDIR=${SANDBOX_TMP}`,
      binary,
      ...args,
    ],
    env,
  };
}

/** How the runner starts the agent, ends it, and closes the sandbox afterwards. */
export interface Launch {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Ends the agent's whole process tree (`killTree` locally; every process of its user in a sandbox). */
  kill?: (pid: number) => void;
  /** Called once the agent has ended: closes the proxy and logs its counts. */
  close(): Promise<void>;
}

export interface AgentSandbox {
  /** Prepares the agent's launch, or throws why it can't run (a CI run never starts an agent unsandboxed). */
  open(
    binary: string,
    args: string[],
    env: Record<string, string>,
    log: Logger,
    /** Hears each refused request line, for the agent's private transcript only. */
    onRefused: (line: string) => void,
  ): Promise<Launch>;
}

/** The owner's PC: no sandbox, said in the run log. */
export const localSandbox: AgentSandbox = {
  async open(binary, args, env, log) {
    log("network-sandbox", { mode: "local", message: LOCAL_NOTICE });
    return { command: binary, args, env, close: async () => {} };
  },
};

/** A CI run: the user and chain must be in place, then the proxy starts and the agent runs as that user. */
export function ciSandbox(factory: FactoryConfig, sh: Sh = realSh): AgentSandbox {
  return {
    async open(binary, args, env, log, onRefused) {
      const allow = allowList(factory);
      const problems = sandboxProblems(sh);
      if (problems.length) throw new Error(`no network sandbox, so the agent wasn't started: ${problems.join("; ")}`);
      const proxy = await startEgressProxy(allow, onRefused);
      log("network-sandbox", { mode: "ci", user: SANDBOX_USER, allow });
      const launch = sandboxedCommand(binary, args, { ...env, ...proxyEnv(proxy.port) });
      const killAll = () => {
        sh("sudo", ["-n", "pkill", "-KILL", "-u", SANDBOX_USER]);
      };
      return {
        ...launch,
        kill: killAll,
        close: async () => {
          killAll();
          // Counts only: a refused request line can carry what a program tried to send, and the run log can be public.
          log("network-egress", proxy.counts());
          await proxy.close();
        },
      };
    },
  };
}

/** The sandbox for a run mode. */
export const sandboxFor = (mode: RunMode, factory: FactoryConfig): AgentSandbox =>
  mode === "ci" ? ciSandbox(factory) : localSandbox;
