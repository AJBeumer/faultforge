/**
 * Runs before every test file. The door's run gate (`target-post-run.ts`, #347) reads a marker at a fixed path,
 * which a real factory run writes while its agent works, and the agent runs this repo's tests in that run. Each
 * test file gets a marker path of its own, with no file there, so the door's tests read "no run" unless a test
 * simulates one, whatever runs on the machine at the time.
 */
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useRunMarker } from "./packages/harness/src/target-post-run.ts";

useRunMarker(join(tmpdir(), `door-run-${process.pid}-${randomBytes(6).toString("hex")}.json`));
