# FaultForge

**Break it. Review it. Prove it.**

An adversarial quality laboratory for AI software factories, powered by Qodo.

| | |
|---|---|
| Event | Qodo hackathon "Build a Software Factory in 30 Days", 2 November to 1 December 2026 |
| Project type | Solo hackathon project, reproducible developer-tool prototype |
| Charter version | 2.2, 6 November 2026 (made public; see Charter control) |
| Status | Locked vision and scope. Implementation adapts to the daily challenges |

---

## 1. The idea in one paragraph

FaultForge is a software factory that deliberately introduces defects into its own code, uses Qodo to detect them, and demands executable proof before any finding is accepted or rejected. A saboteur injects known, realistic bugs into a small application. Qodo reviews the resulting pull requests. A challenger, Devil's Advocate, tries to support or disprove each Qodo finding by writing and running a test, not by arguing. A small policy layer decides what reaches the developer. Because the injected defects are known, every step can be measured. The output after 30 days is a reproducible benchmark, an audit trail, and a verification layer that extends Qodo's review into executable evidence. Judges can try it without setup, and developers can point it at their own repository with one command.

**The non-negotiable principle: demand proof, not opinion.** A model's agreement or disagreement is not evidence. When evidence is insufficient, the answer is *inconclusive*, never *safe*.

## 2. The problem

Coding agents produce code faster than humans can read it. The bottleneck moves from generating code to knowing whether to trust it. AI code review is the obvious answer, and it brings two linked problems:

- **Missed defects.** A generated change can look plausible, pass superficial inspection, and still violate a business invariant. Nobody knows which defect classes a reviewer catches without ground truth.
- **Noisy findings.** Review tools flag issues that are unreachable, already guarded, or weakly evidenced. The developer triages every one by hand, and the time saved writing code is spent adjudicating comments. A second model saying "I disagree" adds an opinion, not a solution.

These are linked because suppressing findings makes precision look better while silently discarding real defects. Any honest solution measures both missed defects and false positives.

**Why Qodo is central.** Qodo is the independent reviewer and the main quality checkpoint. FaultForge supplies the adversarial testbed, the evidence, and the feedback that make a Qodo-driven workflow more useful. It demonstrates Qodo's value. It does not replace Qodo's review engine, and it is not a takedown.

**Product hypothesis.** Pairing Qodo review with controlled defect injection and evidence-based verification improves the usefulness of developer-facing findings without an unacceptable loss in detection of real defects. This is a hypothesis to test, not a claim to assume.

## 3. The fixed goal

The daily challenges shape what gets built on which day. The destination does not move.

**North star:** build a software factory that can challenge its own quality claims, preserve the evidence, and report the results honestly.

**By Day 30, a stranger can:**

1. Run a documented, isolated defect-injection scenario.
2. Inspect the exact change Qodo reviewed and Qodo's actual output.
3. Open a case file showing the finding, the challenger's test, and the evidence.
4. See a defensible disposition: supported, disproven with evidence, or inconclusive.
5. Compare measured outcomes before and after the challenger, including real findings it wrongly suppressed.
6. Reproduce the benchmark from the audit log with one command.
7. Try FaultForge in under five minutes without a Qodo account.
8. Run an audit on their own TypeScript repository with one command and get a blind-spot report.

**What will exist:**

- A seed application with explicit, documented invariants.
- A library of deterministic fault-injection templates and a private ground-truth ledger.
- A Qodo integration reviewing every injected change and every clean control change, with the review path labelled per case.
- Devil's Advocate: a challenger producing a test, evidence, and a verdict per finding.
- An evidence arbiter: a small deterministic policy function plus human judgment.
- An append-only audit log and a static Debate Chamber generated from it.
- A benchmark report with real counts, defined denominators, and stated limitations.
- A rule-proposal workflow that opens a pull request for human approval.
- Agent instruction files, Qodo configuration, and the saboteur templates versioned as factory assets.
- A command-line tool for audit and replay, and a GitHub Action for the challenge mode.
- A published Debate Chamber site and a one-click Codespace for judges.
- A setup guide, architecture overview, and end-to-end demo.

**What success is not:** "the AI says the code is safe"; a debate animation with no reproducible tests; dismissing a finding because a generated test passed; a benchmark whose answer key the reviewer can read; accuracy claims from hand-picked examples; five half-finished agents.

## 4. Principles

These hold for the whole month regardless of what a daily challenge asks for.

