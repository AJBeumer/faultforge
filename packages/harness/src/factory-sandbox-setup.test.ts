import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ancestors,
  chainRules,
  DBUS_POLICY,
  DBUS_POLICY_FILE,
  main,
  ownerRule,
  RESOLVER_SOCKETS,
  runPlan,
  SANDBOX_CHAIN,
  SANDBOX_HOME,
  SANDBOX_USER,
  type SetupInput,
  type Sh,
  sandboxProblems,
  setupPlan,
  stopAgentProcesses,
  teardownPlan,
} from "./factory-sandbox-setup.ts";

const work = resolve("/work/ws");
const input = (over: Partial<SetupInput> = {}): SetupInput => ({
  dirs: [work],
  readDirs: [resolve("/opt/node")],
  runner: "runner",
  gitconfig: resolve("/home/runner/.gitconfig"),
  exists: () => true,
  othersEnter: () => false,
  ...over,
});
const lines = (over: Partial<SetupInput> = {}) => setupPlan(input(over)).map((s) => s.argv.join(" "));

describe("setupPlan (#330)", () => {
  it("makes a system user with no extra groups, no password and no sudo rule", () => {
    const [first] = setupPlan(input());
    expect(first?.unless).toEqual(["id", "-u", SANDBOX_USER]);
    expect(first?.argv).toEqual([
      "sudo",
      "-n",
      "useradd",
      "--system",
      "--create-home",
      "--home-dir",
      SANDBOX_HOME,
      "--shell",
      "/usr/sbin/nologin",
      SANDBOX_USER,
    ]);
    const all = lines().join("\n");
    expect(all).not.toMatch(/usermod|-G |--groups|sudoers|passwd/);
  });

  it("gives IPv4 and IPv6 the same chain: loopback without DNS, then refuse everything", () => {
    expect(chainRules().map((r) => r.slice(2).join(" "))).toEqual([
      "-o lo -p udp --dport 53 -j REJECT",
      "-o lo -p tcp --dport 53 -j REJECT --reject-with tcp-reset",
      "-o lo -j ACCEPT",
      "-p tcp -j REJECT --reject-with tcp-reset",
      "-j REJECT",
    ]);
    for (const bin of ["iptables", "ip6tables"]) {
      const mine = lines().filter((l) => l.startsWith(`sudo -n ${bin} `));
      expect(mine).toContain(`sudo -n ${bin} -w -F ${SANDBOX_CHAIN}`);
      for (const rule of chainRules()) expect(mine).toContain(`sudo -n ${bin} -w ${rule.join(" ")}`);
      // The owner rule goes first in OUTPUT, ahead of anything that would accept the packet.
      expect(mine.at(-1)).toBe(
        `sudo -n ${bin} -w -I OUTPUT 1 -m owner --uid-owner ${SANDBOX_USER} -j ${SANDBOX_CHAIN}`,
      );
    }
    expect(ownerRule()).toEqual(["OUTPUT", "-m", "owner", "--uid-owner", SANDBOX_USER, "-j", SANDBOX_CHAIN]);
  });

  it("keeps the user off the system resolver: a D-Bus policy and no rights on its sockets", () => {
    const plan = setupPlan(input());
    const tee = plan.find((s) => s.argv.includes(DBUS_POLICY_FILE));
    expect(tee?.input).toBe(DBUS_POLICY);
    expect(DBUS_POLICY).toContain(`<policy user="${SANDBOX_USER}">`);
    expect(DBUS_POLICY).toContain('<deny send_destination="org.freedesktop.resolve1"/>');
    for (const socket of RESOLVER_SOCKETS)
      expect(lines()).toContain(`sudo -n setfacl -m u:${SANDBOX_USER}:- ${socket}`);
    // Neither is touched on a machine that has none.
    expect(lines({ exists: () => false }).join("\n")).not.toMatch(/dbus|resolve|nscd/);
  });

  it("gives the run's folders to both users, inherited by new files, and Node's install read-only", () => {
    const all = lines();
    expect(all).toContain(`sudo -n setfacl -R -m u:${SANDBOX_USER}:rwX ${work}`);
    expect(all).toContain(`sudo -n find ${work} -type d -exec setfacl -m d:u:${SANDBOX_USER}:rwX,d:u:runner:rwX {} +`);
    expect(all).toContain(`sudo -n setfacl -R -m u:${SANDBOX_USER}:rX ${resolve("/opt/node")}`);
    for (const above of ancestors(work)) expect(all).toContain(`sudo -n setfacl -m u:${SANDBOX_USER}:x ${above}`);
  });

  it("leaves alone a folder above that others may already enter: a named x entry would take /tmp's write away", () => {
    const open = resolve("/work");
    const all = lines({ othersEnter: (dir) => dir === open });
    expect(all).not.toContain(`sudo -n setfacl -m u:${SANDBOX_USER}:x ${open}`);
    expect(all.filter((l) => l.startsWith(`sudo -n setfacl -m u:${SANDBOX_USER}:x `)).length).toBe(
      new Set([...ancestors(work), ...ancestors(resolve("/opt/node"))]).size - 1,
    );
  });

  it("copies the runner's git identity and credential helper, and trusts the run's checkouts", () => {
    const all = lines();
    expect(all).toContain(
      `sudo -n install -o ${SANDBOX_USER} -g ${SANDBOX_USER} -m 600 ${resolve("/home/runner/.gitconfig")} ${join(SANDBOX_HOME, ".gitconfig")}`,
    );
    expect(all.at(-1)).toBe(
      `sudo -n -u ${SANDBOX_USER} /usr/bin/env HOME=${SANDBOX_HOME} git config --global --add safe.directory *`,
    );
    expect(lines({ gitconfig: null }).join("\n")).not.toContain(" install ");
  });
});

