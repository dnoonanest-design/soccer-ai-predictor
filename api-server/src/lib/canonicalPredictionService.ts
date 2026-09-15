import type { Match } from "./soccerService";
import { getMatchStats, type MatchStatsResult } from "./statsService";
import {
  getEnhancedPrediction,
  type EnhancedPrediction,
  type LiveMatchStatsInput,
} from "./enhancedStatsService";
import { applyDataQualityReliability } from "./predictionDataQuality";
import { getOfflineFallbackModel, MIN_SAMPLE_FOR_WEIGHT_UPDATE } from "./adaptiveLearningEngine";
import { collectMatchCircumstances } from "./circumstanceLearningService";
import { logger } from "./logger";

export const CANONICAL_PREDICTION_PIPELINE_VERSION = "canonical-v2-player-participation";

type ThreeWay = { home: number; draw: number; away: number };

export type PredictionFeatureUsage = {
  used: string[];
  unavailable: string[];
  informationalOnly: string[];
  forbidden: string[];
};

export type CanonicalPrediction = Omit<EnhancedPrediction, "over_15" | "over_25" | "over_35" | "btts"> & {
  home_win: number;
  draw: number;
  away_win: number;
  over_15: number | null;
  over_25: number | null;
  over_35: number | null;
  btts: number | null;
  data_quality_score: number;
  data_tier: "stats-high" | "stats-medium" | "stats-low" | "offline-fallback";
  home_evidence: number;
  away_evidence: number;
  pipeline_version: string;
  prediction_source: "statistical-model" | "offline-fallback";
  feature_usage: PredictionFeatureUsage;
};

export type CanonicalPredictionResult = {
  prediction: CanonicalPrediction;
  stats: MatchStatsResult | null;
  circumstances: Awaited<ReturnType<typeof collectMatchCircumstances>> | null;
};

export type CanonicalPredictionOptions = {
  stats?: MatchStatsResult;
  collectCircumstances?: boolean;
};

export function normaliseThreeWayPercent(home: number, draw: number, away: number): ThreeWay {
  const safe = [home, draw, away].map((value) => Number.isFinite(value) && value > 0 ? value : 0);
  const total = safe[0] + safe[1] + safe[2];
  if (total <= 0) return { home: 33.34, draw: 33.33, away: 33.33 };
  const h = Math.round((safe[0] / total) * 10_000) / 100;
  const d = Math.round((safe[1] / total) * 10_000) / 100;
  return { home: h, draw: d, away: Math.round(Math.max(0, 100 - h - d) * 100) / 100 };
}

function modelStatsPayload(stats: MatchStatsResult): LiveMatchStatsInput {
  // Strength index/sample size are pre-match features carried on TeamStats;
  // live telemetry fields are null until play starts. Passing the structure for
  // every phase keeps the Manchester Rule active for pre-match predictions.
  return { home: stats.home, away: stats.away };
}

/** Select the most current model output. Live score/time and substitutions must
 * supersede the pre-match Poisson probabilities when those fields are present. */
export function selectServingProbabilities(raw: EnhancedPrediction, live: boolean): ThreeWay {
  if (live && raw.sub_adjusted_home_win != null && raw.sub_adjusted_draw != null && raw.sub_adjusted_away_win != null) {
    return normaliseThreeWayPercent(raw.sub_adjusted_home_win, raw.sub_adjusted_draw, raw.sub_adjusted_away_win);
  }
  if (live && raw.live_adjusted_home_win != null && raw.live_adjusted_draw != null && raw.live_adjusted_away_win != null) {
    return normaliseThreeWayPercent(raw.live_adjusted_home_win, raw.live_adjusted_draw, raw.live_adjusted_away_win);
  }
  return normaliseThreeWayPercent(raw.home_win, raw.draw, raw.away_win);
}

function featureUsage(stats: MatchStatsResult, raw: EnhancedPrediction, live: boolean): PredictionFeatureUsage {
  const used = [
    "opponent-adjusted goals scored and conceded",
    "recent form",
    "home/away venue evidence",
    "competition strength (Manchester Rule)",
    "league home advantage",
    "data sample size and reliability",
  ];
  const unavailable: string[] = [];
  if (raw.h2h?.matches) used.push("limited head-to-head history"); else unavailable.push("head-to-head history");
  if (raw.home_injuries.length || raw.away_injuries.length) used.push("injuries and suspensions"); else unavailable.push("confirmed injuries/suspensions");
  if (raw.player_influence) {
    used.push("confirmed participants: position-aware player form, ratings, scoring runs, creativity, defending and discipline");
  } else if (raw.lineup?.confirmed) {
    used.push("confirmed lineups and season player contribution fallback");
    unavailable.push("stored player-form profile coverage");
  } else unavailable.push("confirmed lineups and participant-gated player influence");
  if (live && stats.has_live_stats) {
    used.push("score and match time", "shots and shots on target", "live expected goals", "possession", "corners", "cards", "dangerous attacks", "substitutions and match events");
    if (raw.live_player_performance) used.push("active-player live ratings versus pre-match player baselines");
  } else if (live) {
    unavailable.push("detailed live match telemetry");
  }
  return {
    used,
    unavailable,
    informationalOnly: [
      "player AI narrative", "similar-match AI memory", "bookmaker value comparison",
      "offsides", "goalkeeper saves", "raw pass totals (possession/pass accuracy already represent them)",
    ],
    forbidden: ["the fixture's final result", "post-kickoff data in pre-match forecasts", "bookmaker odds as a model input"],
  };
}

