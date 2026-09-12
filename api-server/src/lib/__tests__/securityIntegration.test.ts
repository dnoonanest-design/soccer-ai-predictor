import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("ADMIN_SECRET", "integration-test-secret");
  vi.stubEnv("DATABASE_URL", "postgresql://test:test@127.0.0.1:5432/test");
  const { default: app } = await import("../../app");
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  vi.unstubAllEnvs();
});

describe("application security boundary", () => {
  it("adds browser security headers to public responses", async () => {
    const response = await fetch(`${baseUrl}/api/healthz`);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("x-powered-by")).toBeNull();
  });

  it("does not grant CORS access to an unknown origin", async () => {
    const response = await fetch(`${baseUrl}/api/healthz`, {
      headers: { Origin: "https://attacker.example" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("blocks privileged mutations without the configured admin key", async () => {
    const response = await fetch(`${baseUrl}/api/ai/run-learning-cycle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(401);
  });
});
