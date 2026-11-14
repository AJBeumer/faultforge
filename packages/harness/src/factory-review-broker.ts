/**
 * `review:wait` for the agent, run by the runner, so Qodo's key stays with the runner (AUD-H2, #243).
 *
 * The agent's environment has no Qodo key. In a run, `FAULTFORGE_REVIEW_BROKER` names a folder in the run's
 * own folder; `npm run review:wait` there doesn't call Qodo itself (`askRunner`). It writes its command line
 * as a request file and waits for the answer. The runner, which holds the key, watches that folder while the
 * agent runs (`serveReviewRequests`): it checks the command line with `review:wait`'s own parser, runs the
 * real `review:wait` from a trusted checkout of `main` (never from the agent's worktree, whose scripts the
 * agent can change: #161), copies the evidence it saved to where the agent's own run keeps it, and writes back
 * its output and exit code. A request is only ever the four things `review:wait` takes: a repo key, a PR
 * number, a commit and a time limit. Nothing the agent writes is run as a command.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "./review-wait.ts";
import { buildTrustedCheckout, removeTrustedCheckout } from "./trusted-checkout.ts";

/** The environment variable that turns `review:wait` into a request to the runner. */
export const BROKER_ENV = "FAULTFORGE_REVIEW_BROKER";

export interface ReviewAnswer {
  exitCode: number;
  output: string;
}

/** The longest output passed back: the findings list, never megabytes. */
const MAX_OUTPUT = 200_000;

/** Writes `value` to `file` whole: a reader never sees half of it. */
function writeWhole(file: string, value: unknown) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, file);
}

/**
 * The agent's side: asks the runner to run `review:wait` with `argv`, waits for its answer, and returns it.
 * Gives up, as "couldn't run" (exit 2), when no answer comes within the review's own time limit and five
 * minutes more.
 */
export async function askRunner(
  dir: string,
  argv: string[],
  options: { pollMs?: number; graceMs?: number; now?: () => number } = {},
): Promise<ReviewAnswer> {
  const { pollMs = 2000, graceMs = 5 * 60_000, now = Date.now } = options;
  const args = parseArgs(argv);
  if (!args) return { exitCode: 2, output: "review:wait: the command line is wrong; see npm run review:wait's usage." };
  const id = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}`;
  mkdirSync(dir, { recursive: true });
  writeWhole(join(dir, `${id}.request.json`), { argv });
  const answer = join(dir, `${id}.answer.json`);
  const deadline = now() + args.timeoutMinutes * 60_000 + graceMs;
  while (now() < deadline) {
    if (existsSync(answer)) {
      const value = JSON.parse(readFileSync(answer, "utf8")) as ReviewAnswer;
      rmSync(answer, { force: true });
      return value;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return { exitCode: 2, output: "review:wait: the runner didn't answer in time, so the review couldn't be read." };
}

/** The longest wait a request may ask for, in minutes: a round's own wait, never an endless poll (Qodo on PR 270). */
export const MAX_REQUEST_MINUTES = 30;

/**
 * The command line the runner will run for a request: rebuilt from what `review:wait`'s parser read, never
 * the request's own words, so an extra argument or a shell character in it never reaches a shell. Null when
 * the request isn't a command line `review:wait` accepts, its repo key isn't a plain word, or it asks to wait
 * longer than `MAX_REQUEST_MINUTES`.
 */
export function cleanArgs(argv: unknown): string[] | null {
  if (!Array.isArray(argv) || !argv.every((a) => typeof a === "string")) return null;
  const args = parseArgs(argv as string[]);
  if (!args || !/^[\w-]+$/.test(args.repoKey) || args.timeoutMinutes > MAX_REQUEST_MINUTES) return null;
  return [
    args.repoKey,
    String(args.pr),
    "--timeout",
    String(args.timeoutMinutes),
    ...(args.commit ? ["--commit", args.commit] : []),
  ];
}

/** Runs the real `review:wait` with `argv` in `cwd`, with the runner's environment, and returns its answer. */
export type RunReviewWait = (argv: string[], cwd: string) => Promise<ReviewAnswer>;

/** Answers one checked request: `argv` is always what `cleanArgs` rebuilt. */
export type AnswerRequest = (argv: string[]) => Promise<ReviewAnswer>;

/** The children `runReviewWait` started that are still running, so the runner can end them with the run. */
const running = new Set<ChildProcess>();

/** Ends every `review:wait` the runner started for the agent: they hold Qodo's key and outlive nothing. */
export function stopReviewWaits(): void {
  for (const child of running) child.kill();
  running.clear();
}

/**
 * The real runner-side `review:wait`, through npm (a shell on Windows, where npm is a .cmd file), ended after
 * its own `--timeout` and five minutes more if it hasn't stopped by itself.
 */
export const runReviewWait: RunReviewWait = (argv, cwd) =>
  new Promise((done) => {
    // Only arguments `cleanArgs` rebuilt reach here: a repo key, a number, a hex commit, a number.
    const args = ["run", "-s", "review:wait", "--", ...argv];
    const env = { ...process.env };
    delete env[BROKER_ENV];
    const minutes = Number(argv[argv.indexOf("--timeout") + 1]) || MAX_REQUEST_MINUTES;
    const child =
      process.platform === "win32"
        ? spawn(["npm", ...args].join(" "), { cwd, env, shell: true })
        : spawn("npm", args, { cwd, env });
    running.add(child);
    const limit = setTimeout(() => child.kill(), (minutes + 5) * 60_000);
    let output = "";
    const add = (chunk: Buffer) => {
      if (output.length < MAX_OUTPUT) output += chunk.toString("utf8");
    };
    child.stdout?.on("data", add);
    child.stderr?.on("data", add);
    const end = (answer: ReviewAnswer) => {
      clearTimeout(limit);
      running.delete(child);
      done(answer);
    };
    child.on("error", (error) => end({ exitCode: 2, output: `review:wait could not start: ${error.message}` }));
    child.on("close", (code) => end({ exitCode: code ?? 2, output: output.slice(0, MAX_OUTPUT) }));
  });

/**
 * The runner's side: takes every new request in `dir`, answers it with `run`, and writes the answer next to
 * it. A request is claimed by renaming it first, so it is never run twice. A command line `review:wait`
 * wouldn't accept is answered with exit 2 and never run. Nothing the agent puts in the folder can throw out
 * of here or reject: a run never stops because of its own request folder (Qodo on PR 270).
 */
export function serveReviewRequests(dir: string, run: AnswerRequest): Promise<void>[] {
  const started: Promise<void>[] = [];
  const reply = (answer: string, taken: string, value: ReviewAnswer) => {
    try {
      writeWhole(answer, value);
    } catch {
      // The agent made the answer path unwritable; its own review:wait gives up with exit 2 in time.
    }
    rmSync(taken, { force: true });
  };
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".request.json"));
  } catch {
    return [];
  }
  for (const name of names) {
    const id = name.slice(0, -".request.json".length);
    const taken = join(dir, `${id}.taken.json`);
    try {
      renameSync(join(dir, name), taken);
    } catch {
      continue;
    }
    const answer = join(dir, `${id}.answer.json`);
    let argv: unknown;
    try {
      argv = JSON.parse(readFileSync(taken, "utf8")).argv;
    } catch {
      argv = null;
    }
    const clean = cleanArgs(argv);
    if (!clean) {
      reply(answer, taken, {
        exitCode: 2,
        output: "review:wait: the request's command line is wrong, so it wasn't run.",
      });
      continue;
    }
    started.push(
      run(clean)
        .catch(
          (error: unknown): ReviewAnswer => ({
            exitCode: 2,
            output: `review:wait couldn't run: ${error instanceof Error ? error.message : error}`,
          }),
        )
        .then((result) => reply(answer, taken, result)),
    );
  }
  return started;
}

