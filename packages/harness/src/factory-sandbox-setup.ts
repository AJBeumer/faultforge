/**
 * `npm run factory:sandbox -- setup --dir <path> [--dir <path>]... | check`: the operating system's half of
 * the agent's network sandbox in a CI factory run (#330, AUD-H2). The runner's own steps keep the network; the
 * agent runs as its own unprivileged user, `ffagent`, whose every outbound packet goes through one iptables chain
 * (IPv4 and IPv6) that allows loopback only, without DNS. Its one way out is the runner's allow-listing proxy on
 * loopback (`factory-sandbox.ts`), which tunnels only to the hosts in `factory.json`. A program that ignores
 * `HTTPS_PROXY` has no route at all.
 *
 *  - setup: makes the user (no sudo, no docker group, no password), its chain, a D-Bus policy and socket ACLs that
 *    keep it from asking the system's resolver to look a name up for it, read and write access to the run's
 *    folders (`--dir`, by ACL, inherited by new files for both users), read access to Node's install, and the
 *    runner's git identity and credential helper in its own home.
 *  - check: whether all of that is in place, with a live probe: a direct connection from the agent's user must
 *    be refused by the chain.
 *
 * The workflow stops the user's processes after the tick with plain shell, not with a script from the checkout.
 * Linux only. Every privileged step goes through `sudo -n`, so it fails instead of asking for a password.
 *
 * Exit codes: 0 done (setup) or in place (check); 1 check found the sandbox not in place, each problem
 * printed; 2 could not run: not Linux, a usage error, a command that failed, or an unexpected error.
 */
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/** The agent's user in a CI run. */
export const SANDBOX_USER = "ffagent";
/** Its home, where Claude Code, npm and git keep their own files. */
export const SANDBOX_HOME = `/home/${SANDBOX_USER}`;
/** The iptables chain every packet of that user goes through. */
export const SANDBOX_CHAIN = "FF_AGENT";
/** The D-Bus policy that keeps the agent's user off the system resolver's bus API. */
export const DBUS_POLICY_FILE = "/etc/dbus-1/system.d/faultforge-agent.conf";
/** Local sockets that resolve a name for whoever asks; the agent's user gets an ACL with no rights on each. */
export const RESOLVER_SOCKETS = ["/run/systemd/resolve/io.systemd.Resolve", "/var/run/nscd/socket"];
/** Groups that would hand the agent's user the machine (and so the network) back. */
const PRIVILEGED_GROUPS = ["sudo", "admin", "wheel", "docker", "lxd"];

/** Runs one command; `input` goes to its stdin. */
export type Sh = (
  command: string,
  args: string[],
  input?: string,
) => { status: number | null; stdout: string; stderr: string };

export const realSh: Sh = (command, args, input) => {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 300_000, input });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: `${result.stderr ?? ""}${result.error ? result.error.message : ""}`,
  };
};

/** One step of the setup: a command, and whether its failure is expected (a chain that already exists). */
export interface Step {
  argv: string[];
  input?: string;
  /** Skipped when this command succeeds (the rule is already there). */
  unless?: string[];
  mayFail?: boolean;
}

/** The chain's rules, in order: loopback without DNS, then nothing. */
export function chainRules(chain = SANDBOX_CHAIN): string[][] {
  return [
    ["-o", "lo", "-p", "udp", "--dport", "53", "-j", "REJECT"],
    ["-o", "lo", "-p", "tcp", "--dport", "53", "-j", "REJECT", "--reject-with", "tcp-reset"],
    ["-o", "lo", "-j", "ACCEPT"],
    ["-p", "tcp", "-j", "REJECT", "--reject-with", "tcp-reset"],
    ["-j", "REJECT"],
  ].map((rule) => ["-A", chain, ...rule]);
}

/** The OUTPUT rule that sends the user's packets to the chain. */
export const ownerRule = (user = SANDBOX_USER, chain = SANDBOX_CHAIN) => [
  "OUTPUT",
  "-m",
  "owner",
  "--uid-owner",
  user,
  "-j",
  chain,
];

/** Every folder above `dir`, nearest first, up to but not including the root. */
export function ancestors(dir: string): string[] {
  const out: string[] = [];
  for (let at = dirname(resolve(dir)); at !== dirname(at); at = dirname(at)) out.push(at);
  return out;
}

/** The D-Bus policy: the agent's user may not send to systemd-resolved, which would look any name up for it. */
export const DBUS_POLICY = `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-BUS Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <policy user="${SANDBOX_USER}">
    <deny send_destination="org.freedesktop.resolve1"/>
  </policy>
</busconfig>
`;

