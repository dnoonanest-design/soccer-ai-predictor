export const PREMATCH_STATUSES = new Set(["upcoming", "scheduled", "not_started", "ns", "tbd"]);

export function isPredictionWriteAllowed(input: {
  isLive: boolean;
  status?: string | null;
  kickoffAt?: Date | null;
  outcomeExists: boolean;
  now?: Date;
}): boolean {
  if (input.outcomeExists) return false;
  if (input.isLive) return input.status == null || input.status.toLowerCase() === "live";
  if (input.status && !PREMATCH_STATUSES.has(input.status.toLowerCase())) return false;
  if (!input.kickoffAt || Number.isNaN(input.kickoffAt.getTime())) return false;
  return input.kickoffAt.getTime() > (input.now ?? new Date()).getTime();
}

export const LEAKAGE_POLICY =
  "A fixture's prediction may use only information available before its prediction timestamp. " +
  "Its own outcome and later match statistics are forbidden inputs.";
