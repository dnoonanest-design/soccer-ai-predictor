/**
 * Cross-league strength model.
 *
 * League values are conservative, versioned cold-start priors. A club's own
 * completed results then move it away from that prior. The prior is never
 * presented as a live UEFA coefficient and must be replaced by learned,
 * time-valid ratings once enough settled cross-league evidence is available.
 */

export const STRENGTH_MODEL_VERSION = "cross-league-v1-2026-09";

export interface StrengthFixture {
  date?: string;
  leagueId?: number;
  leagueName?: string;
  country?: string;
  homeTeamId?: number;
  awayTeamId?: number;
  homeGoals?: number;
  awayGoals?: number;
  opponentRating?: number;
}

export interface TeamStrengthProfile {
  leagueRating: number;
  clubRating: number;
  scheduleRating: number;
  scheduleFactor: number;
  uncertainty: number;
  matchesUsed: number;
  domesticLeagueId: number | null;
  source: "domestic-history" | "country-prior" | "global-fallback";
  version: string;
}

export interface ThreeWayProbability {
  home: number;
  draw: number;
  away: number;
}

// Elo-like priors, centred on 1500. Gaps matter; absolute values do not.
// These are intentionally compressed so a league label cannot overwhelm
// strong club-level evidence. Domestic second divisions have separate priors.
const LEAGUE_RATINGS: Record<number, number> = {
  39: 1710, 40: 1515,
  140: 1680, 141: 1500,
  135: 1665, 136: 1495,
  78: 1660, 79: 1495,
  61: 1620, 62: 1475,
  94: 1550, 95: 1425,
  88: 1545, 89: 1420,
};