1. **Every claim needs evidence.** An opinion from a second model is not a counterargument. A test is.
2. **Every verdict is auditable.** Each case goes to an append-only log with the finding, the challenge, the evidence, the decision, and who or what decided.
3. **Every improvement is measured.** No feature ships without a before-and-after number from the benchmark.
4. **A passing test is not proof.** The challenger must show its test exercises the alleged failure mechanism. Otherwise the verdict is inconclusive.
5. **Ground truth stays isolated.** The ledger lives outside the target repository and outside any context the reviewer or challenger can read.
6. **Sabotage looks ordinary.** Branch names, commit messages, and PR descriptions are neutral and plausible. We test whether Qodo can review code, not whether it can read a confession.
7. **Security findings always stay visible.** The arbiter never suppresses a security or authorization finding on a model's verdict alone.
8. **Only measured numbers go public.** Simulations and projections stay internal. Raw counts and denominators go with every percentage.
9. **The benchmark configuration is frozen.** Qodo configuration, templates, and match criteria are versioned, and no change happens mid-measurement without a new benchmark version.
10. **Qodo is the hero.** Devil's Advocate extends Qodo's review into executable verification. It does not fix a deficient reviewer.
11. **Human-approved learning.** Rule changes are proposed, evaluated, and approved. Nothing rewrites standards on its own.
12. **One working capability at a time.** There is always a complete runnable path through the system.
13. **One engine, many shells.** Judges, users, and the later app all run the same core. No feature exists only in the demo.

## 5. Scope

| Priority | Capability | Decision |
|---|---|---|
| Core | Seed application | One small TypeScript booking API with documented invariants |
| Core | Saboteur | Deterministic templates; each run produces one isolated change with neutral PR text |
| Core | Private ground truth | Case id, template, class, invariant, location, target commit, proof test. Never visible to reviewer or challenger |
| Core | Qodo integration | Collect actual findings, reviewed commit, review path, config version, and date. Record incomplete runs honestly |
| Core | Devil's Advocate | Targeted test generation and execution, evidence capture, proposed verdict |
| Core | Audit trail | Append-only events linking commits, findings, tests, verdicts, and human decisions |
| Core | Evaluation | Seeded recall, finding precision, retained precision, wrongly suppressed findings, inconclusive rate |
| Lightweight | Evidence arbiter | Deterministic policy function plus human gate. Not another agent |
| Lightweight | Rule evolution | Detect a recurring adjudicated pattern and open a proposed rule-change PR |
| Core | Engine as a library | Target adapter and review-source interfaces. Every shell runs the same core |
| Core | Judge access | Published case site, Codespace, replay mode that needs no Qodo account |
| Lightweight | Audit on any repository | Generic TypeScript templates, blind-spot report, `--budget` cap |
| Lightweight | Challenge Action | GitHub Action wrapping the challenger for pull requests |
| Presentation | Debate Chamber | Static case-file viewer rendered from sanitized records. No live streaming |
| Deferred | Concurrency defects | Only if reliable reproduction is demonstrated in the final week |
| Deferred | Hosted app | Accounts, billing, cross-repository dashboard. After the hackathon |
| Out of scope | Guaranteed proofs on arbitrary repositories, languages beyond TypeScript and JavaScript, self-modifying policies, orchestration frameworks, real payment infrastructure | Not needed to test the hypothesis |

**Scope rule.** A daily challenge may change sequencing, tooling, presentation, or implementation detail. It may not replace the north star or compromise measurement integrity. Every new feature must improve defect creation, independent review, evidence collection, adjudication, evaluation, or explainability.

**Rescoping priority when time is tight.** Preserve the end-to-end evidence chain, the benchmark, and judge access through replay. Drop, in order: UI polish, additional challenger strategies, rule automation, the learn mode, exotic defect classes, the challenge Action. The one-command audit is the last thing to drop.

## 6. Seed application

**Working name:** `booking-api`. A tiny fictional booking service with an HTTP API, deterministic fixtures, and SQLite or an in-memory store. Chosen over payments to get business-critical invariants without provider dependencies. It exists to make failure modes understandable to judges and to keep the challenger's problem bounded. It is not a product.

### Invariants

| Id | Rule | Defect class |
|---|---|---|
| INV-IDEMP-001 | Reusing an idempotency key never creates a second booking | Idempotency guard bypass |
| INV-AUTH-001 | A user cannot read or cancel another user's booking | Authorization check omission |
| INV-VALID-001 | Invalid requests are rejected without changing state | Input-validation removal |
| INV-NULL-001 | Absent optional data never crashes an otherwise valid request | Null and undefined handling |
| INV-BOUND-001 | Date and quantity limits are enforced at documented boundaries | Boundary and off-by-one |
| INV-OVERLAP-001 | A resource is never double-booked for overlapping ranges | Logic error, deferred until the store supports it |

### Testability constraints

