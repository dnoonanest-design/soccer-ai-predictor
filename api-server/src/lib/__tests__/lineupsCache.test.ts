import { describe, expect, it } from "vitest";
import { LINEUPS_PENDING_TTL_MS, LINEUPS_PUBLISHED_TTL_MS, lineupsCacheTtl } from "../quotaOptimizationService";

const xi = Array.from({ length: 11 }, (_, i) => ({ player: { id: i + 1 } }));

describe("lineup answer caching", () => {
  it("re-checks every 2 minutes until both starting XIs are published", () => {
    expect(lineupsCacheTtl(JSON.stringify({ response: [] }))).toBe(LINEUPS_PENDING_TTL_MS);
    expect(lineupsCacheTtl(JSON.stringify({ response: [{ startXI: xi }] }))).toBe(LINEUPS_PENDING_TTL_MS);
    expect(lineupsCacheTtl(JSON.stringify({ response: [{ startXI: xi }, { startXI: xi.slice(0, 5) }] }))).toBe(LINEUPS_PENDING_TTL_MS);
    expect(lineupsCacheTtl("not json")).toBe(LINEUPS_PENDING_TTL_MS);
  });

  it("holds a published pair of lineups for 30 minutes", () => {
    expect(lineupsCacheTtl(JSON.stringify({ response: [{ startXI: xi }, { startXI: xi }] }))).toBe(LINEUPS_PUBLISHED_TTL_MS);
  });
});
