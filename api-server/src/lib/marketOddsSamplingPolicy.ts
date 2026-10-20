export const ODDS_CAPTURE_KICKOFF_CUTOFF_MS = 60_000;

export function oddsSnapshotCadenceMs(hoursToKickoff: number) {
  if (hoursToKickoff <= 1 / 12) return 60_000; // final five minutes
  if (hoursToKickoff <= 1) return 5 * 60_000;
  if (hoursToKickoff <= 6) return 15 * 60_000;
  if (hoursToKickoff <= 24) return 60 * 60_000;
  return 2 * 60 * 60_000;
}

export function isBeforeOddsCaptureCutoff(kickoffMs: number, nowMs: number) {
  return (
    Number.isFinite(kickoffMs) &&
    kickoffMs - nowMs > ODDS_CAPTURE_KICKOFF_CUTOFF_MS
  );
}