- Fixed test data, deterministic clock and ids, isolated storage per run.
- No network access to real providers. Bounded runs.
- Every fault is observable by a test within seconds.
- Invariants are readable independently of the implementation.
- The hidden proof tests are distinct from the public application tests.
- Do not retain a database constraint that silently neutralizes an injection, and do not pretend its absence is safe in production. This is an instrumented lab.
- Do not lead with concurrency.

## 7. Actors

**Saboteur, the defect producer.** Chooses from a catalog of known templates, applies one mutation to a disposable branch, verifies with a hidden proof test that the mutation violates its invariant, writes the answer key to the private ledger, and generates neutral PR text. Deterministic in v1. An LLM may propose mutations later only if a hidden test validates them first.

**Qodo, the independent reviewer.** Reviews the changed snapshot through the supported integration and produces findings with location, description, and category. Has normal repository context and truthful requirements. Never the answer key. Qodo also reviews the challenger's generated tests and the factory's own agent instruction files, so it stays central in every act.

**Devil's Advocate, the challenger.** Receives one Qodo finding plus the code and permitted public context. Forms a falsifiable hypothesis, writes an isolated targeted test, runs it in a sandbox, records commands, environment, exit status, and output, and proposes supported, disproven, or inconclusive with evidence attached.

**Evidence arbiter, the policy layer.** Verifies that artefacts exist and came from the right snapshot, checks that the evidence addresses the finding, applies the written policy, routes uncertain or high-risk cases to a human, and records every decision with a timestamp and rationale. Not an AI.

**Human, the final authority.** Adjudicates ambiguous matches and false-positive claims, reviews uncertain and risky cases, approves or rejects rule proposals, and can always inspect suppressed findings. In a solo project the human also wrote the answer key, so adjudication follows the predefined match rule and is logged, never done from memory.

## 8. Workflows

### Act I: can Qodo catch the defect?

```text
Correct seed app with explicit invariant
        |
        v
Saboteur applies one validated mutation
        |
        +--> PRIVATE ledger entry (outside target repo and agent context)
        |
        v
Isolated branch, neutral PR, exact commit snapshot
        |
        v
Qodo review (path, config version, and date recorded)
        |
        v
Raw output stored, findings normalized
        |
        v
Match against ledger using the fixed rule, human-checked
        |
        v
Detection result and audit record
```

Day 1 is already a complete vertical slice: one defect, one PR, one review, one traceable observation.

### Act II: should the developer trust this finding?

```text
Existing Qodo finding
        |
        v
Devil's Advocate forms a testable hypothesis
        |
        v
Generates test, runs it in an isolated sandbox
        |
        v
Records results, artefacts, and limitations
        |
        v
Arbiter applies policy; human adjudicates if needed
        |
        +--> Supported     --> visible finding with evidence attached
        +--> Inconclusive  --> visible, flagged for human review
        +--> Disproven     --> retained in audit; suppression only under approved policy
        |
        v
Static case file and updated evaluation
```

Raw Qodo findings and filtered developer-facing findings are both retained. Filtering never overwrites evidence or rewrites history.

### Act III: what did the factory learn?

Group adjudicated outcomes by template, class, and conditions. Where a recurring pattern exists, open a proposed rule or guidance change as a PR with supporting and counter-example case ids, the risk of masking real defects, and a held-out evaluation result. Require human approval. Never teach the reviewer the hidden answers, and never adapt the benchmark to flatter results. If no credible pattern emerges, no rule PR is better than a contrived one.

## 9. Architecture

### Repositories and storage

```text
faultforge/                      public harness and source project
  README.md                      pitch and quick start
  docs/
    CHARTER.md                   this document
    evaluation-method.md         metric definitions and denominators
    decision-log.md              one entry per daily challenge
  AGENTS.md / CLAUDE.md          agent instructions: factory assets, reviewed by Qodo
  .qodo/ or .pr_agent.toml       Qodo configuration, versioned and frozen per benchmark
  .devcontainer/                 one-click Codespace for judges
  packages/
    core/                        the engine: target adapters, review sources, cases, policy
    harness/                     injection runner, PR creation, review ingestion
    challenger/                  test generation and sandboxed execution
    report/                      metrics and static case-file generation
    cli/                         faultforge audit | replay | report
    action/                      GitHub Action for challenge and learn modes
  templates/                     never loaded into reviewer or challenger context
    seed/                        templates for booking-api, with hidden proof tests
    generic/                     structural templates for any TypeScript project
  replay/                        recorded Qodo output for replay mode
  examples/                      sanitized public case records only

faultforge-target/               separate public repository that Qodo reviews
  src/                           booking-api
  test/                          ordinary application tests
  INVARIANTS.md                  the documented invariants

PRIVATE STORAGE                  outside both public repositories
  ground-truth.jsonl             answer key
  audit-events.jsonl             full append-only event stream
  raw-artifacts/                 Qodo output, test logs, snapshots
```

