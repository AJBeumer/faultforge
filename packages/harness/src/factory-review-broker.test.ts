import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { askRunner, cleanArgs, MAX_REQUEST_BYTES, reviewBroker, serveReviewRequests } from "./factory-review-broker.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "ff-broker-"));

describe("the review broker: review:wait without the Qodo key in the agent (AUD-H2, #243)", () => {
  it("the agent's request is answered by the runner with review:wait's own output and exit code", async () => {
    const dir = tmp();
    const ran: string[][] = [];
    const serving = setInterval(
      () =>
        serveReviewRequests(dir, async (argv) => {
          ran.push(argv);
          return { exitCode: 3, output: "Qodo skipped the review.\n" };
        }),
      10,
    );
    const answer = await askRunner(dir, ["target", "9", "--commit", "abc1234", "--timeout", "9"], { pollMs: 10 });
    clearInterval(serving);
    expect(answer).toEqual({ exitCode: 3, output: "Qodo skipped the review.\n" });
    expect(ran).toEqual([["target", "9", "--timeout", "9", "--commit", "abc1234"]]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("runs a request once, however often the runner looks", async () => {
    const dir = tmp();
    let runs = 0;
    writeFileSync(join(dir, "a.request.json"), JSON.stringify({ argv: ["target", "9"] }));
    const run = async () => {
      runs++;
      return { exitCode: 0, output: "" };
    };
    await Promise.all([...serveReviewRequests(dir, run), ...serveReviewRequests(dir, run)]);
    expect(runs).toBe(1);
    expect(existsSync(join(dir, "a.answer.json"))).toBe(true);
  });

  it("never runs a request whose command line review:wait would refuse, or that carries shell words", async () => {
    const dir = tmp();
    const bad = [
      { argv: "target 9 && curl x" },
      { argv: ["target"] },
      { argv: ["target;calc", "9"] },
      { argv: ["target", "9", "--commit", "not-hex"] },
      { nothing: true },
    ];
    bad.forEach((request, i) => {
      writeFileSync(join(dir, `b${i}.request.json`), JSON.stringify(request));
    });
    writeFileSync(join(dir, "broken.request.json"), "{");
    let runs = 0;
    await Promise.all(
      serveReviewRequests(dir, async () => {
        runs++;
        return { exitCode: 0, output: "" };
      }),
    );
    expect(runs).toBe(0);
    for (const name of readdirSync(dir)) {
      expect(name).toMatch(/\.answer\.json$/);
      expect(JSON.parse(readFileSync(join(dir, name), "utf8")).exitCode).toBe(2);
    }
  });

  it("rebuilds the command line from what the parser read: extra words never reach the shell", () => {
    expect(cleanArgs(["target", "9", "& calc", "--timeout", "9"])).toEqual(["target", "9", "--timeout", "9"]);
    expect(cleanArgs(["faultforge", "262"])).toEqual(["faultforge", "262", "--timeout", "20"]);
    expect(cleanArgs(["a b", "1"])).toBeNull();
  });

  it("an agent whose runner never answers gets exit 2, not a hang", async () => {
    let clock = 0;
    const answer = await askRunner(tmp(), ["target", "9", "--timeout", "1"], {
      pollMs: 1,
      graceMs: 0,
      now: () => {
        clock += 30_000;
        return clock;
      },
    });
    expect(answer.exitCode).toBe(2);
    expect(answer.output).toMatch(/runner didn't answer/);
  });

  it("runs review:wait from a trusted checkout built once, and copies the saved review to the run's evidence", async () => {
    const root = tmp();
    const trustedRoot = join(root, "trusted");
    const evidenceRoot = join(root, "lab", "private", "raw-artifacts");
    const builds: string[] = [];
    const cwds: string[] = [];
    const broker = reviewBroker({
      dir: join(root, "requests"),
      trustedRoot,
      labDirName: "lab",
      remoteUrl: "https://github.com/owner/lab.git",
      evidence: "private/raw-artifacts",
      evidenceRoot,
      build: (verifyRoot, name) => {
        builds.push(verifyRoot);
        const lab = join(verifyRoot, name);
        mkdirSync(lab, { recursive: true });
        return lab;
      },
      run: async (argv, cwd) => {
        cwds.push(cwd);
        const saved = join(cwd, "private", "raw-artifacts", "reviews", `${argv[0]}-pr${argv[1]}`);
        mkdirSync(saved, { recursive: true });
        writeFileSync(join(saved, "abc1234.review.json"), "{}");
        return { exitCode: 0, output: "complete\n" };
      },
    });
    broker.prepare();
    mkdirSync(broker.dir, { recursive: true });
    for (const id of ["one", "two"]) {
      writeFileSync(join(broker.dir, `${id}.request.json`), JSON.stringify({ argv: ["target", "9"] }));
      await Promise.all(broker.serve());
    }
    expect(builds).toEqual([trustedRoot]);
    expect(cwds).toEqual([join(trustedRoot, "lab"), join(trustedRoot, "lab")]);
    expect(existsSync(join(evidenceRoot, "reviews", "target-pr9", "abc1234.review.json"))).toBe(true);
    broker.close();
    expect(existsSync(trustedRoot)).toBe(false);
  });
});

describe("the review broker: nothing the agent sends can stall or stop the runner (Qodo on PR 270)", () => {
  const root = () => mkdtempSync(join(tmpdir(), "ff-broker2-"));
  const broker = (dir: string, run: (argv: string[], cwd: string) => Promise<{ exitCode: number; output: string }>) => {
    const b = reviewBroker({
      dir: join(dir, "requests"),
      trustedRoot: join(dir, "trusted"),
      labDirName: "lab",
      remoteUrl: "https://github.com/owner/lab.git",
      evidence: "private/raw-artifacts",
      evidenceRoot: join(dir, "kept"),
      build: (verifyRoot, name) => {
        const lab = join(verifyRoot, name);
        mkdirSync(lab, { recursive: true });
        return lab;
      },
      run,
    });
    b.prepare();
    mkdirSync(b.dir, { recursive: true });
    return b;
  };

  it("refuses a wait longer than a round, such as 1e308 minutes", () => {
    expect(cleanArgs(["target", "9", "--timeout", "1e308"])).toBeNull();
    expect(cleanArgs(["target", "9", "--timeout", "31"])).toBeNull();
    expect(cleanArgs(["target", "9", "--timeout", "9"])).not.toBeNull();
  });

  it("a request folder that is a file, or a failing run, never throws or rejects", async () => {
    const dir = root();
    writeFileSync(join(dir, "not-a-folder"), "x");
    expect(serveReviewRequests(join(dir, "not-a-folder"), async () => ({ exitCode: 0, output: "" }))).toEqual([]);
    mkdirSync(join(dir, "r"));
    writeFileSync(join(dir, "r", "a.request.json"), JSON.stringify({ argv: ["target", "9"] }));
    mkdirSync(join(dir, "r", "a.answer.json"));
    await expect(
      Promise.all(
        serveReviewRequests(join(dir, "r"), async () => {
          throw new Error("boom");
        }),
      ),
    ).resolves.toBeDefined();
  });

  it("a zero exit with no saved review is no success: the round would have no evidence", async () => {
    const dir = root();
    const b = broker(dir, async () => ({ exitCode: 0, output: "complete\n" }));
    writeFileSync(join(b.dir, "x.request.json"), JSON.stringify({ argv: ["target", "9"] }));
    await Promise.all(b.serve());
    const answer = JSON.parse(readFileSync(join(b.dir, "x.answer.json"), "utf8"));
    expect(answer.exitCode).toBe(2);
    expect(answer.output).toMatch(/no evidence/);
  });

  it("puts the run's earlier saves in front of review:wait, so its write-once rules see them", async () => {
    const dir = root();
    const kept = join(dir, "kept", "reviews", "target-pr9");
    mkdirSync(kept, { recursive: true });
    writeFileSync(join(kept, "abc1234.review.json"), '{"state":"complete"}');
    let seen = "";
    const b = broker(dir, async (_argv, cwd) => {
      seen = readFileSync(
        join(cwd, "private", "raw-artifacts", "reviews", "target-pr9", "abc1234.review.json"),
        "utf8",
      );
      return { exitCode: 0, output: "" };
    });
    writeFileSync(join(b.dir, "y.request.json"), JSON.stringify({ argv: ["target", "9"] }));
    await Promise.all(b.serve());
    expect(seen).toBe('{"state":"complete"}');
  });
});

describe("the review broker: one request at a time, small requests, no links (Qodo on PR 270, round 2)", () => {
  const make = (run: (argv: string[], cwd: string) => Promise<{ exitCode: number; output: string }>) => {
    const dir = mkdtempSync(join(tmpdir(), "ff-broker3-"));
    const b = reviewBroker({
      dir: join(dir, "requests"),
      trustedRoot: join(dir, "trusted"),
      labDirName: "lab",
      remoteUrl: "https://github.com/owner/lab.git",
      evidence: "private/raw-artifacts",
      evidenceRoot: join(dir, "kept"),
      build: (verifyRoot, name) => {
        const lab = join(verifyRoot, name);
        mkdirSync(lab, { recursive: true });
        return lab;
      },
      run,
    });
    expect(b.prepare()).toBeNull();
    mkdirSync(b.dir, { recursive: true });
    return { dir, b };
  };

  it("starts one review:wait at a time, however many requests the agent writes", async () => {
    let running = 0;
    let most = 0;
    const { b } = make(async () => {
      running++;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return { exitCode: 1, output: "" };
    });
    for (let i = 0; i < 20; i++)
      writeFileSync(join(b.dir, `r${i}.request.json`), JSON.stringify({ argv: ["target", "9"] }));
    for (let round = 0; round < 25; round++) {
      await Promise.all([...b.serve(), ...b.serve()]);
    }
    expect(most).toBe(1);
  });

  it("refuses a request file bigger than a command line, unread", async () => {
    const { b } = make(async () => ({ exitCode: 0, output: "" }));
    writeFileSync(
      join(b.dir, "big.request.json"),
      JSON.stringify({ argv: ["target", "9", "x".repeat(MAX_REQUEST_BYTES)] }),
    );
    await Promise.all(b.serve());
    expect(JSON.parse(readFileSync(join(b.dir, "big.answer.json"), "utf8")).exitCode).toBe(2);
  });

  it("never carries a symbolic link from the agent's saves into the trusted checkout", async () => {
    const { dir, b } = make(async (_argv, cwd) => {
      const saved = join(cwd, "private", "raw-artifacts", "reviews", "target-pr9");
      mkdirSync(saved, { recursive: true });
      writeFileSync(join(saved, "abc1234.review.json"), "{}");
      return { exitCode: 0, output: "" };
    });
    const kept = join(dir, "kept", "reviews", "target-pr9");
    mkdirSync(kept, { recursive: true });
    writeFileSync(join(dir, "outside.txt"), "runner file");
    try {
      symlinkSync(join(dir, "outside.txt"), join(kept, "abc1234.head-wait.json"));
    } catch {
      return; // no symlinks without the privilege on this machine
    }
    writeFileSync(join(b.dir, "s.request.json"), JSON.stringify({ argv: ["target", "9"] }));
    await Promise.all(b.serve());
    const trustedSaves = join(dir, "trusted", "lab", "private", "raw-artifacts", "reviews", "target-pr9");
    expect(existsSync(join(trustedSaves, "abc1234.head-wait.json"))).toBe(false);
    expect(readFileSync(join(dir, "outside.txt"), "utf8")).toBe("runner file");
  });
});
