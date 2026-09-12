import { describe, expect, it } from "vitest";
import {
  ApiFootballProviderError,
  classifyApiFootballFailure,
  isApiFootballProviderError,
} from "../apiFootballReliability";

describe("API-Football reliability classification", () => {
  it("treats suspended/authentication failures as offline", () => {
    expect(
      classifyApiFootballFailure(
        "Your account is suspended, check on the API-Football dashboard.",
      ),
    ).toEqual({ kind: "authentication", state: "offline" });

    expect(classifyApiFootballFailure("Forbidden", 403)).toEqual({
      kind: "authentication",
      state: "offline",
    });
  });

  it("treats plan and season-access failures as offline subscription failures", () => {
    expect(
      classifyApiFootballFailure(
        "Free plans do not have access to this season, try an older season.",
      ),
    ).toEqual({ kind: "subscription", state: "offline" });
  });

  it("treats quota and transient provider failures as degraded rather than empty data", () => {
    expect(classifyApiFootballFailure("Too many requests", 429)).toEqual({
      kind: "rate_limit",
      state: "degraded",
    });
    expect(classifyApiFootballFailure("Upstream unavailable", 503)).toEqual({
      kind: "provider",
      state: "degraded",
    });
  });

  it("identifies typed provider errors for route-level 503 handling", () => {
    const error = new ApiFootballProviderError("provider unavailable", {
      path: "/fixtures?live=all",
      kind: "provider",
      httpStatus: 503,
    });

    expect(isApiFootballProviderError(error)).toBe(true);
    expect(error.path).toBe("/fixtures?live=all");
    expect(error.kind).toBe("provider");
  });
});