The separation prevents the answer key from entering Qodo's review context. Nothing private is exported to `examples/`. Build the smallest working slice first; this layout is the target, not a Day 1 requirement.

### Stack

TypeScript and Node.js. Fastify or an equally lean HTTP framework. Vitest for tests. SQLite or an in-memory store. Plain scripts and a small CLI, no orchestration platform. Static HTML for the Debate Chamber, reading sanitized JSON. Append-only JSONL with a single writer for events; reports are derived views, never the source of truth. Challenger tests run in disposable worktrees or containers with time, resource, and network limits, and never with real credentials.

### Record contracts

**Private ledger entry** (never leaves private storage):

```json
{
  "caseId": "FF-0001",
  "kind": "sabotage",
  "templateId": "idempotency-guard-bypass-v1",
  "invariantId": "INV-IDEMP-001",
  "defectClass": "idempotency",
  "targetCommit": "<sha>",
  "injectedFile": "src/bookings/create.ts",
  "injectedLines": [42, 57],
  "proofTest": "<private artefact id>",
  "validated": true,
  "createdAt": "2026-11-02T00:00:00Z"
}
```

**Public case record** (published only after adjudication, sensitive fields stripped):

```json
{
  "caseId": "FF-0001",
  "kind": "sabotage | control",
  "targetCommit": "<sha>",
  "pr": { "repo": "...", "number": 0 },
  "review": { "path": "cli | pr-comments", "configVersion": "...", "reviewedAt": "..." },
  "findings": [{ "id": "...", "file": "...", "lines": [0, 0], "category": "...", "summary": "..." }],
  "detection": { "caught": true, "matchedFindingIds": [] },
  "challenge": { "findingId": "...", "hypothesis": "...", "testArtefact": "...", "mechanismCovered": true, "result": "..." },
  "verdict": "supported | disproven | inconclusive | not_run",
  "arbiter": { "policyVersion": "...", "routedTo": "pr | human | audit-only" },
  "human": { "disposition": "...", "adjudicatedAt": "..." },
  "status": "complete | incomplete"
}
```

Every durable event also carries an event id, type, UTC timestamp, tool and agent version, environment id, and input snapshot hash.

## 10. Qodo integration

### Primary path and Day 2 acceptance check

The documented local review command with JSON output is the primary candidate. Documentation also describes possible closed-preview gating, so nothing is assumed until an authenticated end-to-end run succeeds.

1. Confirm the trial covers the full 30 days and includes command-line review and enough review quota for the benchmark.
2. Inspect the installed CLI version and the review command's help.
3. Verify authentication and that local review is permitted for this account.
4. Review a known change against the correct base commit.
5. Save the raw JSON. Inspect finding ids, locations, categories, status, and metadata.
6. Run the same diff three times. Record runtime, quota use, and variance between runs.
7. Document the outcome as working, gated, or unavailable.

### Fallback

If local structured review is unusable, open normal GitHub PRs and ingest Qodo's posted review through supported GitHub interfaces. Store the reviewed commit and completion status. Do not infer machine-readable fields that are absent.

### Rules that apply on either path

- Label the review path, configuration version, and date on every case. Never mix paths in one accuracy comparison.
- Qodo's models and prompts will change during the month. Report results stratified by date window when they differ.
- Freeze the Qodo configuration for the baseline. A configuration change starts a new benchmark version.
- Configure Qodo's normal PR review so that arbiter-published findings do not duplicate it. Do not assume published comments can be intercepted.
- Map Qodo's categories to the arbiter's "security-critical" set explicitly and version that mapping.

## 11. Devil's Advocate: evidence requirements

**Input.** One Qodo finding, the exact code snapshot, the public invariants, and a sandboxed test runner. Not the ledger, not template metadata.

**Required output.** The finding's id and a paraphrase of its claim. A falsifiable hypothesis and the failure mechanism. The generated test and exact commands. Environment and snapshot hash. Observed result, output, and exit code. A statement of what the evidence shows and what it does not. A proposed disposition.

**Verdict policy, v1:**

| Verdict | Minimum evidence | Developer-facing behaviour |
|---|---|---|
| Supported | A relevant failing test or reproduction with a coherent causal link to the finding, ideally passing on the corrected baseline | Finding preserved, evidence attached |
| Disproven | Reviewable evidence that the alleged path is unreachable or prevented under stated constraints: a targeted test plus code or contract reasoning | Eligible for human-approved suppression; full audit record retained |
| Inconclusive | Test failed to run, insufficient coverage, contradictory signals, or a mere passing result | Finding preserved, flagged for human review |

