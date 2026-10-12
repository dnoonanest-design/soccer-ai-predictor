import { describe, expect, it } from "vitest";
import { setBounded } from "../boundedCache";

describe("setBounded", () => {
  it("never grows past its cap and drops the oldest entries first", () => {
    const cache = new Map<string, number>();
    for (let i = 0; i < 10; i++) setBounded(cache, `k${i}`, i, 3);
    expect(cache.size).toBe(3);
    expect([...cache.keys()]).toEqual(["k7", "k8", "k9"]);
  });

  it("keeps a rewritten entry as the newest", () => {
    const cache = new Map<string, number>();
    setBounded(cache, "a", 1, 2);
    setBounded(cache, "b", 2, 2);
    setBounded(cache, "a", 3, 2);
    setBounded(cache, "c", 4, 2);
    expect([...cache.entries()]).toEqual([["a", 3], ["c", 4]]);
  });
});