describe("teardownPlan (Qodo on PR 334)", () => {
  const down = (over: Partial<SetupInput> = {}, created = true) => teardownPlan(input(over), created);

  it("undoes every kind of change the setup makes, each step tried whatever an earlier one did", () => {
    const plan = down();
    expect(plan.every((s) => s.mayFail && s.argv[0] === "sudo" && s.argv[1] === "-n")).toBe(true);
    const all = plan.map((s) => s.argv.join(" "));
    expect(all[0]).toBe(`sudo -n pkill -KILL -u ${SANDBOX_USER}`);
    expect(all.at(-1)).toBe(`sudo -n userdel --remove ${SANDBOX_USER}`);
    for (const bin of ["iptables", "ip6tables"]) {
      expect(all).toContain(`sudo -n ${bin} -w -D ${ownerRule().join(" ")}`);
      expect(all).toContain(`sudo -n ${bin} -w -X ${SANDBOX_CHAIN}`);
    }
    expect(all).toContain(`sudo -n rm -f ${DBUS_POLICY_FILE}`);
    for (const socket of RESOLVER_SOCKETS) expect(all).toContain(`sudo -n setfacl -x u:${SANDBOX_USER} ${socket}`);
    expect(all).toContain(`sudo -n setfacl -R -x u:${SANDBOX_USER} ${work}`);
    expect(all).toContain(`sudo -n setfacl -R -x u:${SANDBOX_USER} ${resolve("/opt/node")}`);
    expect(all).toContain(`sudo -n find ${work} -type d -exec setfacl -x d:u:${SANDBOX_USER},d:u:runner {} +`);
    for (const above of ancestors(work)) expect(all).toContain(`sudo -n setfacl -x u:${SANDBOX_USER} ${above}`);
  });

  it("touches only what the setup touched: no bus or socket it never changed, no folder others could enter", () => {
    const open = resolve("/work");
    const all = down({ exists: () => false, othersEnter: (dir) => dir === open }).map((s) => s.argv.join(" "));
    expect(all.join("\n")).not.toMatch(/dbus|resolve|nscd/);
    expect(all).not.toContain(`sudo -n setfacl -x u:${SANDBOX_USER} ${open}`);
  });

  it("never deletes an account the setup didn't make", () => {
    const kept = down({}, false).map((s) => s.argv.join(" "));
    expect(kept.join("\n")).not.toContain("userdel");
    // Its processes and the sandbox's own rules still go.
    expect(kept[0]).toBe(`sudo -n pkill -KILL -u ${SANDBOX_USER}`);
    expect(kept).toContain(`sudo -n iptables -w -X ${SANDBOX_CHAIN}`);
  });
});

describe("ancestors", () => {
  it("lists every folder above, nearest first, without the root", () => {
    const dir = resolve("/a/b/c");
    expect(ancestors(dir)).toEqual([resolve("/a/b"), resolve("/a")]);
  });
});

describe("runPlan", () => {
  it("skips a step whose 'unless' succeeds, tolerates an expected failure, and stops at the first real one", () => {
    const ran: string[] = [];
    const sh: Sh = (command, args) => {
      const line = [command, ...args].join(" ");
      ran.push(line);
      return { status: line === "check" || line === "ok" ? 0 : 1, stdout: "", stderr: "boom\n" };
    };
    const failed = runPlan(sh, [
      { unless: ["check"], argv: ["skipped"] },
      { argv: ["tolerated"], mayFail: true },
      { argv: ["ok"] },
      { argv: ["broken"] },
      { argv: ["never"] },
    ]);
    expect(failed).toBe("broken failed (exit 1): boom");
    expect(ran).toEqual(["check", "tolerated", "ok", "broken"]);
  });
});