Security and authorization findings stay visible unless a human approves dismissal. The challenger may never treat silence as proof of safety. Qodo reviews the challenger's generated tests before they count as evidence.

## 12. Evaluation methodology

This is the project's credibility backbone. The scorecard stays honest when results disappoint.

### Ground truth and labelling

- The invariant is specified before injection. Each mutation is validated against the correct and defective variants.
- The answer key is private and unavailable to the reviewer and challenger.
- **Match rule, fixed before data collection:** a finding counts as a detection when it names the injected file, overlaps the injected line range, and carries a category consistent with the defect class. A generic warning is not a detection. Criteria are never loosened after seeing results.
- Findings outside the injected range, and all findings on control changes, are adjudicated by a human. Unadjudicated findings are reported as unresolved, never as false positives.
- Clean control changes are included from week one. Precision cannot be estimated without them.

### Core measurements

| Measurement | Definition |
|---|---|
| Seeded recall | Detected injected defects / valid injected defects evaluated |
| Finding precision | Adjudicated true-positive findings / all adjudicated findings |
| Retained precision | True-positive findings retained after the challenger / all retained adjudicated findings |
| Wrongly suppressed | True-positive findings the challenger marked disproven. The key safety metric |
| Inconclusive rate | Challenges ending inconclusive / challenges run |
| Review variance | Differences in findings across repeated reviews of an identical diff |

Also, where practical: outcomes per defect class and template, reproduction rate, time and cost per case, and the share of cases eligible for automatic suppression.

### Distinctions that must survive into the report

- Recall and precision have different denominators. Say which.
- Recall is recall on the seeded benchmark, not on all possible defects.
- A missed injection says nothing about the truth of Qodo's other findings on that PR.
- A test that fails on the defective variant and passes on the correct one supports a reproduced defect. The challenger must still connect it to the specific finding.
- Run failures, rate limits, and partial coverage stay visible.

### Contamination controls

Rotate defect classes, templates, files, functions, surrounding code, ordering, and control changes. Keep held-out templates unused by any rule proposal. Record template id, tool configuration, review path, snapshot, and date privately so results can be stratified. Distinguish repeated-template cases from held-out cases. Do not claim generalization from a small or repeatedly exposed sample.

### Reporting standard

Never publish illustrative or simulated percentages as results. Publish raw counts, denominators, definitions, dates, configuration versions, and caveats. If the sample is too small for a meaningful percentage, present counts and case studies.

Blank report structure, no fabricated data:

| Metric | Qodo alone | With Devil's Advocate |
|---|---:|---:|
| Valid injected cases evaluated | TBD | same set |
| Injected defects detected | TBD | unchanged by design |
| Adjudicated finding precision | TBD | TBD |
| Genuine findings wrongly suppressed | n/a | TBD |
| Inconclusive challenges | n/a | TBD |
| Median review or challenge time | TBD | TBD |

## 13. Learning loop

| Outcome pattern | What the factory proposes |
|---|---|
| Qodo repeatedly wins a challenge type | Stronger challenger test strategies |
| Devil's Advocate repeatedly wins a finding type | Tighter Qodo rule scoping or review guidance |
| Neither proves its case | Record uncertainty, request human judgment |

A proposal is a pull request against the Qodo configuration or agent instructions containing the change, the motivating cases, counter-examples, the masking risk, a held-out evaluation, and a request for approval. Nothing activates on its own. Approving a proposal starts a new benchmark version.

## 14. Debate Chamber

A static case-file viewer generated from sanitized records. Each case shows the change, the Qodo finding with exact reference, the challenger's hypothesis, the test source and output with caveats, the disposition and approval state, and the event timeline including any rule-proposal PR. It may be polished, but it must be generatable from JSON alone. If the UI breaks, the evidence and CLI reports remain a valid submission.

## 15. Adoption and access

FaultForge serves two audiences with one engine. Judges must be able to try it within minutes, without a Qodo account. Developers must be able to point it at their own project with one command. After the hackathon, a hosted app is built on the same core and data. The seed app stays as the controlled benchmark and the demo fixture. It is not the only target.

### 15.1 Judges: three levels, no setup

| Level | What the judge does | What it needs |
|---|---|---|
| Browse | Open the published Debate Chamber site and read every real case, finding, test, and verdict | A browser |
| Replay | Open the repository in a GitHub Codespace and run `faultforge replay` | A GitHub account |
| Live | Run the full pipeline against the seed app or their own repository | A Qodo account |

**Replay mode** re-runs the whole pipeline from Qodo output recorded in the audit log. Injection, matching, challenger test execution, arbitration, and reporting all run for real. Only the Qodo call is substituted. Replayed output is labelled as replayed. It must reproduce the published benchmark numbers exactly, so replay doubles as the reproducibility check. Because of replay, the demo always works, and because the recordings are the same audit log the benchmark comes from, nothing is staged.

