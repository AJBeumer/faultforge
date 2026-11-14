import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { askRunner, cleanArgs, reviewBroker, serveReviewRequests } from "./factory-review-broker.ts";

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
