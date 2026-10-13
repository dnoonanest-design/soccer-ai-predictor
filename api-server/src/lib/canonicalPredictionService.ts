import type { Match } from "./soccerService";
import { getMatchStats, type MatchStatsResult } from "./statsService";
import {
  getEnhancedPrediction,
  type EnhancedPrediction,
  type EnhancedPredictionOverrides,
  type LiveMatchStatsInput,
} from "./enhancedStatsService";
import { shrinkTowardPriors } from "./teamRatings";
import { applyDataQualityReliability } from "./predictionDataQuality";
import { getOfflineFallbackModel, MIN_SAMPLE_FOR_OFFLINE_FALLBACK } from "./adaptiveLearningEngine";
import { collectMatchCircumstances } from "./circumstanceLearningService";
import { logger } from "./logger";
import { normalizeThreeWayPercent } from "./mathUtils";

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
  /** Plan step 5: what the served numbers were built from (0-1 scale). */
  raw_components?: RawPredictionComponents;
  /** Which model produced the served 1X2 numbers ("legacy" or a promoted challenger). */
  serving_model?: string;
  /**
   * In play only: the model not currently serving, scored beside the served
   * numbers at live checkpoints (percentages).
   */
  inplay_alternative?: { model: string; home: number; draw: number; away: number };
};

export type RawPredictionComponents = {
  pre_prior_home: number;
  pre_prior_draw: number;
  pre_prior_away: number;
  prior_weight: number;
  reliability: number;
};

export type CanonicalPredictionResult = {
  prediction: CanonicalPrediction;
  stats: MatchStatsResult | null;
  circumstances: Awaited<ReturnType<typeof collectMatchCircumstances>> | null;
};

export type CanonicalPredictionOptions = {
  stats?: MatchStatsResult;
  collectCircumstances?: boolean;
  /** Return the original formula even when a challenger has been promoted. */
  legacyOnly?: boolean;
};

type UnitThreeWay = { home: number; draw: number; away: number };
const toUnit = (p: ThreeWay): UnitThreeWay => {
  const t = p.home + p.draw + p.away;
  return t > 0 ? { home: p.home / t, draw: p.draw / t, away: p.away / t } : { home: 1 / 3, draw: 1 / 3, away: 1 / 3 };
};

/**
 * A variant of the original formula for challenger evaluation (plan steps 1
 * and 6). Uses the same stats and cached provider data as the champion, so it
 * costs no extra API quota. Returns 0-1 probabilities, or null without stats.
 *
 * shrinkToward: null = the champion's own shrink toward 33/33/33; a set of
 * league base rates = plan step 1 (same strength, better target).
 */
export type VariantMarkets = {
  homeXg: number;
  awayXg: number;
  over15: number | null;
  over25: number | null;
  over35: number | null;
  btts: number | null;
  correctScores: Array<{ score: string; probability: number }>;
};

export async function computeLegacyVariant(
  match: Match,
  stats: MatchStatsResult,
  overrides: EnhancedPredictionOverrides,
  shrinkToward: UnitThreeWay | null,
): Promise<UnitThreeWay | null> {
  return (await computeLegacyVariantDetail(match, stats, overrides, shrinkToward))?.probs ?? null;
}

/** As computeLegacyVariant, plus the variant's own expected goals and goal markets. */
export async function computeLegacyVariantDetail(
  match: Match,
  stats: MatchStatsResult,
  overrides: EnhancedPredictionOverrides,
  shrinkToward: UnitThreeWay | null,
): Promise<{ probs: UnitThreeWay; markets: VariantMarkets } | null> {
  if (!stats.home || !stats.away || stats.home.matches_played <= 0 || stats.away.matches_played <= 0) return null;
  const raw = await getEnhancedPrediction(
    match.id, "upcoming", match.home_team.id, match.away_team.id, match.league_id,
    stats.home.goals_per_game, stats.home.conceded_per_game,
    stats.away.goals_per_game, stats.away.conceded_per_game,
    match.home_team.name, match.away_team.name, null, false, null, null,
    stats.home.form, stats.away.form, modelStatsPayload(stats), overrides,
  );
  const serving = selectServingProbabilities(raw, false);
  const quality = applyDataQualityReliability(serving, stats.home, stats.away, raw.confidence_score);
  const markets: VariantMarkets = {
    homeXg: raw.home_xg, awayXg: raw.away_xg,
    over15: raw.over_15 ?? null, over25: raw.over_25 ?? null, over35: raw.over_35 ?? null, btts: raw.btts ?? null,
    correctScores: raw.correct_scores ?? [],
  };
  if (!shrinkToward) return { probs: toUnit(quality.probabilities), markets };
  const reliability = 0.52 + 0.48 * quality.score;
  return { probs: shrinkTowardPriors(toUnit(serving), shrinkToward, 1 - reliability), markets };
}

export class PredictionWarmupError extends Error {
  readonly code = "PREDICTION_HISTORY_WARMUP";

  constructor(
    readonly fixtureId: number,
    readonly currentSamples: number,
    readonly requiredSamples: number,
  ) {
    super(`prediction history warm-up: ${currentSamples}/${requiredSamples} settled matches`);
    this.name = "PredictionWarmupError";
  }
}

/** Kept as a named export for existing callers; the single implementation lives in mathUtils. */
export const normaliseThreeWayPercent: (home: number, draw: number, away: number) => ThreeWay = normalizeThreeWayPercent;

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
  if (fallback.sampleSize < MIN_SAMPLE_FOR_OFFLINE_FALLBACK) {
    throw new PredictionWarmupError(
      match.id,
      fallback.sampleSize,
      MIN_SAMPLE_FOR_OFFLINE_FALLBACK,
    );
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

  const result: CanonicalPredictionResult = {
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
      raw_components: !live && raw.pre_prior_home_win != null && raw.pre_prior_draw != null && raw.pre_prior_away_win != null
        ? {
            pre_prior_home: raw.pre_prior_home_win,
            pre_prior_draw: raw.pre_prior_draw,
            pre_prior_away: raw.pre_prior_away_win,
            prior_weight: raw.prior_weight ?? 0,
            reliability: 0.52 + 0.48 * quality.score,
          }
        : undefined,
      serving_model: "legacy",
    },
  };

  // A challenger that has passed the promotion gate serves pre-match 1X2
  // numbers in place of the original formula. In play, the fitted in-play
  // model is computed beside the live model and serves only once promoted.
  if (!live && !options.legacyOnly) {
    const { applyServingChampion } = await import("./modelChallengerService");
    return applyServingChampion(match, result);
  }
  if (live && !options.legacyOnly) {
    const { applyInPlayModel } = await import("./inPlayModelService");
    return applyInPlayModel(match, result);
  }
  return result;
}