### 15.2 Developers: their own projects

| Mode | How it runs | What the developer gets |
|---|---|---|
| Audit | `npx faultforge audit`, locally | A blind-spot report for their own code |
| Challenge | A GitHub Action on pull requests | One comment per PR backing each Qodo finding with a test, or flagging it as unconfirmed |
| Learn | A scheduled GitHub Action | A pull request proposing Qodo configuration changes for a human to approve |

```bash
npx faultforge audit
```

```yaml
- uses: faultforge/challenge@v1
```

**Audit mode** plants defects in throwaway worktrees, runs a local Qodo review on each one, and runs the project's own test suite. It never opens a pull request and never touches the main branch. Each planted defect lands in one of four cells:

| | Qodo caught it | Qodo missed it |
|---|---|---|
| **Tests caught it** | Double coverage | Tests are the only safety net |
| **Tests missed it** | Review is the only safety net | **Blind spot** |

The blind-spot cell is the hook. It names defect classes that would reach production today and suggests the Qodo rule or the missing test that closes each one. This is mutation testing applied to code review.

**Validating defects on unfamiliar code.** On a user's repository there is no hidden proof test, and some mutations change nothing observable. A planted defect therefore needs evidence before it counts:

- It must compile.
- If at least one existing test fails, the defect is validated.
- If no test fails, Devil's Advocate tries to write a reproducing test. If it succeeds, the defect is a confirmed blind spot, and the user keeps the test.
- If neither happens, it is reported as a possible blind spot, unconfirmed, and it is excluded from every rate.

**Ease of use:**

- Zero configuration by default. It detects the language, test runner, and Qodo setup.
- An optional INVARIANTS.md in plain English gives more targeted defects.
- Generic structural templates work on any TypeScript project: remove a guard clause, flip a comparison, drop an await, delete an authorization check, swallow an error, shift a boundary.
- The answer key lives in the user's home directory, never in the repository, so it never enters Qodo's context.
- Generated tests run in a sandbox with no network access and no credentials.
- A `--budget` flag caps the number of planted defects, and the tool estimates the Qodo review cost before running.

**Limits in v1:** TypeScript and JavaScript only. The challenger needs a project with runnable tests. Audit mode needs the local Qodo review. Where that is unavailable, it falls back to draft pull requests on a fork the user owns.

### 15.3 Built to become an app

The hackathon builds the core of a later product, not a throwaway demo.

- **Core as a library.** One engine package holds targets, review sources, cases, and policy. The command-line tool, the GitHub Action, replay mode, and the Debate Chamber are thin shells around it.
- **Two plug-in interfaces.** A target adapter supports the seed app and any local repository. A review source supports the local Qodo review, Qodo PR comments, and replay.
- **Stable, versioned data.** The case record and audit log schemas carry a version number. A later dashboard reads them unchanged.
- **No hosted service during the hackathon.** Accounts, billing, and a web app wait until afterwards. Building them now would break the scope rule.

| Stage | Who uses it | What they get |
|---|---|---|
| Hackathon | Judges | Published site, Codespace, replay mode |
| Hackathon | Early users | Command-line audit and GitHub Action |
| After the hackathon | Teams | A hosted app with history and trends across repositories, built on the same core and data |

## 16. Thirty-day roadmap

Daily challenges are inputs, not replacements. Sequencing is flexible; dependencies and the quality bar are not.

| Phase | Non-negotiable milestone | Stretch |
|---|---|---|
| Day 1 | Seed app, one validated mutation, ledger entry, one neutral PR, one Qodo review, one recorded outcome | CLI entry point |
| Day 2 | Qodo integration gate: local JSON verified or fallback chosen; trial coverage confirmed; variance measured | Normalized findings |
| Days 3 to 7 | Several templates, clean controls, repeatable isolated cases, artefact capture, agent instructions under Qodo review, engine extracted as a library with target and review-source interfaces | CI automation |
| Days 8 to 14 | Adjudication criteria applied, measured detection and precision, contamination safeguards, frozen baseline config, first audit of an external TypeScript repository with generic templates | More classes, held-out cases |
| Day 15 | Devil's Advocate reveal: first evidence-based challenge on a real finding, persisted case | Case-file preview |
| Days 16 to 22 | Repeatable evidence generation, conservative verdicts, arbiter policy, audit trail, human gate, replay mode | Challenge GitHub Action |
| Days 23 to 27 | Before-and-after benchmark on the same findings, wrongly-suppressed and inconclusive counts | One approved rule-proposal PR, learn mode |
| Days 28 to 30 | Published Debate Chamber site, Codespace with replay verified on a clean machine, quick start, honest metrics | Live audit of a well-known open-source project, UI polish |

