/**
 * Hidden proof test for INV-AUTH-001, the collateral FF-0001 recorded. Never copied into the target
 * repository. Runs against the target checkout named by FAULTFORGE_TARGET_DIR.
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

describe("INV-AUTH-001: a replay never hands back another user's booking", () => {
  it("a key equal to another user's booking id still returns only the caller's own booking", async () => {
    const store = new BookingStore();
    const app = buildApp({ deps: { store, clock: fixedClock("2026-11-02T09:00:00Z") } });

    const bob = await app.inject({
      method: "POST",
      url: "/bookings",
      headers: { "x-user-id": "user-bob", "idempotency-key": "bob-key-1" },
      payload: { resourceId: "room-101", startDate: "2026-11-05", endDate: "2026-11-06", guests: 1 },
    });
    expect(bob.statusCode).toBe(201);
    const bobsBookingId = bob.json().id;

    const alicesRequest = {
      method: "POST",
      url: "/bookings",
      headers: { "x-user-id": "user-alice", "idempotency-key": bobsBookingId },
      payload: { resourceId: "room-102", startDate: "2026-11-06", endDate: "2026-11-07", guests: 2 },
    };

    const first = await app.inject(alicesRequest);
    expect(first.statusCode).toBe(201);
    const alicesBookingId = first.json().id;
    expect(alicesBookingId).not.toBe(bobsBookingId);

    const replay = await app.inject(alicesRequest);
    expect(replay.json().id).toBe(alicesBookingId);
    expect(replay.json().userId).toBe("user-alice");
  });
});
