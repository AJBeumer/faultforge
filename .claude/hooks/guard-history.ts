/**
 * Where git history and whole repos may go (re-grade 6). Split from guard-target.ts, which may not pass 400 lines.
 *  - The private repo stays private (N-A): no repo's visibility is changed to public here (`gh repo edit
 *    --visibility public`, an API write of `private=false` or `visibility=public`), no repo is made from the
 *    private checkout (`gh repo create --source`), and its history goes only to its own `origin`: no push from it
 *    to another remote or URL, no change to its remotes or the settings that pick where a push goes, and no clone,
 *    fetch or pull of it into another checkout, from which it could be pushed anywhere.
 *  - A reviewed repo gets history only from its own checkout (N-C): a push whose remote is a reviewed repo, by
 *    URL, local path or remote name, from any other folder (the lab, say) would send that folder's history there.
 *    No issue is transferred into a reviewed repo either, by `gh issue transfer` or GraphQL's `transferIssue`.
 * Each command is read step by step, with the folder each git or gh step runs in followed through `cd` and
 * `git -C`. A folder the guard can't read counts as the worst one. The git-level hooks are the guarantee
 * (`git-guard.ts`: the lab's pre-push refuses a reviewed remote, and the private checkout's refuses any remote but
 * its recorded origin); this is the early warning.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { referencedFiles } from "./guard-files.ts";
import { configReads } from "./guard-hooks.ts";
import { outsidePostedText } from "./guard-posted.ts";
import { privateOrigin, privateRoot, pushUrl } from "./guard-private.ts";
import { checkoutAt, githubRepos, inCheckout, locate, type Reviewed, within } from "./guard-repos.ts";
import type { Context } from "./guard-tools.ts";
import { joinedWords } from "./shell-scan.ts";
import { programAt, programName, steps, unquote, words } from "./shell-words.ts";

/** One git or gh step: the program, its words after the program, and the folder it runs in (undefined: unknown). */
interface Call {
  program: "git" | "gh" | "web";
  args: string[];
  text: string;
  dir: string | undefined;
}

