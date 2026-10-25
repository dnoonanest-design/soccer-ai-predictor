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

/**
 * Fixed pre-match checkpoints, in hours before kickoff. Between 3 days and
 * 1 day out the odds are read once at each checkpoint (not every 2 hours);
 * from 1 day out the match-day cadence above applies.
 */
export const PREMATCH_CHECKPOINT_HOURS = [72, 48, 24] as const;
/** A read up to this many hours before a checkpoint counts for it, so one league call covers nearby matches. */
export const CHECKPOINT_EARLY_HOURS = 3;
/** Earliest point the sampler looks at a fixture. */
export const CHECKPOINT_WINDOW_HOURS = PREMATCH_CHECKPOINT_HOURS[0] + CHECKPOINT_EARLY_HOURS;

/**
 * Whether a fixture's odds should be read now.
 * @param hoursToKickoff hours from now to kickoff
 * @param latestHoursBeforeKickoff when the latest stored read was taken, in hours before kickoff (null if none)
 * @param msSinceLatest milliseconds since that read
 */
export function isOddsCaptureDue(hoursToKickoff: number, latestHoursBeforeKickoff: number | null, msSinceLatest: number | null): boolean {
  if (!Number.isFinite(hoursToKickoff) || hoursToKickoff <= 0 || hoursToKickoff > CHECKPOINT_WINDOW_HOURS) return false;
  if (hoursToKickoff > PREMATCH_CHECKPOINT_HOURS[PREMATCH_CHECKPOINT_HOURS.length - 1]) {
    // The checkpoint whose window we are in (or the most recent one passed, if it was missed).
    const checkpoint = [...PREMATCH_CHECKPOINT_HOURS].reverse().find((c) => hoursToKickoff <= c + CHECKPOINT_EARLY_HOURS)
      ?? PREMATCH_CHECKPOINT_HOURS[0];
    return latestHoursBeforeKickoff == null || latestHoursBeforeKickoff > checkpoint + CHECKPOINT_EARLY_HOURS;
  }
  if (latestHoursBeforeKickoff == null || msSinceLatest == null) return true;
  return msSinceLatest >= oddsSnapshotCadenceMs(hoursToKickoff);
}

/** Label for a read taken this many hours before kickoff. */
export function checkpointLabel(hoursBeforeKickoff: number): string {
  if (hoursBeforeKickoff >= 60) return "3 days";
  if (hoursBeforeKickoff >= 36) return "2 days";
  if (hoursBeforeKickoff >= 18) return "1 day";
  return "match day";
}
