import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiKey, parseToolText, QodoTransport } from "./qodo-transport.ts";

const KEY = "sk-test-0123456789abcdef0123456789abcdef";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("apiKey (audit N-6)", () => {
  it("falls back to the key file when QODO_API_KEY is empty", () => {
    const file = join(mkdtempSync(join(tmpdir(), "qodo-key-")), "key.txt");
    writeFileSync(file, `${KEY}\n`);
    expect(apiKey({ QODO_API_KEY: "", QODO_KEY_FILE: file })).toBe(KEY);
    expect(apiKey({ QODO_API_KEY: "  ", QODO_KEY_FILE: file })).toBe(KEY);
    expect(apiKey({ QODO_API_KEY: KEY })).toBe(KEY);
    expect(() => apiKey({})).toThrow(/QODO_API_KEY/);
  });
});

describe("parseToolText (audit N-7)", () => {
  it("throws for a result with no text, never returns null as data", () => {
    expect(() => parseToolText({ content: [] })).toThrow(/no text/);
    expect(() => parseToolText({})).toThrow(/no text/);
    expect(parseToolText({ content: [{ type: "text", text: '{"a":1}' }] })).toEqual({ a: 1 });
  });

  it("throws a tool error with its text, or says it had none", () => {
    expect(() => parseToolText({ isError: true, content: [{ type: "text", text: "bad" }] })).toThrow(/bad/);
    expect(() => parseToolText({ isError: true })).toThrow(/no text/);
  });
});

describe("QodoTransport: the key never reaches an error or saved evidence (audit N-6)", () => {
  it("redacts the key before cutting an HTTP error short, and in the saved body", async () => {
    vi.stubEnv("QODO_API_KEY", KEY);
    // The key sits across the 300-character cut: cut first, then redact, would leave half of it.
    const body = `${"x".repeat(290)}${KEY} tail`;
    vi.stubGlobal("fetch", async () => new Response(body, { status: 401 }));
    const transport = new QodoTransport();
    const error = await transport.callTool("any").catch((e: Error) => e);
    expect(String(error)).not.toContain(KEY.slice(0, 10));
    expect(transport.lastRaw).not.toContain(KEY);
    expect(transport.lastRaw).toContain("***");
  });
});