/**
 * The runner's broker for one run: requests in `dir` are answered by `review:wait` run from a trusted
 * checkout of the harness's `main`, built by `prepare` before the agent starts (building it later would stop
 * the runner's event loop for minutes mid-run: Qodo on PR 270). The run's saved reviews of that PR are copied
 * into the checkout first, so `review:wait`'s own write-once and archive rules see them, and its saves are
 * copied back after. A zero exit with no saved review to copy back is not a success: the run would lack its
 * evidence. `close` ends any wait still running and removes the checkout.
 */
export function reviewBroker(options: {
  dir: string;
  trustedRoot: string;
  labDirName: string;
  remoteUrl: string;
  /** `factory.json`'s evidence folder, relative to a checkout of the harness. */
  evidence: string;
  /** Where the agent's run keeps its evidence (its own checkout's evidence folder). */
  evidenceRoot: string;
  build?: typeof buildTrustedCheckout;
  run?: RunReviewWait;
}) {
  const { dir, trustedRoot, labDirName, remoteUrl, evidence, evidenceRoot } = options;
  const { build = buildTrustedCheckout, run = runReviewWait } = options;
  let trusted: string | null = null;
  let buildError = "";
  const prepare = () => {
    try {
      trusted = build(trustedRoot, labDirName, remoteUrl);
    } catch (error) {
      buildError = (error as Error).message;
    }
  };
  const answer: AnswerRequest = async (argv) => {
    if (!trusted) return { exitCode: 2, output: `review:wait couldn't run: ${buildError || "no trusted checkout"}` };
    const sub = `${argv[0]}-pr${argv[1]}`;
    const kept = join(evidenceRoot, "reviews", sub);
    const saves = join(trusted, evidence, "reviews", sub);
    try {
      if (existsSync(kept)) cpSync(kept, saves, { recursive: true });
    } catch (error) {
      return { exitCode: 2, output: `review:wait couldn't see the run's earlier saves: ${(error as Error).message}` };
    }
    const result = await run(argv, trusted);
    try {
      if (!existsSync(saves)) throw new Error("review:wait saved nothing");
      cpSync(saves, kept, { recursive: true });
    } catch (error) {
      if (result.exitCode !== 0) return result;
      return {
        exitCode: 2,
        output: `${result.output}\nThe runner couldn't keep the saved review, so this round has no evidence: ${(error as Error).message}`,
      };
    }
    return result;
  };
  return {
    dir,
    prepare,
    serve: () => serveReviewRequests(dir, answer),
    close: () => {
      stopReviewWaits();
      removeTrustedCheckout(trustedRoot);
    },
  };
}
