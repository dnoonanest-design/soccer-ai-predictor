import { getTrackedCompetition } from "./leagueConfig";

type OrderableFixture = {
  id?: number;
  league_id: number;
  kickoff: string;
  status?: string | null;
  home_team?: { name?: string | null } | null;
  away_team?: { name?: string | null } | null;
};

export type CompetitionImportance = {
  rank: number;
  tier: "elite" | "major" | "national" | "standard";
  label: string;
};

const UEFA_IMPORTANCE = new Map<number, CompetitionImportance>([
  [2, { rank: 100, tier: "elite", label: "Elite European" }],
  [3, { rank: 90, tier: "major", label: "Major European" }],
  [848, { rank: 80, tier: "major", label: "European" }],
]);

/**
 * Product-facing fixture priority. This only controls presentation order; it
 * never changes model probabilities, calibration, or settlement.
 */
export function getCompetitionImportance(
  leagueId: number,
): CompetitionImportance {
  const uefa = UEFA_IMPORTANCE.get(Number(leagueId));
  if (uefa) return uefa;

  const competition = getTrackedCompetition(Number(leagueId));
  if (competition?.kind === "cup") {
    return { rank: 70, tier: "national", label: "Domestic Cup" };
  }
  if (competition?.tier === 1) {
    return { rank: 60, tier: "national", label: "Top Division" };
  }
  return { rank: 40, tier: "standard", label: "Second Division" };
}

const dublinDateFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Dublin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function kickoffTime(value: string) {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function dublinDateKey(milliseconds: number | null) {
  if (milliseconds == null) return "9999-12-31";
  const parts = dublinDateFormatter
    .formatToParts(new Date(milliseconds))
    .reduce<Record<string, string>>((result, part) => {
      if (part.type !== "literal") result[part.type] = part.value;
      return result;
    }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function statusRank(status: string | null | undefined) {
  if (status === "live") return 0;
  if (status === "upcoming") return 1;
  if (status === "finished") return 2;
  return 3;
}

export function compareFixturesForDisplay(
  a: OrderableFixture,
  b: OrderableFixture,
) {
  const kickoffA = kickoffTime(a.kickoff);
  const kickoffB = kickoffTime(b.kickoff);
  const dateA = dublinDateKey(kickoffA);
  const dateB = dublinDateKey(kickoffB);
  if (dateA !== dateB) return dateA.localeCompare(dateB);

  const urgency = statusRank(a.status) - statusRank(b.status);
  if (urgency !== 0) return urgency;

  const importance =
    getCompetitionImportance(b.league_id).rank -
    getCompetitionImportance(a.league_id).rank;
  if (importance !== 0) return importance;

  if (kickoffA !== kickoffB) {
    if (kickoffA == null) return 1;
    if (kickoffB == null) return -1;
    return kickoffA - kickoffB;
  }

  const teamsA = `${a.home_team?.name ?? ""}:${a.away_team?.name ?? ""}`;
  const teamsB = `${b.home_team?.name ?? ""}:${b.away_team?.name ?? ""}`;
  const byTeams = teamsA.localeCompare(teamsB);
  return byTeams || Number(a.id ?? 0) - Number(b.id ?? 0);
}

export function sortFixturesForDisplay<T extends OrderableFixture>(
  fixtures: T[],
): T[] {
  return [...fixtures].sort(compareFixturesForDisplay);
}
