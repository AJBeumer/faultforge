/**
 * The pending-content check of the Claude Code guard: before any `git commit` or `git push`, wherever it
 * runs, what every reviewed checkout would send is read from git (guard-content.ts). Split out of
 * guard-target.ts to keep it under the size limit.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pendingCommit, pendingPush, Uninspectable } from "./guard-content.ts";
import type { Reviewed } from "./guard-repos.ts";
import { gitSteps, joinedWords } from "./shell-scan.ts";

/**
 * Why a `git commit` or `git push` in the command must be refused, or undefined: a reviewed checkout holds
 * pending content that names the lab or the bug. This is the check that doesn't depend on reading the
 * command right. A reviewed checkout the guard can't find is skipped unless the command is aimed at it
 * (`touched`); one git can't read is refused. A second clone the command touches is read as well.
 */
export function pendingProblem(reviewed: Reviewed[], command: string, touched: Reviewed[]): string | undefined {
  const words = joinedWords(command);
  const commits = gitSteps(words, /\bcommit\b/).length > 0;
  const pushes = gitSteps(words, /\bpush\b/).length > 0;
  const forceIgnored = gitSteps(words, /\badd\b/).some((step) =>
    /\s(-\w*f\w*|--force)\b/.test(step.text.slice(step.text.search(/\badd\b/))),
  );
  const checkouts = [...reviewed, ...touched].filter(
    (repo, i, all) => all.findIndex((r) => resolve(r.checkout) === resolve(repo.checkout)) === i,
  );
  for (const moment of [commits && "commit", pushes && "push"] as const) {
    if (!moment) continue;
    for (const repo of checkouts) {
      if (!existsSync(resolve(repo.checkout, ".git"))) {
        // Only a checkout the command itself aims at must exist: a second clone stands on its own (Qodo on PR 265).
        if (touched.some((r) => resolve(r.checkout) === resolve(repo.checkout))) {
          return `The guard can't find ${repo.name}'s checkout at ${repo.checkout} (from factory.json), so it can't check what this ${moment} would carry. Fix the path before committing or pushing there.`;
        }
        continue;
      }
      try {
        const pending = moment === "commit" ? pendingCommit(repo.checkout, forceIgnored) : pendingPush(repo.checkout);
        if (pending.reasons.length) {
          return `${repo.name} holds content that would give the lab away in ${pending.where} (${pending.reasons.join(", ")}). Remove it from the checkout before any commit or push.`;
        }
      } catch (error) {
        if (!(error instanceof Uninspectable)) throw error;
        return `The guard can't inspect ${repo.name}'s pending content (${error.message}), so nothing may be committed or pushed until it can.`;
      }
    }
  }
  return undefined;
}
