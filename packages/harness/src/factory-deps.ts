/**
 * The tick's real side effects: GitHub, git, npm, the agent and the file system, behind `TickDeps`. Split
 * from factory-tick.ts (#227).
 */
import { appendFileSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { runAgent } from "./factory-agent.ts";
import { auditRun } from "./factory-audit.ts";
import { readCheckFiles } from "./factory-check-files.ts";
import { runnerComment } from "./factory-comments.ts";
import type { FactoryConfig } from "./factory-config.ts";
import { commitAndPublish, type EvidencePush, evidenceFile } from "./factory-evidence.ts";
import { git, gitLong, npm } from "./factory-exec.ts";
import { type HooksReport, requireHooks, withCleanupFailure } from "./factory-hooks.ts";
import { acquireLock, type Lock } from "./factory-lock.ts";
import { copyEvidence, isReviewedTicket, privateAccess, privateUrl } from "./factory-private.ts";
import { processStartId } from "./factory-process.ts";
import { githubRecoveryReads, pidAlive } from "./factory-recovery.ts";
import { relabelWith } from "./factory-relabel.ts";
import { sandboxFor } from "./factory-sandbox.ts";
import { stopAgentProcesses } from "./factory-sandbox-setup.ts";
import { earlierPrs, type OpenPr } from "./factory-settle.ts";
import type { IssueEvent, TickDeps, TickOptions } from "./factory-tick.ts";
import { verifyPrWith } from "./factory-verify.ts";
import { fingerprints, PRIVATE_KEY, type RunMode, samePath, teardown, worktreeFor } from "./factory-workspace.ts";
import { gitControlProblem } from "./git-control.ts";
import { ghAll, ghJson } from "./github.ts";
import { unguardedCheckouts } from "./guard-install.ts";
import { evidenceDir, evidenceKindDir, ROOT as LAB_ROOT, privateDir, runsDir } from "./paths.ts";
import { checkLiveQodoConfig } from "./qodo-check.ts";
import { AGENT_DOOR_KINDS, doorRunHolder, markerFor } from "./target-post-run.ts";
import { checkTicket } from "./ticket-ready.ts";
import { ghSnapshot } from "./ticket-snapshot.ts";
import { ticketWriter } from "./ticket-write.ts";

export function realDeps(factory: FactoryConfig, options: TickOptions, mode: RunMode = "local"): TickDeps {
  const runs = runsDir();
  mkdirSync(runs, { recursive: true });
  // Literal, not `privateDir()`: this is the physical "private" worktree this very checkout always
  // has (the same fixed name `workspace()` below gives it), the one the push and the main-moved check
  // below act on. Honouring `FAULTFORGE_PRIVATE_DIR` here would push and audit a different folder than
  // the one actually checked out, so the evidence would silently escape it (Qodo on PR 154).
  const privateRepo = join(LAB_ROOT, "private");
  const evidenceInPrivate = relative(privateRepo, evidenceDir(factory)).replace(/\\/g, "/"); // as git spells paths (N-12)
  // In CI there is no private checkout until the runner makes one, and none while a target ticket's agent runs.
  const access = privateAccess(mode, privateRepo, runs);
  // The runner's comments and labels: a reviewed repo's ticket gets them through the door, which checks them (#345).
  // While the agent runs, the door takes only its kinds; the runner's own writes carry the run's key (#347).
  const doorRun = doorRunHolder();
  const tickets = ticketWriter(
    Object.values(factory.repos)
      .filter((repo) => repo.guard === "reviewed")
      .map((repo) => repo.github),
    { runnerKey: doorRun.key },
  );

  // The lock this tick holds, so the agent's pid can be written into it once the agent starts.
  let held: Lock | undefined;
  const deps: TickDeps = {
    now: () => new Date(),
    mode,
    // A local run works next to the owner's reviewed checkouts: git's own guard must be in each (#242), and in
    // the private checkout too, whose pre-push hook sends its history only to its recorded origin (PR 333).
    // The tick pushes through `privateRepo`, so that is the one checked. `guard:install` writes to `privateDir()`,
    // which FAULTFORGE_PRIVATE_DIR can move elsewhere: then the refusal says so, or its advice could never clear it
    // (Qodo on PR 334).
    unguarded: () => {
      const problems = unguardedCheckouts(factory, LAB_ROOT, privateRepo);
      const installs = privateDir();
      if (samePath(installs, privateRepo)) return problems;
      return problems.map((problem) =>
        problem.startsWith(privateRepo)
          ? `${problem} (guard:install writes to ${installs}, set by FAULTFORGE_PRIVATE_DIR: run it with that unset)`
          : problem,
      );
    },
    // GitHub reads get three tries in `github.ts` itself: one transient failure must not cost the tick (AUD-N10).
    // The same reads the recovery dry run makes (`factory-recover.ts`).
    claimMode: githubRecoveryReads.claimMode,
    // Every open PR, however many: gh pages through them up to the limit (Qodo on PR 268).
    openPrs: (github, number) =>
      earlierPrs(
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
        number,
        github.split("/")[0] ?? "",
      ),
    print: (line) => console.log(line),
    // A live holder keeps it however long it runs; a restart frees it (AUD-M19).
    lock: () => {
      held = acquireLock(runs, pidAlive);
      return held;
    },
    labelled: githubRecoveryReads.labelled,
    events: (github, number) => ghAll<IssueEvent>(`repos/${github}/issues/${number}/events?per_page=100`),
    ready: (repoKey, number) => checkTicket(factory, repoKey, number),
    snapshot: (github, number) => ghSnapshot(github, number),
    writeTicket(ws, text) {
      const file = join(ws.root, "ticket.md");
      writeFileSync(file, `${text}\n`);
      return file;
    },
    relabel: (github, number, remove, add) =>
      relabelWith(
        remove,
        add,
        (label) => tickets.removeLabel(github, number, label),
        (labels) => tickets.addLabels(github, number, labels),
      ),
    // Every comment the runner posts starts with its mark: it posts as the owner, and the mark is how a later
    // run's snapshot tells it from the owner's own text (AUD-M21).
    comment: (github, number, body) => tickets.comment(github, number, runnerComment(body)),
    async qodoCheck(runId) {
      // Its own short-lived worktree, so the live answers reach the private repo's `main` even when
      // the check stops the run before the ticket's own workspace (and `ws.private`) ever exist, and
      // even on a clean run: `checkLiveQodoConfig` otherwise writes into this checkout's own `private/`,
      // which nothing else ever commits or pushes (Qodo on PR 145).
      const label = `qodo-check-${runId}`;
      const priv = join(runs, label, "private");
      let source = privateRepo;
      try {
        source = access.source();
        mkdirSync(dirname(priv), { recursive: true });
        gitLong(source, "fetch", "--quiet", "origin", "main");
        gitLong(source, "worktree", "add", "-b", label, priv, "origin/main");
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
        git(source, "worktree", "remove", "--force", priv);
        git(source, "branch", "-D", label);
        rmSync(join(runs, label), { recursive: true, force: true });
        access.drop();
      }
      return { exitCode: result.exitCode, message: result.message, differences: result.differences };
    },
    workspace(runId, repoKey) {
      const root = join(runs, runId);
      const lab = join(root, basename(LAB_ROOT));
      // A target ticket's agent gets no private worktree: the runner saves its evidence after it ends (AUD-H2).
      const reviewed = isReviewedTicket(factory, repoKey);
      const priv = reviewed ? "" : join(lab, "private");
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
        mainAtStart[PRIVATE_KEY] = access.main();
        if (priv) gitLong(privateRepo, "worktree", "add", "-b", `run-${runId}`, priv, "origin/main");
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
        fingerprints: fingerprints(factory, privateRepo, mode, lab, priv),
        hooks,
      };
    },
    audit: (ws, ticket, from, to) =>
      auditRun(factory, { checkout: privateRepo, main: access.main }, mode, ws, ticket, from, to),
    runAgent: (ws, runId, repoKey, number, ticketFile, log) => {
      // Marked before the agent exists, so every door call it makes sees the run (#347); ended when the tick ends.
      doorRun.start(runId);
      log("door-run", { marker: markerFor(), allowed: AGENT_DOOR_KINDS });
      return runAgent(
        factory,
        options,
        runs,
        ws,
        runId,
        repoKey,
        number,
        ticketFile,
        log,
        (pid) => held?.recordAgent(pid, pid ? (processStartId(pid) ?? undefined) : undefined),
        // In Actions the agent runs behind the network allow-list, or not at all; on a PC without one (#330).
        sandboxFor(mode, factory),
      );
    },
    verifyPr(ws, repoKey, pr) {
      return verifyPrWith(
        { ghJson, git, npm },
        factory,
        runs,
        (github) => `https://github.com/${github}.git`,
        ws,
        repoKey,
        pr,
        mode === "ci",
      );
    },
    checkFiles(ws, repoKey, pr, head) {
      const repo = factory.repos[repoKey];
      return readCheckFiles(
        repo?.checkFiles,
        `https://github.com/${repo?.github}.git`,
        ws.mainAtStart[repoKey],
        pr,
        head,
        join(runs, `check-files-${basename(ws.root)}-${repoKey}-pr${pr}`),
      );
    },
    record(runId, event) {
      appendFileSync(join(runs, `${runId}.jsonl`), `${JSON.stringify(event)}\n`);
    },
    saveEvidence(runId, ws) {
      let priv = ws?.private;
      // The folder a temporary worktree sits in, removed once the evidence is out. A run's own folder only when
      // the run never got a workspace; a target ticket's run keeps its worktrees there until `cleanup`.
      let temporary: string | undefined;
      let source = privateRepo;
      if (!priv) {
        temporary = join(runs, ws ? `${runId}-evidence` : runId);
        priv = join(temporary, "private");
        mkdirSync(temporary, { recursive: true });
        source = access.source();
        // A copy saved earlier whose push failed left its worktree: the next copy goes through it, not a second
        // branch of the same name (Qodo on PR 288).
        if (!existsSync(join(priv, ".git"))) {
          gitLong(source, "fetch", "--quiet", "origin", "main");
          gitLong(source, "worktree", "add", "-b", `run-${runId}`, priv, "origin/main");
        }
      }
      // A private worktree that is gone (a half-done cleanup) must never be written to: `git -C` would then
      // find the enclosing repository, the harness, and commit and push there (Qodo on PR 262).
      if (!existsSync(join(priv, ".git")))
        throw new Error("the run's private worktree is gone, so its evidence can't be saved through it");
      // The agent could write the run's private checkout, its .git too: the runner's commit and push there would run
      // its hooks and obey its config. Only as they were before the agent started; else the logs wait for the
      // workflow's keep step, which pushes them from a clone of its own (#335). In CI no process of the agent's user
      // may outlive the check either: one could change them after the runner looked (Qodo on PR 336).
      const lingering = ws?.private && mode === "ci" ? stopAgentProcesses() : null;
      if (lingering) throw new Error(`${lingering}, so the runner won't commit through the run's private checkout`);
      const tampered = ws?.private ? gitControlProblem(ws.private, ws.fingerprints) : undefined;
      if (tampered) throw new Error(tampered);
      // A target ticket's run kept the reviews review:wait saved in a plain folder of its lab worktree, which the
      // runner now carries into the private repo: only `reviews/`, and first, so nothing the agent wrote there can
      // stand in for the runner's own logs below; links are left behind (AUD-H2; Qodo on PR 288).
      if (ws && !ws.private)
        copyEvidence(
          evidenceKindDir(join(ws.lab, factory.evidence), "reviews"),
          evidenceKindDir(join(priv, evidenceInPrivate), "reviews"),
        );
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
        git(source, "worktree", "remove", "--force", priv);
        git(source, "branch", "-D", `run-${runId}`);
        rmSync(temporary, { recursive: true, force: true });
        access.drop();
      }
      return { file: evidenceFile(factory, runId), ...result };
    },
    cleanup(ws) {
      const leftovers = teardown(factory, privateRepo, ws.root, ws.lab, ws.private, basename(ws.root));
      if (leftovers.length) throw new Error(`cleanup failed: ${leftovers.join("; ")}`);
    },
  };
  if (mode === "local") return endsDoorRun(deps, doorRun);

  return endsDoorRun(deps, doorRun, {
    ...deps,
    // The VM's target checkout gets the guard from the workflow's own step (factory.yml), not from here.
    unguarded: () => [],
    // The workflow's concurrency group allows one run at a time.
    lock: () => ({ acquired: true, release: () => {} }),
    workspace(_runId, repoKey) {
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
      mainAtStart[PRIVATE_KEY] = access.main();
      // The workflow checks no private repo out (AUD-H2). A lab ticket's agent saves evidence in <lab>/private,
      // so the runner clones it there; a target ticket's agent starts only with no private content on disk.
      const reviewed = isReviewedTicket(factory, repoKey);
      // The clone goes, unless a Qodo-state worktree kept after a failed push still needs its objects: that
      // evidence stays, and a target ticket then doesn't start (Qodo on PR 288).
      if (!access.leftovers().some((p) => basename(dirname(p)).startsWith("qodo-check-"))) access.drop();
      if (reviewed) {
        const left = access.leftovers();
        if (left.length)
          throw new Error(`a private checkout is still on disk (${left.join(", ")}), so a target ticket can't start`);
      } else if (!existsSync(join(privateRepo, ".git"))) {
        gitLong(LAB_ROOT, "clone", "--quiet", privateUrl(), privateRepo);
      }
      const hooks = requireHooks(factory, LAB_ROOT);
      return {
        root: dirname(LAB_ROOT),
        lab: LAB_ROOT,
        private: reviewed ? "" : privateRepo,
        mainAtStart,
        fingerprints: fingerprints(factory, privateRepo, mode, LAB_ROOT, reviewed ? "" : privateRepo),
        hooks,
      };
    },
    // The VM is thrown away after the run.
    cleanup: () => {},
  });
}

/**
 * `deps` with `extra` over it, and a lock whose release, at the tick's end whatever happened, first ends the run the
 * door sees (#347). The CI lock is a no-op, so the release is the one place both modes pass.
 */
export function endsDoorRun(
  deps: TickDeps,
  doorRun: Pick<ReturnType<typeof doorRunHolder>, "end">,
  extra: Partial<TickDeps> = {},
): TickDeps {
  const all = { ...deps, ...extra };
  return {
    ...all,
    lock: () => {
      const lock = all.lock();
      return {
        ...lock,
        release: () => {
          try {
            doorRun.end();
          } finally {
            lock.release();
          }
        },
      };
    },
  };
}
