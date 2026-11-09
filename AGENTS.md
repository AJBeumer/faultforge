# FaultForge

FaultForge measures how well an AI code reviewer catches planted bugs. This repository holds the
harness: TypeScript scripts that plant bugs in a separate target repository, capture the reviewer's
answers as evidence, and score them against a private answer key.

## Setup and checks

- Node 22 or newer, then `npm install`.
- `npm run check` — typecheck, lint (Biome) and tests. It must pass before every commit.
- `npm run format` — apply Biome's formatting and safe fixes.

## Rules

### 1. Evidence capture is fail-safe and complete

Code that records an external system's answers as evidence (Qodo's API, GitHub comments and
reviews, CI results) must save the raw response before parsing it; read every page of anything
paginated, and every endpoint that can hold the data it claims to record; never write an error
response as if it were data; and never report its step complete unless the evidence save
succeeded. A deliberately bounded read (such as checking only whether the newest item exists) must
say so in a comment, and its result must not be recorded as evidence.

**Where it applies:** `packages/harness/src/**`, and skill steps that orchestrate evidence capture.

**Why:** every published number must trace back to saved evidence. Ten of the 24 findings on this
repository's first reviewed pull requests were variants of one failure: evidence silently lost
(unread pages, unread endpoints, unsaved comment edits) or a failure recorded as if it were data.
A capture that loses answers turns "measured" into "guessed", and when evidence is missing this
project's answer must be "inconclusive", never "safe".
