/**
 * Push live changes to open screens instead of waiting for their next poll.
 *
 * GET /api/live/stream is a Server-Sent Events stream. Every few seconds the
 * server compares a cheap fingerprint of the live matches (status, minute,
 * score, from the 15-second live cache) and the time of the newest stored live
 * prediction; when either changes it sends one event, and the browser refreshes
 * only the live data it is showing. Polling stays on as a fallback.
 */
let predictionVersion = 0;
let predictionAt = 0;

/** Called when a live prediction reading is stored. */
export function noteLivePrediction(): void {
  predictionVersion++;
  predictionAt = Date.now();
}

export type LiveMatchState = { id: number; status: string; minute: number | null; home: number | null; away: number | null };

/** Pure: a short fingerprint of what a live screen shows. */
export function liveFingerprint(matches: LiveMatchState[], version: number): string {
  return `${version}|` + matches
    .map((m) => `${m.id}:${m.status}:${m.minute ?? ""}:${m.home ?? ""}-${m.away ?? ""}`)
    .sort()
    .join(",");
}

export function livePredictionState() {
  return { version: predictionVersion, at: predictionAt };
}
