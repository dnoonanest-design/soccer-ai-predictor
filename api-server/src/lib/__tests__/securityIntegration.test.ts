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
    for (const path of [
      "/api/ai/run-learning-cycle",
      "/api/ai/generate-biweekly-update",
      "/api/background/run/recalibrate",
      "/api/background/run/biweekly-ai-update",
      "/api/background/run/settle",
      "/api/background/run/circumstance-analysis",
      "/api/live/alerts",
    ]) {
      const response = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(response.status, path).toBe(401);
    }
  });

  it("blocks admin routes reached through a trailing slash or different letter case", async () => {
    for (const path of [
      "/api/training/run/",
      "/api/Training/run",
      "/api/TRAINING/RUN/",
      "/api/outcomes/settle-finished/",
      "/api/push/test/",
      "/api/tracker/",
      "/api/ai/run-learning-cycle/",
    ]) {
      const response = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(response.status, path).toBe(401);
    }
  });

  it("keeps the training data export behind the admin key", async () => {
    for (const path of ["/api/training/dataset", "/api/Training/Dataset/"]) {
      const response = await fetch(`${baseUrl}${path}`);
      expect(response.status, path).toBe(401);
    }
  });

  it("shows health status publicly but hides operational detail", async () => {
    const response = await fetch(`${baseUrl}/api/healthz`);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body).not.toHaveProperty("quota_optimisation");
  });

  it("rejects malformed push subscriptions", async () => {
    const response = await fetch(`${baseUrl}/api/push/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: "javascript:alert(1)" }),
    });
    expect(response.status).toBe(400);
  });

  it("does not reset the admin rate limit when the client fakes X-Forwarded-For", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 15; i++) {
      const response = await fetch(`${baseUrl}/api/training/run`, {
        method: "POST",
        headers: { "X-Admin-Key": `wrong-${i}`, "X-Forwarded-For": `203.0.113.${i}, 198.51.100.7` },
      });
      statuses.push(response.status);
    }
    expect(statuses).toContain(429);
  });
});
