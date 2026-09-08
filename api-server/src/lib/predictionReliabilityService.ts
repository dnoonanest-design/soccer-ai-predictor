import { getCompetitionKind } from "./leagueConfig";

export type StatsDataSource = "competition" | "recent_all_comp" | "blended" | string;

export interface ReliabilityStatsInput {
  data_source?: StatsDataSource;
  competition_matches_played?: number;
  recent_matches_used?: number;
  venue_matches_used?: number;
  domestic_strength_index?: number | null;
  data_quality_score?: number | null;
}

export interface PredictionReliabilityContext {
  leagueId: number;
  homeStats?: ReliabilityStatsInput | null;
  awayStats?: ReliabilityStatsInput | null;
  lineupConfirmed?: boolean;
  isLive?: boolean;
}

export type ReliabilityLabel = "very-low" | "low" | "medium" | "high";
export type PredictionMode = "standard" | "cup" | "cross-league";

export interface PredictionReliabilityAssessment {
  score: number;
  label: ReliabilityLabel;
  mode: PredictionMode;
  reasons: string[];
  probabilityShrink: number;
  homeStrengthFactor: number;
  awayStrengthFactor: number;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

export function calculateTeamDataQuality(stats?: ReliabilityStatsInput | null): number {
  if (!stats) return 40;
  if (Number.isFinite(Number(stats.data_quality_score))) {
    return clamp(Number(stats.data_quality_score), 35, 100);
  }

  const source = String(stats.data_source ?? "");
  const sourceBase =
    source === "competition" ? 88 :
    source === "blended" ? 75 :
    source === "recent_all_comp" ? 60 : 52;
  const competitionMatches = Math.max(0, Number(stats.competition_matches_played ?? 0));
  const recentMatches = Math.max(0, Number(stats.recent_matches_used ?? 0));
  const venueMatches = Math.max(0, Number(stats.venue_matches_used ?? 0));

  const competitionBonus = Math.min(6, competitionMatches * 1.2);
  const recentBonus = Math.min(4, recentMatches * 0.35);
  const venueBonus = Math.min(4, venueMatches * 0.8);
  return round2(clamp(sourceBase + competitionBonus + recentBonus + venueBonus, 35, 100));
}

function labelFor(score: number): ReliabilityLabel {
  if (score >= 82) return "high";
  if (score >= 68) return "medium";
  if (score >= 52) return "low";
  return "very-low";
}

function safeStrength(stats?: ReliabilityStatsInput | null): number | null {
  const value = Number(stats?.domestic_strength_index);
  return Number.isFinite(value) && value >= 0.75 && value <= 1.25 ? value : null;
}

export function assessPredictionReliability(
  context: PredictionReliabilityContext,
): PredictionReliabilityAssessment {
  const kind = getCompetitionKind(context.leagueId);
  const mode: PredictionMode = kind === "cup" ? "cup" : kind === "uefa" ? "cross-league" : "standard";
  const homeQuality = calculateTeamDataQuality(context.homeStats);
  const awayQuality = calculateTeamDataQuality(context.awayStats);
  let score = (homeQuality + awayQuality) / 2;
  const reasons: string[] = [];

  if (String(context.homeStats?.data_source) === "recent_all_comp" ||
      String(context.awayStats?.data_source) === "recent_all_comp") {
    reasons.push("Competition-specific history is sparse; recent all-competition form is being used.");
  } else if (String(context.homeStats?.data_source) === "blended" ||
             String(context.awayStats?.data_source) === "blended") {
    reasons.push("Competition history is being blended with recent all-competition form.");
  }

  if (mode === "cup" && !context.lineupConfirmed && !context.isLive) {
    score -= 18;
    reasons.push("Cup mode: confirmed lineups are not yet available, so rotation uncertainty is elevated.");
  }

  const homeStrength = safeStrength(context.homeStats);
  const awayStrength = safeStrength(context.awayStats);
  let homeStrengthFactor = 1;
  let awayStrengthFactor = 1;
  if (mode === "cross-league") {
    if (homeStrength && awayStrength) {
      const raw = Math.pow(homeStrength / awayStrength, 0.65);
      homeStrengthFactor = clamp(raw, 0.90, 1.10);
      awayStrengthFactor = clamp(1 / homeStrengthFactor, 0.90, 1.10);
      if (Math.abs(homeStrengthFactor - 1) >= 0.015) {
        reasons.push("Cross-league mode: domestic performance is normalised for league strength before home advantage.");
      }
    } else {
      score -= 10;
      reasons.push("Cross-league mode: one or both domestic-league strength priors are unavailable.");
    }
  }

  if (context.lineupConfirmed) {
    score += 5;
    reasons.push("Confirmed starting lineups improve prediction reliability.");
  }
  if (context.isLive) score += 7;

  score = round2(clamp(score, 35, 98));
  // The model remains directional, but low-quality data cannot create an
  // artificially sharp 1X2 edge. 0.68-0.99 keeps the guard conservative.
  const probabilityShrink = round2(clamp(0.52 + score / 210, 0.68, 0.99));

  return {
    score,
    label: labelFor(score),
    mode,
    reasons: reasons.slice(0, 5),
    probabilityShrink,
    homeStrengthFactor: round2(homeStrengthFactor),
    awayStrengthFactor: round2(awayStrengthFactor),
  };
}

export function guardThreeWayProbabilities(
  home: number,
  draw: number,
  away: number,
  reliability: Pick<PredictionReliabilityAssessment, "probabilityShrink"> | number,
) {
  const raw = [home, draw, away].map((value) => Number.isFinite(value) && value > 0 ? value : 0);
  const total = raw[0] + raw[1] + raw[2];
  const normalised = total > 0
    ? raw.map((value) => value / total * 100)
    : [33.34, 33.33, 33.33];
  const shrink = typeof reliability === "number"
    ? clamp(reliability, 0.68, 0.99)
    : clamp(reliability.probabilityShrink, 0.68, 0.99);
  const uniform = 100 / 3;
  const guarded = normalised.map((value) => uniform + (value - uniform) * shrink);
  const h = round2(guarded[0]);
  const d = round2(guarded[1]);
  const a = round2(Math.max(0, 100 - h - d));
  return { home: h, draw: d, away: a };
}

export function capHomeAdvantage(baseHomeAdvantage: number, leagueId: number): number {
  const kind = getCompetitionKind(leagueId);
  if (kind === "uefa") return Math.min(baseHomeAdvantage, 1.035);
  if (kind === "cup") return Math.min(baseHomeAdvantage, 1.04);
  return baseHomeAdvantage;
}