Devil's Advocate was first planned as a Day 15 surprise. Since version 2.2 the whole plan is public; Day 15 stays the milestone where it first runs on a real finding, after detection has been demonstrated.

### Daily challenge protocol

1. Read the challenge's exact acceptance requirements. They are mandatory even when they affect sequencing.
2. Identify the smallest increment that satisfies the challenge and strengthens FaultForge.
3. State what changes and what stays fixed.
4. Implement one testable vertical slice, review it with Qodo, capture evidence.
5. Record the decision in the decision log.
6. If a challenge conflicts with the plan, adapt the implementation rather than manufacturing irrelevant features.

```markdown
## Day NN: [challenge title]
- Challenge requirement:
- Increment delivered:
- What changed from the plan and why:
- Tests and Qodo evidence:
- Lesson or decision:
- Remaining risk:
```

## 17. Day 1 deliverable

**Capability:** inject one reproducible idempotency defect into an otherwise working booking API.

- [ ] `POST /bookings` accepts an idempotency key.
- [ ] Correct code returns the original booking on repeat submission.
- [ ] A deterministic injection command creates the faulty variant.
- [ ] A private proof test shows the variant violates INV-IDEMP-001.
- [ ] The private ledger records template, location, target commit, and proof artefact.
- [ ] The faulty change is published as a focused GitHub PR with a neutral description.
- [ ] Qodo reviews the PR. The actual findings and reviewed commit are stored.
- [ ] The outcome is recorded as case FF-0001: detected, missed, or review incomplete.
- [ ] The Day 1 discussion post shares only actual results and one engineering lesson.

Day 1 is a success even if Qodo misses the defect. That is an honest benchmark result, which is the point of the lab.

## 18. Definition of done

**Must have**

- [ ] A stranger can set up and run a fault scenario from the documentation.
- [ ] Every published result links to a real change and real Qodo output.
- [ ] Ground truth was hidden during review and challenge.
- [ ] Misses, unsupported findings, and uncertainties are recorded without rewriting.
- [ ] Devil's Advocate produced executable evidence for representative findings.
- [ ] No finding was discarded because a model merely disagreed.
- [ ] The before-and-after table uses comparable cases and defined denominators.
- [ ] A static case file tells one complete story from mutation to disposition.
- [ ] The benchmark can be reproduced from the audit log with one command.
- [ ] A judge can browse real cases from a link and run replay in a Codespace in under five minutes, without a Qodo account.
- [ ] A developer can run the audit on their own TypeScript repository with one command and get a blind-spot report.

**Should have**

- [ ] Multiple distinct defect classes, not repeats of one template.
- [ ] Control changes and some held-out cases.
- [ ] Automated artefact collection with reproducible commands.
- [ ] At least one case where the challenger disproved a finding with a mechanism-covering test, and one where it supported a finding with a reproducing test.
- [ ] The challenge mode runs as a GitHub Action on a real pull request.
- [ ] At least one external open-source repository has been audited, with its blind spots published.

**Could have**

- [ ] A human-approved rule-change proposal based on recurring outcomes.
- [ ] A richer dashboard, more languages, or harder defect classes.

A negative or mixed result, carefully explained, beats a fabricated success.

## 19. Risks

| Risk | Mitigation |
|---|---|
| Scope grows into three projects | One vertical slice at a time. Arbiter is a function, Debate Chamber is static, rule engine is a PR generator |
| Qodo local review is gated or output differs | Day 2 gate. PR-comment fallback. Path labelled per case |
| Trial ends or quota runs out before Day 30 | Confirm at signup. Budget calls. Cache raw results. Never invent missing ones |
| Qodo changes under the benchmark | Record date and version per case. Stratify. Freeze configuration per benchmark version |
| Review non-determinism | Measure variance on Day 2. Report it. Repeat key cases |
| Challenger dismisses real defects | Evidence requirements, inconclusive by default, human gate, wrongly-suppressed metric |
| Test does not exercise the alleged failure | Validate preconditions, affected path, state assertions, correct-versus-defective behaviour. Qodo reviews the test |
| Ground truth leaks | Separate repositories and private storage. No template ids or confessions in PR context |
| Repetition inflates detection | Rotate templates, locations, classes, controls. Tag repeats and hold-outs |
| Solo adjudication bias | Fixed match rule before data. Every adjudication logged with rationale |
| Sample too small | Raw counts, narrow claims, case studies |
| Sandbox runs untrusted generated code | Disposable isolated runner, resource and network limits, no credentials |
| Rule changes teach the answers | Human-reviewed scoped proposals, held-out checks, no automatic deployment |
| Daily challenges divert effort | Protocol above. Rescope optional work before core integrity |
| Generic mutations on unfamiliar code change nothing observable | Compile check, test-based validation, challenger reproduction. Unconfirmed defects excluded from every rate |
| Replay looks staged | Only the Qodo call is substituted, output is labelled, and numbers must match the published report |
| Audit costs users review quota | `--budget` cap, sampling, cost estimate before running |
| Judges cannot run it | Browse needs a browser, replay needs no Qodo account, Codespace verified on a clean machine before submission |

