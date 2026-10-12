/**
 * In-memory caches across the services store entries with a timestamp and
 * check freshness on read, but never removed old entries, so memory grew for
 * as long as the process ran. setBounded writes an entry and, once the map
 * exceeds its cap, drops the least recently written entries first.
 *
 * Re-inserting a key moves it to the newest position (Map keeps insertion
 * order), so frequently refreshed entries survive and stale ones age out.
 */
export function setBounded<K, V>(map: Map<K, V>, key: K, value: V, maxEntries: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > maxEntries) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

/** Per-fixture/team caches: comfortably above ~600 tracked fixtures x several endpoints. */
export const DEFAULT_CACHE_MAX_ENTRIES = 3000;
/** Raw provider responses can be large, so this cache gets a tighter cap. */
export const PROVIDER_RESPONSE_CACHE_MAX_ENTRIES = 2000;
