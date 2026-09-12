const LEAGUE_STRENGTH: Record<number, number> = {
  39: 1.18, 40: 1.04, // England
  140: 1.14, 141: 1.00, // Spain
  135: 1.14, 136: 1.00, // Italy
  78: 1.13, 79: 0.99, // Germany
  61: 1.10, 62: 0.97, // France
  94: 1.05, 95: 0.94, // Portugal
  88: 1.04, 89: 0.93, // Netherlands
  203: 0.96, 204: 0.88, // Turkey
};

const COUNTRY_STRENGTH: Record<string, number> = {
  england: 1.18, spain: 1.14, italy: 1.14, germany: 1.13,
  france: 1.10, portugal: 1.05, netherlands: 1.04,
  turkey: 0.96, belgium: 0.97, austria: 0.94,
  scotland: 0.93, switzerland: 0.92, denmark: 0.91,
  norway: 0.89, sweden: 0.88, poland: 0.87,
  czechia: 0.91, "czech republic": 0.91, ukraine: 0.91,
  greece: 0.90, croatia: 0.89, serbia: 0.88,
  azerbaijan: 0.78,
};

const UEFA_IDS = new Set([2, 3, 848]);

/**
 * THE MANCHESTER RULE
 *
 * A result earned in a strong league or cup is not equivalent evidence to the
 * same scoreline earned in a materially weaker competition. Every historical
 * performance must therefore carry its competition-strength context, and
 * cross-league predictions must compare those contexts before probabilities
 * are calculated. Sparse samples are always shrunk toward neutral.
 */
export const MANCHESTER_RULE = "competition-strength-v1" as const;

export function competitionStrengthIndex(
  leagueId: number | null | undefined,
  leagueName = "",
  country = "",
): number {
  const id = Number(leagueId);
  if (LEAGUE_STRENGTH[id]) return LEAGUE_STRENGTH[id];
  if (UEFA_IDS.has(id)) return 1;

  const countryKey = country.trim().toLowerCase();
  if (COUNTRY_STRENGTH[countryKey]) return COUNTRY_STRENGTH[countryKey];

  const text = `${leagueName} ${country}`.toLowerCase();
  for (const [key, value] of Object.entries(COUNTRY_STRENGTH)) {
    if (text.includes(key)) return value;
  }
  return 0.82;
}

export function relativeStrengthAdjustment(
  homeIndex: number,
  awayIndex: number,
  homeSampleSize = 5,
  awaySampleSize = 5,
) {
  // Shrink sparse estimates toward neutral rather than applying a strong
  // cross-league correction from only one or two historical fixtures.
  const homeReliability = Math.max(0, Math.min(1, homeSampleSize / 5));
  const awayReliability = Math.max(0, Math.min(1, awaySampleSize / 5));
  const homeEstimate = 1 + ((homeIndex || 1) - 1) * homeReliability;
  const awayEstimate = 1 + ((awayIndex || 1) - 1) * awayReliability;
  const home = Math.max(0.65, Math.min(1.25, homeEstimate));
  const away = Math.max(0.65, Math.min(1.25, awayEstimate));
  // Use the relative index directly: taking its square root understated major
  // cross-league gaps and reproduced the PSG/Manchester United failure mode.
  const ratio = home / away;
  return {
    home: Math.max(0.72, Math.min(1.4, ratio)),
    away: Math.max(0.72, Math.min(1.4, 1 / ratio)),
  };
}

export function manchesterRulePerformanceWeight(strengthIndex: number) {
  const safeStrength = Math.max(0.65, Math.min(1.25, strengthIndex || 1));
  // A square-root weight values stronger opposition without allowing the raw
  // league prior to overwhelm the actual result. The cross-team comparison is
  // applied separately by relativeStrengthAdjustment.
  return Math.sqrt(safeStrength);
}

export function isUefaCompetition(leagueId: number) {
  return UEFA_IDS.has(leagueId);
}
