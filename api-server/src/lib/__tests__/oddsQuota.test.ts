import { beforeEach, describe, expect, it } from "vitest";
import { __resetOddsQuotaForTests, getOddsOptimizationStatus, LOW_CREDIT_PROBE_MS, observeQuota, requestAllowed } from "../oddsOptimizationService";

describe("odds quota observation", () => {
  beforeEach(() => __resetOddsQuotaForTests());

  it("treats missing quota headers as unknown, not zero credits", () => {
    observeQuota(new Headers()); // e.g. an HTTP 502 from a gateway
    expect(getOddsOptimizationStatus().provider.remaining).toBeNull();
    expect(requestAllowed("full", undefined, Date.now(), 1)).toBe(true);
  });

  it("keeps the last real reading when a later response has no headers", () => {
    observeQuota(new Headers({ "x-requests-used": "1200", "x-requests-remaining": "18800", "x-requests-last": "1" }));
    observeQuota(new Headers());
    expect(getOddsOptimizationStatus().provider.remaining).toBe(18800);
    expect(getOddsOptimizationStatus().provider.total).toBe(20000);
  });

  it("at the credit reserve, allows one quota probe per half hour", () => {
    observeQuota(new Headers({ "x-requests-used": "20000", "x-requests-remaining": "0" }));
    const now = Date.now();
    expect(requestAllowed("critical", undefined, now, 1)).toBe(true);
    expect(requestAllowed("critical", undefined, now + 60_000, 1)).toBe(false);
    expect(requestAllowed("critical", undefined, now + LOW_CREDIT_PROBE_MS, 1)).toBe(true);
  });
});
