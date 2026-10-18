import { describe, expect, it } from "vitest";
import { parseLeagueIdQuery } from "../matches";

describe("match route league query", () => {
  it("treats a serialized null filter as no league filter", () => {
    expect(parseLeagueIdQuery("null")).toBeNull();
    expect(parseLeagueIdQuery(null)).toBeNull();
    expect(parseLeagueIdQuery(undefined)).toBeNull();
  });

  it("keeps valid league IDs and rejects malformed values", () => {
    expect(parseLeagueIdQuery("39")).toBe(39);
    expect(Number.isNaN(parseLeagueIdQuery("not-a-league"))).toBe(true);
  });
});
