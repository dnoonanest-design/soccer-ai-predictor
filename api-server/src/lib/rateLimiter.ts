// Single global request queue shared across ALL services.
// Import waitForRateLimit wherever you make API-Football calls.

let requestChain = Promise.resolve();

export function waitForRateLimit(): Promise<void> {
  const slot = requestChain.then(
    () => new Promise<void>(r => setTimeout(r, 150))
  );
  requestChain = slot;
  return slot;
}
