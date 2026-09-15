import { describe, expect, it, vi } from "vitest";
import { AsyncSnapshotCache } from "../asyncSnapshotCache";

describe("AsyncSnapshotCache", () => {
  it("coalesces concurrent loads and then serves the snapshot", async () => {
    let release!: (value: number) => void;
    const loader = vi.fn(() => new Promise<number>((resolve) => { release = resolve; }));
    const cache = new AsyncSnapshotCache<string, number>(() => 60_000);

    const first = cache.get("weekly", loader);
    const second = cache.get("weekly", loader);
    release(42);

    await expect(Promise.all([first, second])).resolves.toEqual([42, 42]);
    await expect(cache.get("weekly", loader)).resolves.toBe(42);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(cache.status()).toMatchObject({ hits: 1, misses: 1, coalesced: 1, loads: 1, failures: 0 });
  });

  it("does not cache failed loads", async () => {
    const cache = new AsyncSnapshotCache<string, number>(() => 60_000);
    const failed = vi.fn().mockRejectedValueOnce(new Error("provider unavailable"));
    await expect(cache.get("daily", failed)).rejects.toThrow("provider unavailable");

    await expect(cache.get("daily", async () => 7)).resolves.toBe(7);
    expect(cache.status()).toMatchObject({ misses: 2, loads: 2, failures: 1 });
  });

  it("serves bounded stale data while refreshing in the background", async () => {
    vi.useFakeTimers();
    try {
      const loader = vi.fn()
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(2);
      const cache = new AsyncSnapshotCache<string, number>(() => 1_000, 2, () => 5_000);

      await expect(cache.get("weekly", loader)).resolves.toBe(1);
      await vi.advanceTimersByTimeAsync(1_100);
      await expect(cache.get("weekly", loader)).resolves.toBe(1);
      await vi.runAllTimersAsync();
      await expect(cache.get("weekly", loader)).resolves.toBe(2);
      expect(cache.status()).toMatchObject({ staleHits: 1, loads: 2 });
    } finally {
      vi.useRealTimers();
    }
  });
});
