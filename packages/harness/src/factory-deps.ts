/**
 * The tick's real side effects: GitHub, git, npm, the agent and the file system, behind `TickDeps`. Split
 * from factory-tick.ts (#227).
 */
import { appendFileSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { runAgent } from "./factory-agent.ts";
import { auditRun } from "./factory-audit.ts";
import { runnerComment } from "./factory-comments.ts";
import type { FactoryConfig } from "./factory-config.ts";
import { commitAndPublish, type EvidencePush, evidenceFile } from "./factory-evidence.ts";
import { git, gitLong, npm, retried } from "./factory-exec.ts";
import { type HooksReport, requireHooks, withCleanupFailure } from "./factory-hooks.ts";
import { acquireLock, type Lock } from "./factory-lock.ts";
import { processStartId } from "./factory-process.ts";
import { claimModeFrom, pidAlive } from "./factory-recovery.ts";
import { relabelWith } from "./factory-relabel.ts";
import { earlierPrs, type OpenPr } from "./factory-settle.ts";
import type { IssueEvent, TickDeps, TickOptions } from "./factory-tick.ts";
import { verifyPrWith } from "./factory-verify.ts";
import { fingerprints, PRIVATE_KEY, type RunMode, teardown, worktreeFor } from "./factory-workspace.ts";
import { gh, ghAll, ghJson } from "./github.ts";
import { unguardedCheckouts } from "./guard-install.ts";
import { evidenceDir, ROOT as LAB_ROOT, runsDir } from "./paths.ts";
import { checkLiveQodoConfig } from "./qodo-check.ts";
import { checkTicket } from "./ticket-ready.ts";
import { ghSnapshot } from "./ticket-snapshot.ts";

export function realDeps(factory: FactoryConfig, options: TickOptions, mode: RunMode = "local"): TickDeps {
  const runs = runsDir();
  mkdirSync(runs, { recursive: true });
  // Literal, not `privateDir()`: this is the physical "private" worktree this very checkout always
  // has (the same fixed name `workspace()` below gives it), the one the push and the main-moved check
  // below act on. Honouring `FAULTFORGE_PRIVATE_DIR` here would push and audit a different folder than
  // the one actually checked out, so the evidence would silently escape it (Qodo on PR 154).
  const privateRepo = join(LAB_ROOT, "private");
  const evidenceInPrivate = relative(privateRepo, evidenceDir(factory)).replace(/\\/g, "/"); // as git spells paths (N-12)

  // The lock this tick holds, so the agent's pid can be written into it once the agent starts.
  let held: Lock | undefined;
  const deps: TickDeps = {
    now: () => new Date(),
    mode,
    // A local run works next to the owner's reviewed checkouts: git's own guard must be in each (#242).
    unguarded: () => unguardedCheckouts(factory, LAB_ROOT),
    // GitHub reads get three tries: one transient failure must not cost the tick (AUD-N10).
    claimMode: (github, number) =>
      claimModeFrom(
        retried(() =>
          ghAll<{ body?: string; user?: { login?: string } }>(`repos/${github}/issues/${number}/comments?per_page=100`),
        ),
        github.split("/")[0] ?? "",
      ),
    // Every open PR, however many: gh pages through them up to the limit (Qodo on PR 268).
    openPrs: (github, number) =>
      earlierPrs(
        retried(() =>
          ghJson<OpenPr[]>(
            "pr",
            "list",
            "--repo",
            github,
            "--state",
            "open",
            "--limit",
            "5000",
            "--json",
            "url,body,author,isCrossRepository",
          ),
        ),
        number,
        github.split("/")[0] ?? "",
      ),
    print: (line) => console.log(line),
    // A live holder keeps it however long it runs; a restart frees it (AUD-M19).
    lock: () => {
      held = acquireLock(runs, pidAlive);
      return held;
    },
    labelled: (github, label) =>
      retried(() =>
        ghAll<{ number: number; title: string; pull_request?: unknown }>(
          `repos/${github}/issues?state=open&per_page=100&labels=${encodeURIComponent(label)}`,
        ),
      ).filter((i) => !i.pull_request),
    events: (github, number) =>
      retried(() => ghAll<IssueEvent>(`repos/${github}/issues/${number}/events?per_page=100`)),
    ready: (repoKey, number) => checkTicket(factory, repoKey, number),
    snapshot: (github, number) => retried(() => ghSnapshot(github, number)),
    writeTicket(ws, text) {
      const file = join(ws.root, "ticket.md");
      writeFileSync(file, `${text}\n`);
      return file;
    },
    relabel: (github, number, remove, add) =>
      relabelWith(
        remove,
        add,
        (label) => gh("api", "-X", "DELETE", `repos/${github}/issues/${number}/labels/${encodeURIComponent(label)}`),
        (labels) => gh("issue", "edit", String(number), "--repo", github, ...labels.flatMap((l) => ["--add-label", l])),
      ),
    // Every comment the runner posts starts with its mark: it posts as the owner, and the mark is how a later
    // run's snapshot tells it from the owner's own text (AUD-M21).
    comment: (github, number, body) => {
      gh("issue", "comment", String(number), "--repo", github, "--body", runnerComment(body));
    },
    async qodoCheck(runId) {
      // Its own short-lived worktree, so the live answers reach the private repo's `main` even when
      // the check stops the run before the ticket's own workspace (and `ws.private`) ever exist, and
      // even on a clean run: `checkLiveQodoConfig` otherwise writes into this checkout's own `private/`,
      // which nothing else ever commits or pushes (Qodo on PR 145).
      const label = `qodo-check-${runId}`;
      const priv = join(runs, label, "private");
      try {
        mkdirSync(dirname(priv), { recursive: true });
        gitLong(privateRepo, "fetch", "--quiet", "origin", "main");
        gitLong(privateRepo, "worktree", "add", "-b", label, priv, "origin/main");
      } catch (error) {
        return {
          exitCode: 2 as const,
          message: `could not prepare a worktree to save Qodo's state: ${(error as Error).message}`,
          differences: [],
        };
      }
      const result = await checkLiveQodoConfig(factory, {
        snapshotDir: join(priv, "config"),
        evidenceRoot: join(priv, evidenceInPrivate),
      });
      let published: EvidencePush | null = null;
      try {
        published = commitAndPublish(priv, evidenceInPrivate, label, git, gitLong);
      } catch {
        // published stays null: the push itself failed (not merely a blocked path - our evidence is
        // always under an allowed root). Nothing is torn down below, so the worktree is the evidence's
        // only remaining copy, the same way `saveEvidence` keeps the run folder when its own push fails.
      }
      // Torn down only once the evidence actually reached the remote (`main`, or its own branch if a
      // blocked path forced that); otherwise the worktree is left for the owner to recover by hand
      // (Qodo on PR 145, round 2).
      if (published?.pushed || published?.savedAt) {
        git(privateRepo, "worktree", "remove", "--force", priv);
        git(privateRepo, "branch", "-D", label);
        rmSync(join(runs, label), { recursive: true, force: true });
      }
      return { exitCode: result.exitCode, message: result.message, differences: result.differences };
    },
    workspace(runId) {
      const root = join(runs, runId);
      const lab = join(root, basename(LAB_ROOT));
      const priv = join(lab, "private");
      const mainAtStart: Record<string, string> = {};
      let hooks: HooksReport | undefined;
      mkdirSync(root, { recursive: true });
      try {
        for (const [key, repo] of Object.entries(factory.repos)) {
          const source = resolve(LAB_ROOT, repo.path);
          const target = repo.path === "." ? lab : worktreeFor(lab, repo.path);
          gitLong(source, "fetch", "--quiet", "origin", "main");
          mainAtStart[key] = git(source, "rev-parse", "origin/main");
          mkdirSync(dirname(target), { recursive: true });
          gitLong(source, "worktree", "add", "--detach", target, "origin/main");
        }
        gitLong(privateRepo, "fetch", "--quiet", "origin", "main");
        mainAtStart[PRIVATE_KEY] = git(privateRepo, "rev-parse", "origin/main");
        gitLong(privateRepo, "worktree", "add", "-b", `run-${runId}`, priv, "origin/main");
        for (const repo of Object.values(factory.repos)) {
          const dir = repo.path === "." ? lab : worktreeFor(lab, repo.path);
          if (!existsSync(join(dir, "package.json"))) continue;
          const install = npm(dir, ["ci", "--no-audit", "--no-fund"]);
          if (install.status !== 0) throw new Error(`npm ci failed in ${dir}: ${install.output.slice(-400)}`);
        }
        // The agent gets main's hooks, not the runner's: refuse to start it without both of them.
        hooks = requireHooks(factory, lab);
      } catch (error) {
        // Undo whatever was set up, so a failed start leaves no worktree or branch behind.
        const leftovers = teardown(factory, privateRepo, root, lab, priv, runId);
        throw withCleanupFailure(error, leftovers);
      }
      return {
        root,
        lab,
        private: priv,
        mainAtStart,
        fingerprints: fingerprints(factory, privateRepo, mode, lab),
        hooks,
      };
    },
    audit: (ws, ticket, from, to) => auditRun(factory, privateRepo, mode, ws, ticket, from, to),
    runAgent: (ws, runId, repoKey, number, ticketFile, log) =>
      runAgent(factory, options, runs, ws, runId, repoKey, number, ticketFile, log, (pid) =>
        held?.recordAgent(pid, pid ? (processStartId(pid) ?? undefined) : undefined),
      ),
    verifyPr(ws, repoKey, pr) {
      return verifyPrWith(
        { ghJson, git, npm },
        factory,
        runs,
        (github) => `https://github.com/${github}.git`,
        ws,
        repoKey,
        pr,
      );
    },
    record(runId, event) {
      appendFileSync(join(runs, `${runId}.jsonl`), `${JSON.stringify(event)}\n`);
    },
    saveEvidence(runId, ws) {
      let priv = ws?.private;
      let temporary = false;
      if (!priv) {
        priv = join(runs, runId, "private");
        mkdirSync(dirname(priv), { recursive: true });
        gitLong(privateRepo, "fetch", "--quiet", "origin", "main");
        gitLong(privateRepo, "worktree", "add", "-b", `run-${runId}`, priv, "origin/main");
        temporary = true;
      }
      // A private worktree that is gone (a half-done cleanup) must never be written to: `git -C` would then
      // find the enclosing repository, the harness, and commit and push there (Qodo on PR 262).
      if (!existsSync(join(priv, ".git")))
        throw new Error("the run's private worktree is gone, so its evidence can't be saved through it");
      const dir = join(priv, evidenceInPrivate, "factory-runs");
      mkdirSync(dir, { recursive: true });
      for (const suffix of [".jsonl", ".agent.jsonl"]) {
        const file = join(runs, `${runId}${suffix}`);
        if (existsSync(file)) copyFileSync(file, join(dir, `${runId}${suffix}`));
      }
      const result = commitAndPublish(priv, evidenceInPrivate, runId, git, gitLong);
      // Torn down once the evidence reached origin, whether that's main or a blocked run's own branch;
      // only when even that push failed is the worktree the owner's sole remaining copy (Qodo on PR 141).
      if ((result.pushed || result.savedAt) && temporary) {
        git(privateRepo, "worktree", "remove", "--force", priv);
        git(privateRepo, "branch", "-D", `run-${runId}`);
        rmSync(join(runs, runId), { recursive: true, force: true });
      }
      return { file: evidenceFile(factory, runId), ...result };
    },
    cleanup(ws) {
      const leftovers = teardown(factory, privateRepo, ws.root, ws.lab, ws.private, basename(ws.root));
      if (leftovers.length) throw new Error(`cleanup failed: ${leftovers.join("; ")}`);
    },
  };
  if (mode === "local") return deps;

  return {
    ...deps,
    // The VM's target checkout gets the guard from the workflow's own step (factory.yml), not from here.
    unguarded: () => [],
    // The workflow's concurrency group allows one run at a time.
    lock: () => ({ acquired: true, release: () => {} }),
    workspace() {
      const mainAtStart: Record<string, string> = {};
      for (const [key, repo] of Object.entries(factory.repos)) {
        const dir = resolve(LAB_ROOT, repo.path);
        gitLong(dir, "fetch", "--quiet", "origin", "main");
        const head = git(dir, "rev-parse", "HEAD");
        const main = git(dir, "rev-parse", "origin/main");
        if (head !== main)
          throw new Error(`the ${key} checkout is at ${head.slice(0, 7)}, not origin/main ${main.slice(0, 7)}`);
        if (!existsSync(join(dir, "node_modules")) && existsSync(join(dir, "package.json")))
          throw new Error(`the ${key} checkout has no node_modules: the workflow must run npm ci first`);
        mainAtStart[key] = main;
      }
      gitLong(privateRepo, "fetch", "--quiet", "origin", "main");
      mainAtStart[PRIVATE_KEY] = git(privateRepo, "rev-parse", "origin/main");
      const hooks = requireHooks(factory, LAB_ROOT);
      return {
        root: dirname(LAB_ROOT),
        lab: LAB_ROOT,
        private: privateRepo,
        mainAtStart,
        fingerprints: fingerprints(factory, privateRepo, mode, LAB_ROOT),
        hooks,
      };
    },
    // The VM is thrown away after the run.
    cleanup: () => {},
  };
}