## 20. Open questions to settle early

- Does the local review return structured JSON with ids, categories, locations, and evidence in this account?
- Does the trial cover 30 days, include command-line review, and provide enough quota?
- How much do findings vary across repeated reviews of the same diff?
- How is Qodo's normal PR review configured so the arbiter's output does not duplicate it?
- Which Qodo categories map to "security-critical" in the arbiter policy?
- Where does private storage live: a private repository, or local storage with a backup?
- Can the local Qodo review run inside a Codespace for live mode?
- Which open-source repository makes the best live audit: permissive licence, real tests, moderate size?
- Is it acceptable to publish blind spots of someone else's project, or should the maintainers be told first?

## 21. Final demo

**Act I. Break it. Review it.** Show the invariant and a passing control test. Trigger a named injection in a disposable environment. Show the real diff and the real Qodo output. Reveal the ground truth only after the review, and show whether Qodo detected it.

**Act II. Prove it.** Open the case file for a real finding. Show the generated test, the command, the output. Explain why the claim survived, was disproven, or stayed uncertain. Show the audit record and the real evaluation table: findings retained, noise reduced, and anything wrongly suppressed. If the evidence justifies it, show a proposed rule-change PR awaiting approval.

**Act III. Your code.** Run the audit live on a well-known open-source TypeScript project. Show the blind-spot matrix and one confirmed blind spot with its reproducing test. Then show the judges the one command and the Codespace link so they can try it themselves.

**Last line.** AI can produce code faster than humans can inspect it. FaultForge makes the factory prove what it knows, with Qodo as the independent reviewer and executable evidence as the final standard.

## 22. Positioning

**One sentence.** FaultForge is an adversarial quality lab that injects known defects, uses Qodo to review them, and demands executable proof before accepting or suppressing findings.

**Short pitch.** AI agents generate code quickly, but speed is not trust. FaultForge deliberately introduces testable defects into a small application, asks Qodo to review the changes, and measures what gets caught. Halfway through the build, Devil's Advocate adds a verification step: instead of arguing with review comments, it executes tests that support or challenge them. Every result is preserved in an audit trail, and the final report shows real detection, precision, and misses. Point it at your own repository and it shows the defects that both your tests and your reviewer would miss. The goal is a smaller, more trustworthy developer feedback loop, not another opinion-generating agent.

**Identity.** Name: FaultForge. Tagline: Break it. Review it. Prove it. Supporting line: An adversarial quality lab for AI software factories, powered by Qodo. Mid-month reveal: Devil's Advocate, demand proof, not opinion.

## 23. References

- Qodo Agentic Toolbox announcement, 9 September 2026: https://www.qodo.ai/blog/introducing-qodos-agentic-toolbox/
- Qodo-maintained review skill documenting local JSON review and possible preview gating: https://github.com/qodo-ai/qodo-skills/blob/main/packages/qodo/skills/qodo-review/SKILL.md
- Qodo configuration documentation: https://docs.qodo.ai/qodo-documentation/code-review/get-started/configuration-overview/configuration-file

Every documented capability is verified against the installed CLI and the account's actual entitlements before anything depends on it. The event's daily prompts and any official rubric are recorded in the decision log as they arrive.

---

## Charter control

**Locked:** north-star goal, evidence-first principle, Qodo as independent reviewer, private ground truth, frozen benchmark configuration, honest measurement, reproducible final demo, judge access without a Qodo account, one engine for judges, users, and the later app.

**Adaptable:** daily ordering, technology details, mutation templates, UI, integration path, stretch features.

**Change policy:** any significant pivot states which hypothesis or outcome it improves, what was dropped, and how benchmark integrity is preserved.

**Changes since 2.1:**

- **2.2, 6 November 2026 (Day 3).** The charter, the full 30-day plan and every work ticket are public, including Devil's Advocate and the arbiter. *Improves:* judges can check from Day 3 that the plan and method came before any results. *Dropped:* the Day 15 surprise. *Integrity:* the answer key, raw evidence and the templates of cases not yet reviewed stay in private storage, because a reviewer that could read them would make every result meaningless. A template is published once its case is adjudicated. Held-out benchmark templates are published with the final report.

**North star:** build a software factory that does not merely claim to be trustworthy. It can show the evidence.