export interface SetupInput {
  /** Folders the agent works in: read and write, for it and for the runner, inherited by new files. */
  dirs: string[];
  /** Folders it only reads and runs from: Node's install, with Claude Code in it. */
  readDirs: string[];
  /** The runner's own user. */
  runner: string;
  /** The runner's git config, copied into the agent's home when it exists. */
  gitconfig: string | null;
  /** Which resolver sockets and bus exist on this machine. */
  exists: (path: string) => boolean;
  /** Whether users other than its owner and group may already pass through a folder. */
  othersEnter: (dir: string) => boolean;
}

/** Whether "other" has execute (pass-through) on a folder. */
export const othersEnter = (dir: string): boolean => (statSync(dir).mode & 0o001) !== 0;

/** The setup, as commands: pure, so the tests read exactly what will run. */
export function setupPlan(input: SetupInput): Step[] {
  const u = SANDBOX_USER;
  const sudo = (...argv: string[]) => ["sudo", "-n", ...argv];
  const steps: Step[] = [
    {
      unless: ["id", "-u", u],
      argv: sudo("useradd", "--system", "--create-home", "--home-dir", SANDBOX_HOME, "--shell", "/usr/sbin/nologin", u),
    },
  ];
  for (const bin of ["iptables", "ip6tables"]) {
    steps.push({ argv: sudo(bin, "-w", "-N", SANDBOX_CHAIN), mayFail: true });
    steps.push({ argv: sudo(bin, "-w", "-F", SANDBOX_CHAIN) });
    for (const rule of chainRules()) steps.push({ argv: sudo(bin, "-w", ...rule) });
    steps.push({
      unless: sudo(bin, "-w", "-C", ...ownerRule()),
      argv: sudo(bin, "-w", "-I", ownerRule()[0] as string, "1", ...ownerRule().slice(1)),
    });
  }
  if (input.exists("/run/dbus/system_bus_socket")) {
    steps.push({ argv: sudo("tee", DBUS_POLICY_FILE), input: DBUS_POLICY });
    steps.push({ argv: sudo("systemctl", "reload", "dbus") });
  }
  for (const socket of RESOLVER_SOCKETS)
    if (input.exists(socket)) steps.push({ argv: sudo("setfacl", "-m", `u:${u}:-`, socket) });
  // Only where everyone else is kept out: a named entry outranks "other", so on a folder others may already write
  // in (/tmp) an `x` entry would take the agent's write access away.
  const traverse = new Set([...input.dirs, ...input.readDirs].flatMap(ancestors));
  for (const dir of traverse) if (!input.othersEnter(dir)) steps.push({ argv: sudo("setfacl", "-m", `u:${u}:x`, dir) });
  for (const dir of input.dirs) {
    steps.push({ argv: sudo("setfacl", "-R", "-m", `u:${u}:rwX`, dir) });
    steps.push({
      argv: sudo(
        "find",
        dir,
        "-type",
        "d",
        "-exec",
        "setfacl",
        "-m",
        `d:u:${u}:rwX,d:u:${input.runner}:rwX`,
        "{}",
        "+",
      ),
    });
  }
  for (const dir of input.readDirs) steps.push({ argv: sudo("setfacl", "-R", "-m", `u:${u}:rX`, dir) });
  const gitconfig = join(SANDBOX_HOME, ".gitconfig");
  if (input.gitconfig) steps.push({ argv: sudo("install", "-o", u, "-g", u, "-m", "600", input.gitconfig, gitconfig) });
  steps.push({
    argv: sudo(
      "-u",
      u,
      "/usr/bin/env",
      `HOME=${SANDBOX_HOME}`,
      "git",
      "config",
      "--global",
      "--add",
      "safe.directory",
      "*",
    ),
  });
  return steps;
}

/** Runs the plan; returns the first failure, or null. */
export function runPlan(sh: Sh, plan: Step[]): string | null {
  for (const step of plan) {
    const [command, ...args] = step.unless ?? [];
    if (command && sh(command, args).status === 0) continue;
    const [bin, ...rest] = step.argv;
    const result = sh(bin as string, rest, step.input);
    if (result.status !== 0 && !step.mayFail)
      return `${step.argv.join(" ")} failed (exit ${result.status}): ${result.stderr.trim().split("\n").at(-1) ?? ""}`;
  }
  return null;
}

/**
 * What is missing from the sandbox, or an empty list: the user and its rights, both chains, and a live probe
 * that a direct connection from the user is refused by the chain (a reset, never a connection or a timeout).
 */
