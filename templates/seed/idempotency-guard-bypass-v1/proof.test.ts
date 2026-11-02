/**
 * Hidden proof test for INV-IDEMP-001. Never copied into the target repository.
 * Runs against the target checkout named by FAULTFORGE_TARGET_DIR.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const targetDir = process.env.FAULTFORGE_TARGET_DIR;
if (!targetDir) throw new Error("FAULTFORGE_TARGET_DIR is not set");

const load = (path: string) => import(pathToFileURL(join(targetDir, path)).href);
const { buildApp } = await load("src/app.ts");
const { fixedClock } = await load("src/deps.ts");
const { BookingStore } = await load("src/store.ts");

const request = {
  method: "POST",
  url: "/bookings",
  headers: { "x-user-id": "user-alice", "idempotency-key": "proof-key-1" },
  payload: { resourceId: "room-101", startDate: "2026-11-05", endDate: "2026-11-06", guests: 1 },
};

describe("INV-IDEMP-001: reusing an idempotency key never creates a second booking", () => {
  it("returns the original booking and stores exactly one", async () => {
    const store = new BookingStore();
    const app = buildApp({ deps: { store, clock: fixedClock("2026-11-02T09:00:00Z") } });

    const first = await app.inject(request);
    const second = await app.inject(request);

    expect(first.statusCode).toBe(201);
    expect(second.json().id).toBe(first.json().id);
    expect(store.countBookings()).toBe(1);
  });
});