async function buildFallbackPrediction(match: Match): Promise<CanonicalPrediction> {
  const fallback = await getOfflineFallbackModel();
  const prior = fallback.leagueOutcomePriors[match.league_id] ?? fallback.globalPriors;
  if (fallback.sampleSize < MIN_SAMPLE_FOR_WEIGHT_UPDATE) {
    throw new Error(`offline fallback requires ${MIN_SAMPLE_FOR_WEIGHT_UPDATE} settled matches for fixture ${match.id}`);
  }
  const probs = normaliseThreeWayPercent(prior.home, prior.draw, prior.away);
  const leagueXg = fallback.leagueXgAverages[match.league_id] ?? { home: 1.35, away: 1.10 };
  const fair = (p: number) => Math.round((100 / Math.max(1, p)) * 100) / 100;
  return {
    home_win: probs.home, draw: probs.draw, away_win: probs.away,
    home_xg: leagueXg.home, away_xg: leagueXg.away,
    over_15: null, over_25: null, over_35: null, btts: null, correct_scores: [],
    fair_home_odds: fair(probs.home), fair_draw_odds: fair(probs.draw), fair_away_odds: fair(probs.away),
    confidence: "Low", confidence_score: 20,
    reasons: [`Live statistics unavailable; using validated ${fallback.sampleSize}-match league fallback.`],
    base_home_win: probs.home, base_draw: probs.draw, base_away_win: probs.away,
    home_injuries: [], away_injuries: [], home_lineup_factor: 1, away_lineup_factor: 1,
    home_injury_factor: 1, away_injury_factor: 1, home_form_factor: 1, away_form_factor: 1,
    home_advantage: 1,
    data_quality_score: 0, data_tier: "offline-fallback", home_evidence: 0, away_evidence: 0,
    pipeline_version: CANONICAL_PREDICTION_PIPELINE_VERSION,
    prediction_source: "offline-fallback",
    feature_usage: {
      used: ["validated historical league outcome priors", "validated historical league scoring rates"],
      unavailable: ["current team statistics", "lineups", "injuries", "live telemetry"],
      informationalOnly: ["player AI narrative", "similar-match AI memory", "bookmaker value comparison"],
      forbidden: ["the fixture's final result", "bookmaker odds as a model input"],
    },
  };
}

/** The only supported route from match data to a user-facing probability table. */
export async function createCanonicalPrediction(
  match: Match,
  options: CanonicalPredictionOptions = {},
): Promise<CanonicalPredictionResult> {
  if (match.status !== "upcoming" && match.status !== "live") {
    throw new Error(`Prediction generation blocked for non-forecast status: ${match.status}`);
  }

  let stats: MatchStatsResult;
  try {
    stats = options.stats ?? await getMatchStats(
      match.id, match.home_team.id, match.home_team.name, match.away_team.id,
      match.away_team.name, match.league_id, match.status === "live",
    );
  } catch (err) {
    logger.warn({ err, fixtureId: match.id }, "canonical prediction: stats unavailable; attempting fallback");
    return { prediction: await buildFallbackPrediction(match), stats: null, circumstances: null };
  }

  if (!stats.home || !stats.away || stats.home.matches_played <= 0 || stats.away.matches_played <= 0) {
    return { prediction: await buildFallbackPrediction(match), stats, circumstances: null };
  }

  const live = match.status === "live";
  const raw = await getEnhancedPrediction(
    match.id, match.status, match.home_team.id, match.away_team.id, match.league_id,
    stats.home.goals_per_game, stats.home.conceded_per_game,
    stats.away.goals_per_game, stats.away.conceded_per_game,
    match.home_team.name, match.away_team.name, match.minute ?? null, live,
    match.score?.home ?? null, match.score?.away ?? null,
    stats.home.form, stats.away.form, modelStatsPayload(stats),
  );
  const serving = selectServingProbabilities(raw, live);
  const quality = applyDataQualityReliability(serving, stats.home, stats.away, raw.confidence_score);
  let circumstances: Awaited<ReturnType<typeof collectMatchCircumstances>> | null = null;
  if (options.collectCircumstances) {
    circumstances = await collectMatchCircumstances(match, stats.home.form, stats.away.form).catch((err) => {
      logger.warn({ err, fixtureId: match.id }, "canonical prediction: circumstance collection failed");
      return null;
    });
  }

  return {
    stats,
    circumstances,
    prediction: {
      ...raw,
      home_win: quality.probabilities.home,
      draw: quality.probabilities.draw,
      away_win: quality.probabilities.away,
      confidence_score: quality.confidence ?? raw.confidence_score,
      data_quality_score: quality.score,
      data_tier: quality.dataTier,
      home_evidence: quality.homeEvidence,
      away_evidence: quality.awayEvidence,
      pipeline_version: CANONICAL_PREDICTION_PIPELINE_VERSION,
      prediction_source: "statistical-model",
      feature_usage: featureUsage(stats, raw, live),
    },
  };
}
