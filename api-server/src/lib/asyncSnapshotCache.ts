export type SnapshotCacheStatus = {
  entries: number;
  inFlight: number;
  hits: number;
  staleHits: number;
  misses: number;
  coalesced: number;
  loads: number;
  failures: number;
};

type SnapshotEntry<T> = {
  value: T;
  expiresAt: number;
};

/**
 * Small process-local read-through cache that also coalesces concurrent loads.
 * A failed refresh never replaces the last successful snapshot.
 */
export class AsyncSnapshotCache<K, V> {
  private readonly entries = new Map<K, SnapshotEntry<V>>();
  private readonly inFlight = new Map<K, Promise<V>>();
  private hits = 0;
  private staleHits = 0;
  private misses = 0;
  private coalesced = 0;
  private loads = 0;
  private failures = 0;

  constructor(
    private readonly ttlForKey: (key: K) => number,
    private readonly maxEntries = 20,
    private readonly maxStaleForKey: (key: K) => number = () => 0,
  ) {}

  async get(key: K, loader: () => Promise<V>): Promise<V> {
    const now = Date.now();
    const cached = this.entries.get(key);
    if (cached && cached.expiresAt > now) {
      this.hits++;
      return cached.value;
    }

    if (cached && cached.expiresAt + Math.max(0, this.maxStaleForKey(key)) > now) {
      this.staleHits++;
      if (!this.inFlight.has(key)) {
        const refresh = this.load(key, loader);
        this.inFlight.set(key, refresh);
        void refresh.finally(() => this.inFlight.delete(key)).catch(() => {});
      } else {
        this.coalesced++;
      }
      return cached.value;
    }

    const pending = this.inFlight.get(key);
    if (pending) {
      this.coalesced++;
      return pending;
    }

    this.misses++;
    const work = this.load(key, loader);

    this.inFlight.set(key, work);
    try {
      return await work;
    } finally {
      this.inFlight.delete(key);
    }
  }

  status(): SnapshotCacheStatus {
    return {
      entries: this.entries.size,
      inFlight: this.inFlight.size,
      hits: this.hits,
      staleHits: this.staleHits,
      misses: this.misses,
      coalesced: this.coalesced,
      loads: this.loads,
      failures: this.failures,
    };
  }

  private async load(key: K, loader: () => Promise<V>): Promise<V> {
    this.loads++;
    try {
      const value = await loader();
      this.entries.set(key, {
        value,
        expiresAt: Date.now() + Math.max(0, this.ttlForKey(key)),
      });
      this.prune();
      return value;
    } catch (error) {
      this.failures++;
      throw error;
    }
  }

  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt + Math.max(0, this.maxStaleForKey(key)) <= now) {
        this.entries.delete(key);
      }
    }
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as K | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
