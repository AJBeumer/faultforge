/**
 * Waits until Qodo has really finished reviewing a PR's head commit, then saves everything.
 *
 *   npm run review:wait -- faultforge 55
 *   npm run review:wait -- target 9 --timeout 30
 *   npm run review:wait -- target 9 --commit $(git rev-parse HEAD)
 *
 * A Qodo comment is not a finished review: on Day 3 it twice said "no open findings" and was edited
 * minutes later to add findings. Only Qodo's API saying the run for the head commit is `completed`
 * counts. Read-only towards GitHub and Qodo throughout.
 *
 * The save (`<evidence>/reviews/<repo>-pr<N>/<sha7>.review.json`, from `saved-review.ts`) is never written
 * over: a verdict's hash covers it. When a complete save of the commit exists, nothing is waited for or
 * written. An unfinished one (timed out, skipped, head moved) may be waited for again: it and every other
 * `<sha7>.*` file are first moved into `<sha7>.unfinished-<n>/`, so none of its evidence is written over.
 *
 * Exit codes: 0 Qodo's review of the head (with `--commit`, of that commit) is complete and saved; 1 there
 * is no complete review of it within the time limit, whether Qodo didn't finish or, with `--commit`, the head
 * never became that commit or moved past it (what was seen is saved); 2 it couldn't run: usage, a missing
 * key, every poll failed or answered something that isn't a review, a complete review in a shape this can't
 * read, or a complete save of this commit that already exists; 3 Qodo finished the run but skipped reviewing it.
 *
 * After a push, pass `--commit`: right after a push GitHub can still show the previous head, and
 * without it the previous commit's finished review would be reported as the answer (PR 65, 9 Nov).
 */
import { runEntry } from "./cli-entry.ts";

// In an unattended run the agent has no Qodo key: the runner runs this for it and hands back its output and
// exit code, which keep the meanings above (factory-review-broker.ts, #243). Loaded the same way as the body,
// so an error while loading it is exit 2 too.
const broker = process.env.FAULTFORGE_REVIEW_BROKER;
const viaBroker = async (argv: string[]) => {
  const { askRunner } = await import("./factory-review-broker.ts");
  const answer = await askRunner(broker as string, argv);
  // Exit once the output is written: a pipe would otherwise lose the end of the findings (Qodo on PR 270).
  await new Promise<void>((written) => process.stdout.write(answer.output, () => written()));
  return answer.exitCode;
};

// The body is loaded here with a dynamic import, so an error even while it loads is exit 2 (cli-entry.ts).
try {
  process.exit(
    await runEntry(
      "review:wait",
      async () => (broker ? viaBroker : (await import("./review-wait-run.ts")).main),
      process.argv.slice(2),
    ),
  );
} catch {
  process.exit(2);
}
