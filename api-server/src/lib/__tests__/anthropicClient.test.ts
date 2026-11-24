import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../logger", () => ({ logger: { warn: () => {}, info: () => {}, debug: () => {} } }));
const { pauseForFailure, callClaude, claudeStatus, __resetClaudePause } = await import("../anthropicClient");

describe("Claude client", () => {
  afterEach(() => { __resetClaudePause(); vi.unstubAllGlobals(); delete process.env.ANTHROPIC_API_KEY; });

  it("pauses for a long time on billing or key errors and briefly when busy", () => {
    const long = pauseForFailure(400, "invalid_request_error", "Your credit balance is too low to access the Anthropic API.");
    expect(long).toBeGreaterThan(60 * 60_000);
    expect(pauseForFailure(401, "authentication_error", "invalid x-api-key")).toBe(long);
    expect(pauseForFailure(429, "rate_limit_error", "")).toBe(5 * 60_000);
    expect(pauseForFailure(400, "invalid_request_error", "max_tokens too large")).toBe(0);
  });

  it("stops calling after a billing error and never logs or returns the key", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-123";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "Your credit balance is too low" } }), { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    const first = await callClaude("hi", 100, "test");
    expect(first.text).toBeNull();
    expect(first.paused).toBe(true);
    expect(first.error).toContain("credit balance");
    expect(first.error).not.toContain("sk-ant-test-123");
    const second = await callClaude("hi", 100, "test");
    expect(second.paused).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(claudeStatus().pausedUntil).not.toBeNull();
  });

  it("reads only text blocks and rejects a cut-off reply", async () => {
    process.env.ANTHROPIC_API_KEY = "k";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "Hello." }] }))));
    expect((await callClaude("hi", 100, "test")).text).toBe("Hello.");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ stop_reason: "max_tokens", content: [{ type: "text", text: "Hal" }] }))));
    expect((await callClaude("hi", 100, "test")).text).toBeNull();
  });
});