const unreadable = (word: string) => /[$`%]/.test(word);

/** Programs that send an HTTP request, whose payload could make a repo public. */
const WEB = /^(curl|wget|http|https|xh|irm|iwr|invoke-restmethod|invoke-webrequest)$/;

/** Every git, gh and web step the command runs, each with the folder it runs in. */
function calls(command: string, cwd: string, backticks: boolean): Call[] {
  let here: string | undefined = cwd;
  const found: Call[] = [];
  for (const step of steps(command, backticks)) {
    const all = words(step.text).map(unquote);
    const { at } = programAt(all);
    const name = programName(all[at] ?? "");
    const rest = all.slice(at + 1);
    if (/^(cd|pushd|chdir|set-location|sl)$/.test(name)) {
      const to = rest.find((w) => !w.startsWith("-"));
      if (!to) here = homedir();
      else if (unreadable(to) || !here) here = undefined;
      else here = to.startsWith("~") ? join(homedir(), to.slice(1)) : resolve(here, to);
      continue;
    }
    if (name === "popd") here = undefined;
    if (name === "gh" || WEB.test(name))
      found.push({ program: name === "gh" ? "gh" : "web", args: rest, text: step.text, dir: here });
    if (name !== "git") continue;
    // A git folder or work tree named apart from the folder, by option or variable, is a folder the guard can't follow.
    let dir = all.slice(0, at).some((w) => /^GIT_(DIR|WORK_TREE|COMMON_DIR)=/i.test(w)) ? undefined : here;
    let i = 0;
    while (i < rest.length && (rest[i] ?? "").startsWith("-")) {
      const option = rest[i] ?? "";
      if (option === "-C") {
        const to = rest[i + 1] ?? "";
        dir = dir && to && !unreadable(to) ? resolve(dir, to) : undefined;
        i += 2;
      } else if (option === "-c" || option === "--git-dir" || option === "--work-tree") {
        if (option !== "-c") dir = undefined;
        i += 2;
      } else {
        if (/^--(git-dir|work-tree)=/.test(option)) dir = undefined;
        i++;
      }
    }
    found.push({ program: "git", args: rest.slice(i), text: step.text, dir });
  }
  return found;
}

/** The words after `skip` leading words that aren't options, skipping the values of options in `valued`. */
function positionals(args: string[], skip: number, valued: RegExp): string[] {
  const out: string[] = [];
  for (let i = skip; i < args.length; i++) {
    const word = args[i] ?? "";
    if (valued.test(word)) i++;
    else if (!word.startsWith("-")) out.push(word);
  }
  return out;
}

/** The remote a push names: `--repo`, or its first word that isn't an option; undefined for none. */
function pushRemote(args: string[]): string | undefined {
  for (let i = 1; i < args.length; i++) {
    const word = args[i] ?? "";
    if (word.startsWith("--repo=")) return word.slice(7);
    if (word === "--repo") return args[i + 1];
    if (/^(-o|--push-option|--receive-pack|--exec)$/.test(word)) i++;
    else if (!word.startsWith("-")) return word;
  }
  return undefined;
}

/** True when a remote word is a URL or a path, not a remote's name. */
const isLocation = (remote: string) => /[/\\:]|^\.\.?$/.test(remote);

/** The URL a push to `remote` from `dir` goes to: git's own answer for a remote's name, else the word itself. */
function remoteUrl(dir: string, remote: string): string {
  if (isLocation(remote)) return remote;
  return pushUrl(dir, remote) || remote;
}

/** The reviewed repo a URL or local path names, if any. */
function reviewedAt(url: string, dir: string, reviewed: Reviewed[]): Reviewed | undefined {
  const github = githubRepos(url);
  if (github.length) return reviewed.find((r) => github.includes(r.github.toLowerCase()));
  if (/^[\w+.-]+:\/\//.test(url) && !/^file:/i.test(url)) return undefined;
  return locate(resolve(dir, url.replace(/^file:\/\//i, "")), reviewed);
}

/**
 * True when `dir` is the reviewed repo's own checkout: its configured folder, or a clone whose `origin` is the
 * repo. A checkout that merely has some other remote pointing there (the lab, say) is not.
 */
function ownCheckout(dir: string, r: Reviewed): boolean {
  if (inCheckout(dir, r) || within(dir, r.checkout)) return true;
  const found = checkoutAt(dir);
  return found !== undefined && githubRepos(remoteUrl(found.root, "origin")).includes(r.github.toLowerCase());
}

/** A field that makes a repo public, in an API write: `private=false`, `"private": false`, `visibility: PUBLIC`. */
const PUBLIC_FIELD = /\bprivate\s*[=:]\s*(?:false|0)\b|\bvisibility\s*[=:]\s*(?:public|internal)\b/i;

const PUBLISH =
  "The private repo stays private: no repo is made public from here, and the private history goes only to its own origin. The owner changes visibility by hand.";

/** Why the command could publish the private repo or its history, or undefined (N-A). */
function privateProblem(call: Call, root: string): string | undefined {
  const [sub = "", verb = ""] = call.args;
  if (call.program === "gh" && sub === "repo" && verb === "edit") {
    const flag = call.args.findIndex((w) => /^--visibility(=|$)/.test(w));
    const value = flag < 0 ? "" : (call.args[flag]?.split("=")[1] ?? call.args[flag + 1] ?? "");
    if (flag >= 0 && value.toLowerCase() !== "private") return PUBLISH;
  }
  if (call.program === "gh" && sub === "repo" && verb === "create") {
    const flag = call.args.findIndex((w) => /^(--source|-s)(=|$)/.test(w));
    const source = flag < 0 ? undefined : (call.args[flag]?.split("=")[1] ?? call.args[flag + 1] ?? "");
    if (source !== undefined && (!call.dir || unreadable(source) || within(resolve(call.dir, source), root)))
      return PUBLISH;
  }
  if (call.program !== "git") return undefined;
  const inPrivate = call.dir === undefined || within(call.dir, root);
  const own = privateOrigin(root);
  if (sub === "push" && inPrivate) {
    const remote = pushRemote(call.args) ?? "origin";
    if (remote === "origin") return undefined;
    if (!call.dir || unreadable(remote)) return PUBLISH;
    const github = githubRepos(remoteUrl(call.dir, remote));
    if (!github.length || github.some((repo) => !own.includes(repo))) return PUBLISH;
  }
  if (inPrivate && call.dir !== undefined) {
    if (sub === "remote" && /^(add|set-url|rename|remove|rm)$/.test(verb)) return PUBLISH;
    const settings = call.args.slice(1).filter((w) => !w.startsWith("-"));
    if (sub === "config" && !configReads(call.args.slice(1)) && settings.some((w) => /^(remote|url|branch)\./i.test(w)))
      return PUBLISH;
  }
  // A copy of the private history in another checkout could be pushed anywhere.
  if (/^(clone|fetch|pull|submodule|remote)$/.test(sub) && call.dir && !within(call.dir, root)) {
    const named = call.args.slice(1).filter((w) => !w.startsWith("-") && !unreadable(w));
    const reaches = (w: string) =>
      githubRepos(w).some((repo) => own.includes(repo)) ||
      within(resolve(call.dir ?? "", w.replace(/^file:\/\//i, "")), root);
    // A remote's name is read as the URL it fetches from (`git fetch private`; Qodo on PR 333).
    const fetched = (w: string) => (isLocation(w) ? w : pushUrl(call.dir ?? "", w, false) || w);
    if (named.some((w) => reaches(w) || reaches(fetched(w)))) return PUBLISH;
  }
  return undefined;
}

/** Why the command could send history or an issue into a reviewed repo from elsewhere, or undefined (N-C). */
function reviewedProblem(ctx: Context, call: Call): string | undefined {
  const [sub = "", verb = ""] = call.args;
  if (call.program === "gh" && sub === "issue" && verb === "transfer") {
    // `owner/name` must be the reviewed repo itself; a bare name may be under any owner (Qodo on PR 333).
    const destination = (positionals(call.args, 2, /^(-R|--repo)$/)[1] ?? "").toLowerCase();
    const reviewed = (r: Reviewed) =>
      destination.includes("/") ? destination === r.github.toLowerCase() : destination === r.name.toLowerCase();
    if (unreadable(destination) || ctx.reviewed.some(reviewed)) return TRANSFER;
  }
  if (call.program !== "git" || sub !== "push") return undefined;
  const remote = pushRemote(call.args) ?? "origin";
  if (!call.dir) {
    const named =
      isLocation(remote) && githubRepos(remote).length ? reviewedAt(remote, ctx.cwd, ctx.reviewed) : undefined;
    return named ? fromElsewhere(named) : undefined;
  }
  if (unreadable(remote)) return undefined;
  const target = reviewedAt(remoteUrl(call.dir, remote), call.dir, ctx.reviewed);
  if (!target || ownCheckout(call.dir, target)) return undefined;
  return fromElsewhere(target);
}

const TRANSFER =
  "No issue is transferred into a reviewed repo, nor by a GraphQL transferIssue the guard can't follow: its timeline would show where it came from.";

const fromElsewhere = (r: Reviewed) =>
  `Push to ${r.name} only from its own checkout: from here the push would send this folder's history there.`;

/**
 * Why the command could publish the private repo or its history, or move history or an issue into a reviewed
 * repo from elsewhere; undefined when it does neither. Read outside posted text: a message's words run nothing.
 */
export function historyProblem(ctx: Context, command: string): string | undefined {
  const root = privateRoot(ctx.env);
  const found = calls(outsidePostedText(command), ctx.cwd, ctx.backticks);
  // An API field is posted text, so the whole command and the files it posts are read for one (`-f private=false`).
  if (found.some((call) => call.program === "web" || (call.program === "gh" && call.args[0] === "api"))) {
    const texts = [command, ...referencedFiles(ctx.cwd, command)].map(joinedWords);
    if (texts.some((text) => PUBLIC_FIELD.test(text))) return PUBLISH;
    if (texts.some((text) => /\btransferIssue\b/.test(text))) return TRANSFER;
  }
  for (const call of found) {
    const problem = privateProblem(call, root) ?? reviewedProblem(ctx, call);
    if (problem) return problem;
  }
  return undefined;
}
