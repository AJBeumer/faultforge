/**
 * Does a pull request meet the factory's quality gate? Reads the gate from `factory.json` and the review
 * `review:wait` saved for the pull request's head, and prints an account of every finding: must fix, unknown
 * label, flagged for the owner, or closed since an earlier saved review of the same pull request.
 *
 *   npm run gate:check -- faultforge 380
 *   npm run gate:check -- faultforge 380 --commit <sha>   a commit already known, without asking GitHub
 *
 * It looks where `review:wait` saves: this checkout's own evidence folder, whatever `FAULTFORGE_PRIVATE_DIR`
 * says. It reads only. It never starts a review: run `review:wait` first, so the answer is about a review that
 * was saved as evidence. A review of an older commit, or one that didn't finish, never meets the gate.
 *
 * Exit codes: 0 the gate is met; 1 it isn't, with the reasons; 2 it could not be decided (a bad argument,
 * no saved review of the head, GitHub unreachable), or an unexpected error stopped it, even while loading
 * (`npm run gate:check` runs `gate-check-cli.ts`).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gateOf, loadFactory, repoConfig } from "../shared/factory-config.ts";
import { ghJson } from "../shared/github.ts";
import { closedFindings, type GateRecord, gateAccount, gateReport } from "../shared/quality-gate.ts";
import { savedReviewPath, waitSaveDir } from "./saved-review.ts";

export interface GateCheckDeps {
  /** The pull request's head commit on GitHub. */
  head: (github: string, pr: number) => string;
  /** The saved review's text, or undefined when there is none. */
  read: (path: string) => string | undefined;
  /** The text of every saved review (`*.review.json`) in a pull request's folder. */
  readAll: (dir: string) => string[];
  out: (line: string) => void;
  error: (line: string) => void;
}

const realDeps: GateCheckDeps = {
  head: (github, pr) =>
    ghJson<{ headRefOid: string }>("pr", "view", String(pr), "--repo", github, "--json", "headRefOid").headRefOid,
  read: (path) => (existsSync(path) ? readFileSync(path, "utf8") : undefined),
  readAll: (dir) =>
    readdirSync(dir)
      .filter((f) => f.endsWith(".review.json"))
      .map((f) => readFileSync(join(dir, f), "utf8")),
  out: (line) => console.log(line),
  error: (line) => console.error(line),
};

/** The command's body, with its outside world handed in so a test can run it whole. */
export function run(argv: string[], deps: GateCheckDeps = realDeps): number {
  const factory = loadFactory();
  const [repoKey, prText, flag, commit] = argv;
  const pr = Number(prText);
  const usage = `usage: npm run gate:check -- <${Object.keys(factory.repos).join("|")}> <pull request number> [--commit <sha>]`;
  if (!repoKey || !factory.repos[repoKey] || !Number.isInteger(pr) || pr <= 0 || argv.length > 4) {
    deps.error(usage);
    return 2;
  }
  if (flag !== undefined && (flag !== "--commit" || !/^[0-9a-f]{40}$/i.test(commit ?? ""))) {
    deps.error(`${usage}\n--commit takes a full 40-character commit id`);
    return 2;
  }
  const { github } = repoConfig(factory, repoKey);
  let head: string;
  try {
    head = commit ?? deps.head(github, pr);
  } catch (e) {
    deps.error(`gate:check: couldn't read the pull request's head: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  if (!/^[0-9a-f]{40}$/i.test(head)) {
    deps.error("gate:check: GitHub gave no commit id for the pull request's head");
    return 2;
  }
  const path = savedReviewPath(waitSaveDir(repoKey, pr), head);
  const text = deps.read(path);
  if (text === undefined) {
    deps.error(
      `gate:check: no saved review of ${head.slice(0, 7)} at ${path}. Run: npm run review:wait -- ${repoKey} ${pr} --commit ${head}`,
    );
    return 2;
  }
  let record: GateRecord;
  try {
    record = JSON.parse(text) as GateRecord;
  } catch {
    deps.error(`gate:check: the saved review at ${path} can't be read as JSON`);
    return 2;
  }
  const gate = gateOf(factory);
  // A save made before rounds were recorded can still be judged; one that records them is held to the limit.
  const account = gateAccount(record, gate, { head, requireComplete: true, rounds: "if-recorded" });
  // Closed findings come from the other saves of this pull request. One that can't be read is passed over:
  // it can only shorten the closed list, never change the verdict.
  const earlier: unknown[] = [];
  for (const other of deps.readAll(dirname(path))) {
    try {
      earlier.push(JSON.parse(other));
    } catch {
      // Not a readable save.
    }
  }
  deps.out(`${repoKey} pull request ${pr}, review of ${head.slice(0, 7)} (${path})`);
  for (const line of gateReport(account, gate, closedFindings(record, earlier))) deps.out(line);
  return account.met ? 0 : 1;
}

/** The command: `gate-check-cli.ts` runs it, so an unexpected error, even while loading, is exit 2. */
export function main(argv: string[]): number {
  return run(argv);
}