/** A fake shell for the check, with one part of the sandbox broken. */
function checkShell(broken: "none" | "group" | "sudo" | "rule" | "chain" | "probe-open" | "probe-timeout"): Sh {
  return (command, args) => {
    const line = [command, ...args].join(" ");
    const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
    if (line === `id -u ${SANDBOX_USER}`) return ok("998\n");
    if (line === `id -nG ${SANDBOX_USER}`)
      return ok(broken === "group" ? `${SANDBOX_USER} docker\n` : `${SANDBOX_USER}\n`);
    if (line.startsWith("sudo -n -l -U"))
      return ok(
        broken === "sudo"
          ? "User ffagent may run the following commands"
          : "User ffagent is not allowed to run sudo on x.\n",
      );
    if (/tables -w -C OUTPUT/.test(line)) return { status: broken === "rule" ? 1 : 0, stdout: "", stderr: "" };
    if (/tables -w -S /.test(line)) {
      const rules = chainRules().map((r) => r.join(" "));
      return ok(`-N ${SANDBOX_CHAIN}\n${(broken === "chain" ? rules.slice(0, 3) : rules).join("\n")}\n`);
    }
    if (line.includes("/dev/tcp/")) {
      if (broken === "probe-open") return ok();
      if (broken === "probe-timeout") return { status: 1, stdout: "", stderr: "bash: connect: Connection timed out\n" };
      return { status: 1, stdout: "", stderr: "bash: connect: Connection refused\n" };
    }
    return ok();
  };
}

describe("sandboxProblems", () => {
  it("finds nothing when the user, both chains and the live probe are right", () => {
    expect(sandboxProblems(checkShell("none"))).toEqual([]);
  });

  it.each([
    ["group", /is in docker/],
    ["sudo", /may run sudo/],
    ["rule", /packets don't go through FF_AGENT/],
    ["chain", /doesn't end by refusing everything else/],
    ["probe-open", /direct connection from ffagent was not refused/],
    ["probe-timeout", /direct connection from ffagent was not refused/],
  ] as const)("reports a broken %s", (broken, problem) => {
    expect(sandboxProblems(checkShell(broken)).join("\n")).toMatch(problem);
  });

  it("reports a missing user alone", () => {
    expect(sandboxProblems(() => ({ status: 1, stdout: "", stderr: "" }))).toEqual([
      `there is no ${SANDBOX_USER} user`,
    ]);
  });
});

describe("stopAgentProcesses", () => {
  it("kills every process of the user, and says so when one is left", () => {
    const calls: string[] = [];
    const gone: Sh = (command, args) => {
      calls.push([command, ...args].join(" "));
      return { status: command === "pgrep" ? 1 : 0, stdout: "", stderr: "" };
    };
    expect(stopAgentProcesses(gone, () => {})).toBeNull();
    expect(calls.slice(0, 2)).toEqual([`id -u ${SANDBOX_USER}`, `sudo -n pkill -KILL -u ${SANDBOX_USER}`]);
    const stuck: Sh = () => ({ status: 0, stdout: "", stderr: "" });
    expect(stopAgentProcesses(stuck, () => {})).toMatch(/still running/);
    // No such user: nothing to kill, and no sudo call at all.
    const none: string[] = [];
    const noUser: Sh = (command, args) => {
      none.push([command, ...args].join(" "));
      return { status: 1, stdout: "", stderr: "" };
    };
    expect(stopAgentProcesses(noUser, () => {})).toBeNull();
    expect(none).toEqual([`id -u ${SANDBOX_USER}`]);
  });
});

describe("main", () => {
  it.runIf(process.platform !== "linux")("refuses to run off Linux (exit 2)", () => {
    expect(main(["check"])).toBe(2);
  });

  it.runIf(process.platform === "linux")(
    "exits 2 on a usage error, 1 for a check that finds problems, 0 when in place",
    () => {
      expect(main(["bogus"], checkShell("none"))).toBe(2);
      expect(main(["setup"], checkShell("none"))).toBe(2);
      expect(main(["check"], checkShell("rule"))).toBe(1);
      expect(main(["check"], checkShell("none"))).toBe(0);
    },
  );
});
