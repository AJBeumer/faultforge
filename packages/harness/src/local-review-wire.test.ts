import { describe, expect, it } from "vitest";
import { callAndSaveRaw, type RawCapture, unwrapResult } from "./local-review-wire.ts";

function fakeApi(overrides: Partial<RawCapture> = {}): RawCapture {
  return {
    call: async () => ({ ok: true }),
    lastRaw: '{"ok":true}',
    lastRecoveredRaw: [],
    ...overrides,
  };
}

describe("callAndSaveRaw", () => {
  it("saves the raw answer, keyed by label, after a successful call", async () => {
    const saved: [string, string][] = [];
    const api = fakeApi();
    const result = await callAndSaveRaw(api, "start-pre-pr-review", {}, "submit", (name, data) =>
      saved.push([name, data]),
    );
    expect(result).toEqual({ ok: true });
    expect(saved).toEqual([["submit.raw.json", '{"ok":true}']]);
  });

  it("saves the raw body before rethrowing, instead of losing it to the error", async () => {
    const saved: [string, string][] = [];
    const api = fakeApi({
      call: async () => {
        throw new Error("Qodo tool error: not json");
      },
      lastRaw: '{"isError":true}',
    });
    await expect(
      callAndSaveRaw(api, "get-managed-agent-operation", {}, "poll-1", (name, data) => saved.push([name, data])),
    ).rejects.toThrow("not json");
    expect(saved).toEqual([["poll-1.error.raw.json", '{"isError":true}']]);
  });

  it("saves every recovered body from a dropped session, on success and on failure", async () => {
    const saved: [string, string][] = [];
    const okApi = fakeApi({ lastRecoveredRaw: ["recovered-1", "recovered-2"] });
    await callAndSaveRaw(okApi, "start-pre-pr-review", {}, "submit", (name, data) => saved.push([name, data]));
    expect(saved).toEqual([
      ["submit.recovered-0.raw.json", "recovered-1"],
      ["submit.recovered-1.raw.json", "recovered-2"],
      ["submit.raw.json", '{"ok":true}'],
    ]);

    saved.length = 0;
    const failingApi = fakeApi({
      call: async () => {
        throw new Error("boom");
      },
      lastRecoveredRaw: ["recovered-1"],
    });
    await expect(
      callAndSaveRaw(failingApi, "start-pre-pr-review", {}, "submit", (name, data) => saved.push([name, data])),
    ).rejects.toThrow("boom");
    expect(saved).toEqual([
      ["submit.recovered-0.raw.json", "recovered-1"],
      ["submit.error.raw.json", '{"ok":true}'],
    ]);
  });
});

describe("unwrapResult", () => {
  it("reads the review payload from the managed-agent envelope's output field", () => {
    const envelope = {
      agent_id: "a2a:pre-pr-review",
      output: JSON.stringify({ result: { findings: [] }, status: "completed" }),
    };
    expect(unwrapResult(JSON.stringify(envelope))).toEqual({ findings: [] });
  });

  it("throws when the envelope has no output field", () => {
    expect(() => unwrapResult(JSON.stringify({ agent_id: "x" }))).toThrow(/output/);
  });

  it("throws when output has no result field", () => {
    const envelope = { output: JSON.stringify({ status: "completed" }) };
    expect(() => unwrapResult(JSON.stringify(envelope))).toThrow(/result/);
  });
});