export function sandboxProblems(sh: Sh = realSh): string[] {
  const u = SANDBOX_USER;
  if (sh("id", ["-u", u]).status !== 0) return [`there is no ${u} user`];
  const problems: string[] = [];
  const groups = sh("id", ["-nG", u]).stdout.split(/\s+/).filter(Boolean);
  const privileged = groups.filter((g) => PRIVILEGED_GROUPS.includes(g));
  if (privileged.length) problems.push(`${u} is in ${privileged.join(", ")}`);
  const sudo = sh("sudo", ["-n", "-l", "-U", u]);
  if (sudo.status !== 0 || !/is not allowed to run sudo/.test(sudo.stdout))
    problems.push(`${u} may run sudo, or that couldn't be checked`);
  for (const bin of ["iptables", "ip6tables"]) {
    if (sh("sudo", ["-n", bin, "-w", "-C", ...ownerRule()]).status !== 0)
      problems.push(`${bin}: ${u}'s packets don't go through ${SANDBOX_CHAIN}`);
    const rules = sh("sudo", ["-n", bin, "-w", "-S", SANDBOX_CHAIN])
      .stdout.split("\n")
      .filter((line) => line.startsWith(`-A ${SANDBOX_CHAIN} `));
    if (rules.length !== chainRules().length || !/^-A \S+ -j REJECT\b/.test(rules.at(-1) ?? ""))
      problems.push(`${bin}: ${SANDBOX_CHAIN} doesn't end by refusing everything else`);
  }
  const probe = sh("sudo", ["-n", "-u", u, "/bin/bash", "-c", "exec 3<>/dev/tcp/1.1.1.1/443"]);
  if (probe.status === 0 || !/Connection refused/.test(probe.stderr))
    problems.push(`a direct connection from ${u} was not refused (${probe.stderr.trim() || `exit ${probe.status}`})`);
  return problems;
}

/** Kills every process of the agent's user; returns a problem if one is still there. The integration test's
 * cleanup; the workflow does the same in plain shell. */
export function stopAgentProcesses(
  sh: Sh = realSh,
  wait: () => void = () => {
    spawnSync("sleep", ["0.25"]);
  },
): string | null {
  // No user (the setup never ran): no process of it either.
  if (sh("id", ["-u", SANDBOX_USER]).status !== 0) return null;
  sh("sudo", ["-n", "pkill", "-KILL", "-u", SANDBOX_USER]);
  for (let i = 0; i < 20; i++) {
    if (sh("pgrep", ["-u", SANDBOX_USER]).status === 1) return null;
    wait();
  }
  return `a process of ${SANDBOX_USER} is still running`;
}

/** The runner's Node install: the folder holding `bin/node`, where a global Claude Code lives too. */
export const nodePrefix = () => dirname(dirname(process.execPath));

export function main(argv: string[], sh: Sh = realSh): number {
  if (process.platform !== "linux") {
    console.error("factory:sandbox: the network sandbox runs only on Linux; a local run has none.");
    return 2;
  }
  const { values, positionals } = parseArgs({
    args: argv,
    options: { dir: { type: "string", multiple: true } },
    allowPositionals: true,
  });
  const [command] = positionals;
  if (command === "setup") {
    const dirs = (values.dir ?? []).map((d) => resolve(d));
    if (!dirs.length) {
      console.error("usage: npm run factory:sandbox -- setup --dir <path> [--dir <path>]...");
      return 2;
    }
    const gitconfig = join(homedir(), ".gitconfig");
    const failed = runPlan(
      sh,
      setupPlan({
        dirs,
        readDirs: [nodePrefix()],
        runner: userInfo().username,
        gitconfig: existsSync(gitconfig) ? gitconfig : null,
        exists: existsSync,
        othersEnter,
      }),
    );
    if (failed) {
      console.error(`factory:sandbox setup: ${failed}`);
      return 2;
    }
    const problems = sandboxProblems(sh);
    for (const problem of problems) console.error(`factory:sandbox setup: ${problem}`);
    if (problems.length) return 2;
    console.log(`factory:sandbox: ${SANDBOX_USER} reaches only loopback; the runner's proxy is its way out.`);
    return 0;
  }
  if (command === "check") {
    const problems = sandboxProblems(sh);
    for (const problem of problems) console.error(`factory:sandbox check: ${problem}`);
    return problems.length ? 1 : 0;
  }
  console.error("usage: npm run factory:sandbox -- setup --dir <path>... | check");
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error(`factory:sandbox: ${(error as Error).message}`);
    process.exit(2);
  }
}