const COUNTRY_TOP_FLIGHT_RATINGS: Record<string, number> = {
  england: 1710, spain: 1680, italy: 1665, germany: 1660, france: 1620,
  portugal: 1550, netherlands: 1545, belgium: 1480, turkey: 1470,
  austria: 1450, scotland: 1440, switzerland: 1430, greece: 1420,
  denmark: 1410, norway: 1390, sweden: 1385, poland: 1380,
  czechia: 1380, "czech republic": 1380, croatia: 1370, ukraine: 1370,
  serbia: 1360, romania: 1350, slovakia: 1340, slovenia: 1330,
  hungary: 1330, bulgaria: 1320, ireland: 1260, iceland: 1250,
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeCountry(country?: string): string {
  return (country ?? "").trim().toLowerCase();
}

export function isContinentalCompetition(leagueId?: number, leagueName?: string): boolean {
  if (leagueId === 2 || leagueId === 3 || leagueId === 848) return true;
  const name = (leagueName ?? "").toLowerCase();
  return name.includes("champions league") || name.includes("europa league") || name.includes("conference league");
}

function isDomesticCup(name?: string): boolean {
  const value = (name ?? "").toLowerCase();
  return value.includes("cup") || value.includes("copa") || value.includes("pokal") ||
    value.includes("coupe") || value.includes("taça") || value.includes("taca");
}

export function leagueRating(leagueId?: number, country?: string): number {
  if (leagueId && LEAGUE_RATINGS[leagueId]) return LEAGUE_RATINGS[leagueId];
  return COUNTRY_TOP_FLIGHT_RATINGS[normalizeCountry(country)] ?? 1300;
}

function fixtureWeight(date: string | undefined, index: number, count: number, anchorMs: number): number {
  const parsed = date ? Date.parse(date) : Number.NaN;
  const ageDays = Number.isFinite(parsed) ? Math.max(0, (anchorMs - parsed) / 86_400_000) : (count - index) * 7;
  return Math.pow(0.5, ageDays / 120);
}

export function buildTeamStrengthProfile(fixtures: StrengthFixture[], teamId: number, asOf: Date = new Date()): TeamStrengthProfile {
  const asOfMs = asOf.getTime();
  const valid = fixtures.filter((fixture) => {
    const isTeam = fixture.homeTeamId === teamId || fixture.awayTeamId === teamId;
    const playedAt = Date.parse(fixture.date ?? "");
    const timeValid = !Number.isFinite(playedAt) || playedAt < asOfMs;
    return isTeam && timeValid && Number.isFinite(fixture.homeGoals) && Number.isFinite(fixture.awayGoals);
  });

  const domestic = valid.filter((fixture) =>
    !isContinentalCompetition(fixture.leagueId, fixture.leagueName) && !isDomesticCup(fixture.leagueName),
  );
  const candidates = domestic.length > 0 ? domestic : valid.filter((fixture) => !isContinentalCompetition(fixture.leagueId, fixture.leagueName));
  const counts = new Map<number, { count: number; country?: string }>();
  for (const fixture of candidates) {
    const id = Number(fixture.leagueId ?? 0);
    if (!id) continue;
    const current = counts.get(id) ?? { count: 0, country: fixture.country };
    current.count += 1;
    if (!current.country) current.country = fixture.country;
    counts.set(id, current);
  }
  const inferred = [...counts.entries()].sort((a, b) => b[1].count - a[1].count)[0];
  const fallbackCountry = candidates.find((fixture) => fixture.country)?.country ?? valid.find((fixture) => fixture.country)?.country;
  const domesticLeagueId = inferred?.[0] ?? null;
  const inferredCountry = inferred?.[1].country ?? fallbackCountry;
  const baseRating = leagueRating(domesticLeagueId ?? undefined, inferredCountry);

  let weightedPoints = 0;
  let weightedGoalDifference = 0;
  let totalWeight = 0;
  let weightedSchedule = 0;
  const dated = valid.map((fixture) => Date.parse(fixture.date ?? "")).filter(Number.isFinite);
  const anchorMs = dated.length > 0 ? Math.max(...dated) : Date.now();
  valid.forEach((fixture, index) => {
    const wasHome = fixture.homeTeamId === teamId;
    const goalsFor = wasHome ? Number(fixture.homeGoals) : Number(fixture.awayGoals);
    const goalsAgainst = wasHome ? Number(fixture.awayGoals) : Number(fixture.homeGoals);
    const weight = fixtureWeight(fixture.date, index, valid.length, anchorMs);
    const points = goalsFor > goalsAgainst ? 3 : goalsFor === goalsAgainst ? 1 : 0;
    const opponentRating = Number.isFinite(fixture.opponentRating)
      ? Number(fixture.opponentRating)
      : isContinentalCompetition(fixture.leagueId, fixture.leagueName)
        ? 1500
        : leagueRating(fixture.leagueId, fixture.country);
    weightedPoints += points * weight;
    weightedGoalDifference += clamp(goalsFor - goalsAgainst, -3, 3) * weight;
    weightedSchedule += opponentRating * weight;
    totalWeight += weight;
  });

  const matchesUsed = valid.length;
  const evidence = clamp(matchesUsed / 10, 0, 1);
  const pointsPerGame = totalWeight > 0 ? weightedPoints / totalWeight : 1.35;
  const goalDifference = totalWeight > 0 ? weightedGoalDifference / totalWeight : 0;
  const performanceAdjustment = clamp((pointsPerGame - 1.35) * 45 + goalDifference * 38, -145, 145) * evidence;
  const scheduleRating = totalWeight > 0 ? weightedSchedule / totalWeight : baseRating;
  const uncertainty = Math.round(clamp(165 - matchesUsed * 9 + (domesticLeagueId ? 0 : 35), 45, 200));
  const source: TeamStrengthProfile["source"] = domesticLeagueId
    ? "domestic-history"
    : inferredCountry ? "country-prior" : "global-fallback";

  return {
    leagueRating: Math.round(baseRating),
    clubRating: Math.round(baseRating + performanceAdjustment),
    scheduleRating: Math.round(scheduleRating),
    scheduleFactor: Math.round(clamp(Math.pow(10, (scheduleRating - 1500) / 800), 0.75, 1.3) * 1000) / 1000,
    uncertainty,
    matchesUsed,
    domesticLeagueId,
    source,
    version: STRENGTH_MODEL_VERSION,
  };
}

export function ratingThreeWayProbability(homeRating: number, awayRating: number, homeAdvantage = 55): ThreeWayProbability {
  const gap = homeRating + homeAdvantage - awayRating;
  const decisiveHomeShare = 1 / (1 + Math.pow(10, -gap / 400));
  const draw = clamp(18 + 12 * Math.exp(-Math.abs(gap) / 240), 18, 30);
  return {
    home: decisiveHomeShare * (100 - draw),
    draw,
    away: (1 - decisiveHomeShare) * (100 - draw),
  };
}

export function blendCrossLeaguePrior(
  model: ThreeWayProbability,
  home: Pick<TeamStrengthProfile, "clubRating" | "uncertainty" | "matchesUsed"> | undefined,
  away: Pick<TeamStrengthProfile, "clubRating" | "uncertainty" | "matchesUsed"> | undefined,
): ThreeWayProbability & { priorWeight: number; ratingGap: number } {
  if (!home || !away || home.matchesUsed < 3 || away.matchesUsed < 3) {
    return { ...model, priorWeight: 0, ratingGap: 0 };
  }
  const ratingGap = home.clubRating - away.clubRating;
  const structural = ratingThreeWayProbability(home.clubRating, away.clubRating);
  const evidenceQuality = clamp(1 - (home.uncertainty + away.uncertainty) / 400, 0, 1);
  let priorWeight = 0.30 + evidenceQuality * 0.15;

  const modelFavourite = model.home >= model.away ? "home" : "away";
  const ratingFavourite = ratingGap >= 0 ? "home" : "away";
  if (Math.abs(ratingGap) >= 200 && modelFavourite !== ratingFavourite) priorWeight = Math.max(priorWeight, 0.65);

  const blend = (raw: number, prior: number) => raw * (1 - priorWeight) + prior * priorWeight;
  const homeProbability = blend(model.home, structural.home);
  const drawProbability = blend(model.draw, structural.draw);
  const awayProbability = blend(model.away, structural.away);
  const total = homeProbability + drawProbability + awayProbability;
  return {
    home: homeProbability / total * 100,
    draw: drawProbability / total * 100,
    away: awayProbability / total * 100,
    priorWeight,
    ratingGap,
  };
}
