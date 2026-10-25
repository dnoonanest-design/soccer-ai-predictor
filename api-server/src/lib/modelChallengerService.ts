/**
 * Champion/challenger model evaluation and promotion (analysis plan).
 *
 * Every pre-match audit capture also records each challenger's forecast for
 * the same fixture and checkpoint, with the champion's forecast in the same
 * row. After full time both are scored. A challenger replaces the champion
 * only when it is better on enough unseen matches, by a margin that is
 * unlikely to be luck, and also better on the matches that have closing odds
 * (plan step 7). Nothing here lets generative AI touch a probability.
 *
 * Challengers (plan step in brackets):
 *   step1-league-priors   original formula, fitted home edge, shrink toward league base rates [1]
 *   step2-ratings         fitted attack/defence ratings + Dixon-Coles grid                    [2]
 *   step3-ratings-xg      ratings fitted on a goals/xG blend where xG is stored                [3]
 *   step4-calibrated      step 2 plus a 3-way calibration fitted on settled step-2 forecasts  [4]
 *   step6-no-form         original formula without the form factor                             [6]
 *   step6-no-h2h          original formula without the head-to-head blend                       [6]
 *   step6-no-players      original formula without injury and lineup factors                    [6]
 *   step7-shots-stacked   softmax on goal-rating and shot-rating strengths (wider-stats study)  [7]
 *   step8-home-calibrated original formula plus a 3-way calibration fitted on its own settled
 *                         forecasts (corrects home under-rating, draw over-rating, overconfidence)
 *   step9-strength-ratings six opponent-adjusted team ratings (results, goals, xG, shots on target,
 *                         shots, corners) with per-league home advantage, H2H draw tendency and a
 *                         UEFA flag; calibrated goal markets (pattern audit, Oct 2026)
 *   legacy                the original formula, recorded once another model is champion
 */
import { pool } from "@workspace/db";
import type { PredictionMatch } from "./predictionInputBoundary";
import type { MatchStatsResult } from "./statsService";
import type { CanonicalPredictionResult } from "./canonicalPredictionService";
import { computeLegacyVariantDetail, type VariantMarkets } from "./canonicalPredictionService";
import { dixonColesMarkets, dixonColesOutcomes } from "./teamRatings";
import { ensureTeamRatings, forecastFromRatings, forecastStacked, getLeagueRatingSet, getTeamRatingsStatus } from "./teamRatingsProvider";
import { runInPlayCycle } from "./inPlayModelService";
import { applyCalibration, fitCalibration, IDENTITY_CALIBRATION, type CalibrationParams, type Outcome } from "./outcomeCalibration";
import { logger } from "./logger";
import { ensureStrengthModel, forecastStrength, getStrengthModelStatus } from "./strengthModel";
import { getTeamSheetCoverage } from "./teamSheets";

type Unit = { home: number; draw: number; away: number };

export const CHALLENGER_IDS = [
  "step1-league-priors",
  "step2-ratings",
  "step3-ratings-xg",
  "step4-calibrated",
  "step6-no-form",
  "step6-no-h2h",
  "step6-no-players",
  "step7-shots-stacked",
  "step8-home-calibrated",
  "step9-strength-ratings",
  "legacy",
] as const;
export type ChallengerId = (typeof CHALLENGER_IDS)[number];

const DESCRIPTIONS: Record<ChallengerId, string> = {
  "step1-league-priors": "Original formula with fitted home advantage, shrunk toward league base rates instead of 33/33/33",
  "step2-ratings": "Fitted attack/defence team ratings with a Dixon-Coles score grid",
  "step3-ratings-xg": "Team ratings fitted on a 50/50 goals and expected-goals blend",
  "step4-calibrated": "Team ratings plus a three-way calibration fitted on settled forecasts",
  "step6-no-form": "Original formula without the last-5 form factor",
  "step6-no-h2h": "Original formula without the head-to-head blend",
  "step6-no-players": "Original formula without injury and lineup factors",
  "step7-shots-stacked": "Stacking model on team ratings fitted on goals and on shots (on and off target)",
  "step8-home-calibrated": "Original formula with a home/draw/confidence correction fitted on its own settled forecasts",
  "step9-strength-ratings": "Six opponent-adjusted team ratings (results, goals, xG, shots on target, shots, corners) with per-league home advantage and calibrated goal markets",
  legacy: "The original formula",
};

export const PROMOTION_RULES = {
  minMatches: Number(process.env.CHALLENGER_MIN_MATCHES ?? 300),
  minBrierImprovement: Number(process.env.CHALLENGER_MIN_BRIER_GAIN ?? 0.003),
  // The gate re-checks every challenger every 30 minutes, so a lucky streak
  // gets many chances. Replaying real results showed t >= 2 promotes a
  // no-better model about 9% of the time within 900 matches (per challenger);
  // t >= 3 cuts that to under 1%, at the cost of a longer wait.
  minTStat: Number(process.env.CHALLENGER_MIN_TSTAT ?? 3),
  minMarketMatches: Number(process.env.CHALLENGER_MIN_MARKET_MATCHES ?? 50),
  // Goal markets: once enough settled rows carry them, a challenger may not
  // make over 2.5 or BTTS log loss worse by more than this.
  minGoalMarketMatches: Number(process.env.CHALLENGER_MIN_GOAL_MARKET_MATCHES ?? 100),
  maxGoalMarketLoss: Number(process.env.CHALLENGER_MAX_GOAL_MARKET_LOSS ?? 0.002),
  minDaysBetweenPromotions: 7,
  autoPromote: process.env.CHALLENGER_AUTO_PROMOTE !== "false",
};

let calibration: CalibrationParams = IDENTITY_CALIBRATION;
let legacyCalibration: CalibrationParams = IDENTITY_CALIBRATION;
let servingCache: { champion: string; since: Date | null; calibration: CalibrationParams | null; at: number } | null = null;
let workerTimer: NodeJS.Timeout | null = null;
let lastRun: { at: string; settled: number; promoted: string | null; error: string | null } | null = null;

// ── Forecasts ────────────────────────────────────────────────────────────────

type ChallengerDetail = { probs: Unit; markets: VariantMarkets };

function fromRatings(match: PredictionMatch, useXg: boolean): ChallengerDetail | null {
  if (useXg) {
    const set = getLeagueRatingSet(match.league_id);
    // Without xG for this league the forecast would duplicate step 2.
    if (set && !set.goalsXg) return null;
  }
  const f = forecastFromRatings(match.league_id, match.home_team.id, match.away_team.id, useXg);
  if (!f) return null;
  const p = dixonColesOutcomes(f.lambdaHome, f.lambdaAway);
  const g = dixonColesMarkets(f.lambdaHome, f.lambdaAway);
  return {
    probs: { home: p.home, draw: p.draw, away: p.away },
    markets: {
      homeXg: Math.round(f.lambdaHome * 100) / 100, awayXg: Math.round(f.lambdaAway * 100) / 100,
      over15: g.over15, over25: g.over25, over35: g.over35, btts: g.btts, correctScores: g.correctScores,
    },
  };
}

/** Forecast plus the goal markets that go with it, or null when it cannot forecast this match. */
export async function computeChallengerDetail(
  id: string,
  match: PredictionMatch,
  stats: MatchStatsResult | null,
  calibrationOverride?: CalibrationParams | null,
): Promise<ChallengerDetail | null> {
  switch (id) {
    case "step2-ratings": return fromRatings(match, false);
    case "step3-ratings-xg": return fromRatings(match, true);
    case "step4-calibrated": {
      const base = fromRatings(match, false);
      // Calibration adjusts 1X2 only; goal markets come from the same grid.
      return base ? { ...base, probs: applyCalibration(base.probs, calibrationOverride ?? calibration) } : null;
    }
    case "step1-league-priors": {
      if (!stats) return null;
      const set = getLeagueRatingSet(match.league_id);
      const f = forecastFromRatings(match.league_id, match.home_team.id, match.away_team.id, false);
      const priors = set?.priors ?? f?.priors;
      if (!priors) return null;
      return computeLegacyVariantDetail(match, stats, set ? { homeAdvantage: Math.exp(set.goals.homeAdvantage) } : {}, priors);
    }
    case "step7-shots-stacked": {
      const f = forecastStacked(match.league_id, match.home_team.id, match.away_team.id);
      if (!f) return null;
      const g = dixonColesMarkets(f.lambdas.home, f.lambdas.away);
      return {
        probs: f.probs,
        markets: {
          homeXg: Math.round(f.lambdas.home * 100) / 100, awayXg: Math.round(f.lambdas.away * 100) / 100,
          over15: g.over15, over25: g.over25, over35: g.over35, btts: g.btts, correctScores: g.correctScores,
        },
      };
    }
    case "step8-home-calibrated": {
      if (!stats) return null;
      const base = await computeLegacyVariantDetail(match, stats, {}, null);
      if (!base) return null;
      const params = calibrationOverride ?? legacyCalibration;
      // Until enough settled forecasts exist this would duplicate the original formula.
      if (params.samples < 50) return null;
      return { ...base, probs: applyCalibration(base.probs, params) };
    }
    case "step9-strength-ratings": {
      const f = forecastStrength(match.league_id, match.home_team.id, match.away_team.id);
      return f ? { probs: f.probs, markets: f.markets } : null;
    }
    case "step6-no-form": return stats ? computeLegacyVariantDetail(match, stats, { disableForm: true }, null) : null;
    case "step6-no-h2h": return stats ? computeLegacyVariantDetail(match, stats, { disableH2H: true }, null) : null;
    case "step6-no-players": return stats ? computeLegacyVariantDetail(match, stats, { disablePlayerFactors: true }, null) : null;
    case "legacy": return stats ? computeLegacyVariantDetail(match, stats, {}, null) : null;
    default: return null;
  }
}

/** 0-1 forecast for one challenger, or null when it cannot forecast this match. */
export async function computeChallenger(
  id: string,
  match: PredictionMatch,
  stats: MatchStatsResult | null,
  calibrationOverride?: CalibrationParams | null,
): Promise<Unit | null> {
  return (await computeChallengerDetail(id, match, stats, calibrationOverride))?.probs ?? null;
}

/**
 * Record every challenger beside the champion for one pre-match checkpoint.
 * Called by the audit worker right after it seals the champion's record.
 */
export async function recordChallengerPredictions(
  match: PredictionMatch,
  checkpoint: string,
  champion: Unit & { over25?: number | null; btts?: number | null },
  stats: MatchStatsResult | null,
): Promise<number> {
  if (!match.kickoff || new Date(match.kickoff).getTime() <= Date.now()) return 0;
  await ensureTeamRatings();
  await ensureStrengthModel();
  const serving = await getServingState();
  let recorded = 0;
  for (const id of CHALLENGER_IDS) {
    if (id === serving.champion) continue;
    if (id === "legacy" && serving.champion === "legacy") continue;
    try {
      const detail = await computeChallengerDetail(id, match, stats);
      const p = detail?.probs;
      if (!p || ![p.home, p.draw, p.away].every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) continue;
      const result = await pool.query(
        `INSERT INTO model_challenger_predictions
           (fixture_id, league_id, challenger, checkpoint, kickoff_at,
            home_win_prob, draw_prob, away_win_prob,
            champion_home_prob, champion_draw_prob, champion_away_prob, details,
            over25_prob, btts_prob, champion_over25_prob, champion_btts_prob)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         ON CONFLICT (fixture_id, challenger, checkpoint) DO NOTHING`,
        [match.id, match.league_id, id, checkpoint, new Date(match.kickoff),
          p.home, p.draw, p.away, champion.home, champion.draw, champion.away,
          JSON.stringify({ champion: serving.champion }),
          unitOrNull(detail?.markets.over25), unitOrNull(detail?.markets.btts),
          unitOrNull(champion.over25, 1), unitOrNull(champion.btts, 1)],
      );
      recorded += result.rowCount ?? 0;
    } catch (err) {
      logger.warn({ err, fixtureId: match.id, challenger: id }, "challenger forecast not recorded");
    }
  }
  return recorded;
}

/** Percent (or unit when scale = 1) to a 0-1 probability, null when missing. */
function unitOrNull(v: number | null | undefined, scale = 100): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  const u = v / scale;
  return u >= 0 && u <= 1 ? u : null;
}

// ── Settlement and scoring ───────────────────────────────────────────────────

export async function settleChallengerPredictions(): Promise<number> {
  const result = await pool.query(
    `WITH scored AS (
       SELECT c.id, o.outcome,
              (o.score_home + o.score_away > 2) AS o25,
              (o.score_home > 0 AND o.score_away > 0) AS bt,
              (CASE WHEN o.outcome = 'home' THEN 1 ELSE 0 END) AS yh,
              (CASE WHEN o.outcome = 'draw' THEN 1 ELSE 0 END) AS yd,
              (CASE WHEN o.outcome = 'away' THEN 1 ELSE 0 END) AS ya
         FROM model_challenger_predictions c
         JOIN match_outcomes o ON o.fixture_id = c.fixture_id
        WHERE c.settled_at IS NULL AND o.outcome IN ('home','draw','away')
     )
     UPDATE model_challenger_predictions c
        SET actual_outcome = s.outcome,
            brier_score = POWER(c.home_win_prob - s.yh, 2) + POWER(c.draw_prob - s.yd, 2) + POWER(c.away_win_prob - s.ya, 2),
            champion_brier_score = POWER(c.champion_home_prob - s.yh, 2) + POWER(c.champion_draw_prob - s.yd, 2) + POWER(c.champion_away_prob - s.ya, 2),
            log_loss = -LN(GREATEST(1e-6, CASE s.outcome WHEN 'home' THEN c.home_win_prob WHEN 'draw' THEN c.draw_prob ELSE c.away_win_prob END)),
            champion_log_loss = -LN(GREATEST(1e-6, CASE s.outcome WHEN 'home' THEN c.champion_home_prob WHEN 'draw' THEN c.champion_draw_prob ELSE c.champion_away_prob END)),
            over25_actual = s.o25,
            btts_actual = s.bt,
            over25_log_loss = CASE WHEN c.over25_prob IS NULL THEN NULL ELSE -LN(GREATEST(1e-6, CASE WHEN s.o25 THEN c.over25_prob ELSE 1 - c.over25_prob END)) END,
            champion_over25_log_loss = CASE WHEN c.champion_over25_prob IS NULL THEN NULL ELSE -LN(GREATEST(1e-6, CASE WHEN s.o25 THEN c.champion_over25_prob ELSE 1 - c.champion_over25_prob END)) END,
            btts_log_loss = CASE WHEN c.btts_prob IS NULL THEN NULL ELSE -LN(GREATEST(1e-6, CASE WHEN s.bt THEN c.btts_prob ELSE 1 - c.btts_prob END)) END,
            champion_btts_log_loss = CASE WHEN c.champion_btts_prob IS NULL THEN NULL ELSE -LN(GREATEST(1e-6, CASE WHEN s.bt THEN c.champion_btts_prob ELSE 1 - c.champion_btts_prob END)) END,
            settled_at = NOW()
       FROM scored s
      WHERE c.id = s.id`,
  );
  return result.rowCount ?? 0;
}

/** Plan step 4: refit the calibration on settled step-2 forecasts (latest per fixture). */
export async function refitCalibration(): Promise<CalibrationParams> {
  const rows = await pool.query(
    `SELECT DISTINCT ON (fixture_id) home_win_prob, draw_prob, away_win_prob, actual_outcome
       FROM model_challenger_predictions
      WHERE challenger = 'step2-ratings' AND settled_at IS NOT NULL
      ORDER BY fixture_id, captured_at DESC
      LIMIT 5000`,
  );
  calibration = fitCalibration(rows.rows.map((r: any) => ({
    probs: { home: Number(r.home_win_prob), draw: Number(r.draw_prob), away: Number(r.away_win_prob) },
    actual: String(r.actual_outcome) as Outcome,
  })));
  return calibration;
}

/**
 * Fit the step-8 correction on the original formula's own settled forecasts:
 * the champion columns of rows recorded while the original formula was
 * serving, latest pre-match capture per fixture. Only forecasts made before
 * kickoff are stored, so every row is out-of-sample for the fit.
 */
export async function refitLegacyCalibration(): Promise<CalibrationParams> {
  const rows = await pool.query(
    `SELECT DISTINCT ON (fixture_id)
            champion_home_prob, champion_draw_prob, champion_away_prob, actual_outcome
       FROM model_challenger_predictions
      WHERE settled_at IS NOT NULL
        AND actual_outcome IN ('home','draw','away')
        AND COALESCE(details->>'champion', 'legacy') = 'legacy'
      ORDER BY fixture_id, captured_at DESC
      LIMIT 5000`,
  );
  legacyCalibration = fitCalibration(rows.rows.map((r: any) => ({
    probs: { home: Number(r.champion_home_prob), draw: Number(r.champion_draw_prob), away: Number(r.champion_away_prob) },
    actual: String(r.actual_outcome) as Outcome,
  })));
  return legacyCalibration;
}

// ── Report and promotion gate ────────────────────────────────────────────────

export type ChallengerStanding = {
  challenger: string;
  description: string;
  /** Forecasts recorded before kickoff, still waiting for the result. */
  pending: number;
  matches: number;
  brier: number | null;
  championBrier: number | null;
  brierGain: number | null;
  tStat: number | null;
  logLossGain: number | null;
  marketMatches: number;
  marketBrierGain: number | null;
  /** Settled matches where both sides stored over 2.5 and BTTS. */
  goalMarketMatches: number;
  over25LogLossGain: number | null;
  bttsLogLossGain: number | null;
  closingOddsBrier: number | null;
  eligible: boolean;
  reasons: string[];
};

export async function getChallengerReport() {
  const serving = await getServingState(true);
  const since = serving.since ?? new Date(0);
  const result = await pool.query(
    `WITH latest AS (
       SELECT DISTINCT ON (challenger, fixture_id) *
         FROM model_challenger_predictions
        WHERE settled_at IS NOT NULL AND captured_at >= $1
        ORDER BY challenger, fixture_id, captured_at DESC
     ), book_close AS (
       SELECT DISTINCT ON (m.fixture_id, m.bookmaker_key)
              m.fixture_id, m.implied_home_prob h, m.implied_draw_prob d, m.implied_away_prob a
         FROM market_odds_snapshots m
         JOIN (SELECT DISTINCT fixture_id, kickoff_at FROM latest) l ON l.fixture_id = m.fixture_id
        WHERE m.observed_at < l.kickoff_at
        ORDER BY m.fixture_id, m.bookmaker_key, m.observed_at DESC
     ), closing AS (
       SELECT fixture_id, AVG(h) / 100.0 h, AVG(d) / 100.0 d, AVG(a) / 100.0 a FROM book_close GROUP BY fixture_id
     )
     SELECT l.challenger,
            COUNT(*)::int AS matches,
            AVG(l.brier_score) AS brier,
            AVG(l.champion_brier_score) AS champion_brier,
            AVG(l.champion_brier_score - l.brier_score) AS gain,
            STDDEV_SAMP(l.champion_brier_score - l.brier_score) AS gain_sd,
            AVG(l.champion_log_loss - l.log_loss) AS ll_gain,
            COUNT(*) FILTER (WHERE l.over25_log_loss IS NOT NULL AND l.champion_over25_log_loss IS NOT NULL
                               AND l.btts_log_loss IS NOT NULL AND l.champion_btts_log_loss IS NOT NULL)::int AS goal_matches,
            AVG(l.champion_over25_log_loss - l.over25_log_loss) FILTER (WHERE l.over25_log_loss IS NOT NULL AND l.champion_over25_log_loss IS NOT NULL
                               AND l.btts_log_loss IS NOT NULL AND l.champion_btts_log_loss IS NOT NULL) AS o25_gain,
            AVG(l.champion_btts_log_loss - l.btts_log_loss) FILTER (WHERE l.over25_log_loss IS NOT NULL AND l.champion_over25_log_loss IS NOT NULL
                               AND l.btts_log_loss IS NOT NULL AND l.champion_btts_log_loss IS NOT NULL) AS btts_gain,
            COUNT(c.fixture_id)::int AS market_matches,
            AVG(l.champion_brier_score - l.brier_score) FILTER (WHERE c.fixture_id IS NOT NULL) AS market_gain,
            AVG(POWER(c.h - CASE WHEN l.actual_outcome='home' THEN 1 ELSE 0 END, 2)
              + POWER(c.d - CASE WHEN l.actual_outcome='draw' THEN 1 ELSE 0 END, 2)
              + POWER(c.a - CASE WHEN l.actual_outcome='away' THEN 1 ELSE 0 END, 2)) AS closing_brier
       FROM latest l
       LEFT JOIN closing c ON c.fixture_id = l.fixture_id
      GROUP BY l.challenger
      ORDER BY gain DESC NULLS LAST`,
    [since],
  );
  const pendingRows = await pool.query(
    `SELECT challenger, COUNT(DISTINCT fixture_id)::int AS pending
       FROM model_challenger_predictions
      WHERE settled_at IS NULL AND captured_at >= $1
      GROUP BY challenger`,
    [since],
  );
  const pendingBy = new Map<string, number>(pendingRows.rows.map((r: any) => [String(r.challenger), Number(r.pending ?? 0)]));
  const settledIds = new Set(result.rows.map((r: any) => String(r.challenger)));
  const rows = [
    ...result.rows,
    ...[...pendingBy.keys()].filter((id) => !settledIds.has(id)).map((challenger) => ({ challenger, matches: 0 })),
  ];
  const n = (v: unknown) => (v == null || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 10_000) / 10_000);
  const standings: ChallengerStanding[] = rows.map((r: any) => {
    const matches = Number(r.matches ?? 0);
    const gain = n(r.gain), sd = Number(r.gain_sd);
    const tStat = gain != null && Number.isFinite(sd) && sd > 0 && matches > 1 ? Math.round((gain / (sd / Math.sqrt(matches))) * 100) / 100 : null;
    const marketMatches = Number(r.market_matches ?? 0), marketGain = n(r.market_gain), llGain = n(r.ll_gain);
    const reasons: string[] = [];
    if (matches < PROMOTION_RULES.minMatches) reasons.push(`needs ${PROMOTION_RULES.minMatches} settled matches (has ${matches})`);
    if (gain == null || gain < PROMOTION_RULES.minBrierImprovement) reasons.push(`Brier gain must be at least ${PROMOTION_RULES.minBrierImprovement}`);
    if (tStat == null || tStat < PROMOTION_RULES.minTStat) reasons.push(`gain must be at least ${PROMOTION_RULES.minTStat} standard errors from zero`);
    if (llGain == null || llGain <= 0) reasons.push("log loss must also improve");
    if (marketMatches < PROMOTION_RULES.minMarketMatches) reasons.push(`needs ${PROMOTION_RULES.minMarketMatches} matches with closing odds (has ${marketMatches})`);
    else if (marketGain == null || marketGain <= 0) reasons.push("must also improve on matches with closing odds (smaller gap to the market)");
    const goalMatches = Number(r.goal_matches ?? 0), o25Gain = n(r.o25_gain), bttsGain = n(r.btts_gain);
    if (goalMatches < PROMOTION_RULES.minGoalMarketMatches) reasons.push(`needs ${PROMOTION_RULES.minGoalMarketMatches} matches with goal markets stored (has ${goalMatches})`);
    else {
      if (o25Gain == null || o25Gain < -PROMOTION_RULES.maxGoalMarketLoss) reasons.push("over 2.5 goals log loss must not get worse");
      if (bttsGain == null || bttsGain < -PROMOTION_RULES.maxGoalMarketLoss) reasons.push("both-teams-to-score log loss must not get worse");
    }
    return {
      challenger: String(r.challenger),
      description: DESCRIPTIONS[r.challenger as ChallengerId] ?? String(r.challenger),
      pending: pendingBy.get(String(r.challenger)) ?? 0,
      matches, brier: n(r.brier), championBrier: n(r.champion_brier), brierGain: gain, tStat, logLossGain: llGain,
      marketMatches, marketBrierGain: marketGain, closingOddsBrier: n(r.closing_brier),
      goalMarketMatches: goalMatches, over25LogLossGain: o25Gain, bttsLogLossGain: bttsGain,
      eligible: reasons.length === 0, reasons,
    };
  });
  return {
    champion: serving.champion,
    championSince: serving.since?.toISOString() ?? null,
    championDescription: DESCRIPTIONS[serving.champion as ChallengerId] ?? serving.champion,
    rules: PROMOTION_RULES,
    calibration,
    legacyCalibration,
    ratings: getTeamRatingsStatus(),
    strengthModel: getStrengthModelStatus(),
    // Pre-kickoff line-up and absence data collected for the next model step.
    teamSheets: await getTeamSheetCoverage().catch(() => null),
    standings,
    lastRun,
    pendingTotal: [...pendingBy.values()].reduce((sum, v) => sum + v, 0),
    note: "Each challenger is compared with the champion on the same fixtures, using the latest forecast captured before kickoff.",
  };
}

/** Settled forecasts for one challenger beside the champion's, newest first (diagnostics). */
export async function getChallengerFixtures(challenger: string, limit = 60) {
  const safe = Math.max(1, Math.min(200, Math.floor(limit) || 60));
  const result = await pool.query(
    `WITH latest AS (
       SELECT DISTINCT ON (fixture_id) *
         FROM model_challenger_predictions
        WHERE challenger = $1 AND settled_at IS NOT NULL
        ORDER BY fixture_id, captured_at DESC
     )
     SELECT l.fixture_id, l.league_id, l.kickoff_at, l.checkpoint,
            t.home_team, t.away_team, o.score_home, o.score_away, l.actual_outcome,
            l.home_win_prob, l.draw_prob, l.away_win_prob,
            l.champion_home_prob, l.champion_draw_prob, l.champion_away_prob,
            l.brier_score, l.champion_brier_score
       FROM latest l
       LEFT JOIN match_outcomes o ON o.fixture_id = l.fixture_id
       LEFT JOIN LATERAL (
         SELECT home_team, away_team FROM prediction_audit_records a
          WHERE a.fixture_id = l.fixture_id ORDER BY a.captured_at DESC LIMIT 1
       ) t ON TRUE
      ORDER BY l.kickoff_at DESC
      LIMIT $2`,
    [challenger, safe],
  );
  const r3 = (v: unknown) => (v == null ? null : Math.round(Number(v) * 1000) / 1000);
  return result.rows.map((r: any) => ({
    fixtureId: Number(r.fixture_id), leagueId: r.league_id == null ? null : Number(r.league_id),
    kickoff: r.kickoff_at, checkpoint: r.checkpoint,
    match: `${r.home_team ?? "?"} v ${r.away_team ?? "?"}`,
    score: r.score_home == null ? null : `${r.score_home}-${r.score_away}`, actual: r.actual_outcome,
    challenger: [r3(r.home_win_prob), r3(r.draw_prob), r3(r.away_win_prob)],
    champion: [r3(r.champion_home_prob), r3(r.champion_draw_prob), r3(r.champion_away_prob)],
    brier: r3(r.brier_score), championBrier: r3(r.champion_brier_score),
  }));
}

export async function runPromotionGate(): Promise<string | null> {
  const report = await getChallengerReport();
  const eligible = report.standings.filter((s) => s.eligible).sort((a, b) => (b.brierGain ?? 0) - (a.brierGain ?? 0));
  if (!eligible.length || !PROMOTION_RULES.autoPromote) return null;
  const recent = await pool.query(
    `SELECT 1 FROM model_promotion_log WHERE decided_at > NOW() - ($1 || ' days')::interval LIMIT 1`,
    [String(PROMOTION_RULES.minDaysBetweenPromotions)],
  );
  if (recent.rowCount) return null;
  const winner = eligible[0];
  // Freeze the correction that earned the promotion; the live fit keeps moving.
  const calibrationSnapshot =
    winner.challenger === "step4-calibrated" ? calibration
      : winner.challenger === "step8-home-calibrated" ? legacyCalibration
        : null;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE model_serving_state SET champion = $1, calibration = $2, updated_at = NOW() WHERE id = 1`,
      [winner.challenger, calibrationSnapshot ? JSON.stringify(calibrationSnapshot) : null],
    );
    await client.query(
      `INSERT INTO model_promotion_log (previous_champion, new_champion, evidence) VALUES ($1, $2, $3)`,
      [report.champion, winner.challenger, JSON.stringify({ ...winner, rules: PROMOTION_RULES })],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  servingCache = null;
  logger.info({ previous: report.champion, champion: winner.challenger, evidence: winner }, "model challenger promoted");
  return winner.challenger;
}

/** Admin rollback: serve the original formula again. */
export async function rollbackToLegacy(reason: string) {
  const current = await getServingState(true);
  if (current.champion === "legacy") return false;
  await pool.query(`UPDATE model_serving_state SET champion = 'legacy', calibration = NULL, updated_at = NOW() WHERE id = 1`);
  await pool.query(
    `INSERT INTO model_promotion_log (previous_champion, new_champion, evidence) VALUES ($1, 'legacy', $2)`,
    [current.champion, JSON.stringify({ manualRollback: true, reason })],
  );
  servingCache = null;
  return true;
}

// ── Serving ──────────────────────────────────────────────────────────────────

async function getServingState(fresh = false) {
  if (!fresh && servingCache && Date.now() - servingCache.at < 60_000) return servingCache;
  try {
    const result = await pool.query(`SELECT champion, calibration, updated_at FROM model_serving_state WHERE id = 1`);
    const row = result.rows[0];
    const champion = row?.champion ? String(row.champion) : "legacy";
    const cal = row?.calibration ? (typeof row.calibration === "string" ? JSON.parse(row.calibration) : row.calibration) : null;
    servingCache = { champion, since: champion === "legacy" ? null : new Date(row.updated_at), calibration: cal, at: Date.now() };
  } catch {
    // Migration not applied yet: behave exactly as before.
    servingCache = { champion: "legacy", since: null, calibration: null, at: Date.now() };
  }
  return servingCache;
}

/**
 * Replace the original formula's pre-match 1X2 numbers with the promoted
 * champion's, when one has been promoted and it can forecast this match.
 * Falls back to the original formula otherwise, so a missing rating never
 * blanks a prediction.
 */
export async function applyServingChampion(match: PredictionMatch, result: CanonicalPredictionResult): Promise<CanonicalPredictionResult> {
  const serving = await getServingState();
  if (serving.champion === "legacy") return result;
  try {
    if (/^step[2347]/.test(serving.champion)) await ensureTeamRatings();
    if (serving.champion === "step9-strength-ratings") await ensureStrengthModel();
    const detail = await computeChallengerDetail(serving.champion, match, result.stats, serving.calibration);
    if (!detail) return result;
    const p = detail.probs, m = detail.markets;
    const pct = (v: number) => Math.round(v * 10_000) / 100;
    const home = pct(p.home), draw = pct(p.draw), away = Math.round((100 - home - draw) * 100) / 100;
    const fair = (v: number) => (v > 0 ? Math.round((100 / v) * 100) / 100 : 0);
    return {
      ...result,
      prediction: {
        ...result.prediction,
        home_win: home, draw, away_win: away,
        fair_home_odds: fair(home), fair_draw_odds: fair(draw), fair_away_odds: fair(away),
        // Goal markets and expected goals from the same model, so the page
        // never shows 1X2 from one model next to over/under from another.
        home_xg: m.homeXg, away_xg: m.awayXg,
        over_15: m.over15, over_25: m.over25, over_35: m.over35, btts: m.btts,
        correct_scores: m.correctScores,
        serving_model: serving.champion,
        pipeline_version: `${result.prediction.pipeline_version}+${serving.champion}`,
        reasons: [`Served by ${serving.champion}, promoted after beating the previous model on unseen matches.`, ...(result.prediction.reasons ?? [])],
      },
    };
  } catch (err) {
    logger.warn({ err, fixtureId: match.id, champion: serving.champion }, "promoted champion unavailable; serving original formula");
    return result;
  }
}

// ── Worker ───────────────────────────────────────────────────────────────────

export async function runChallengerCycle() {
  let settled = 0, promoted: string | null = null, error: string | null = null;
  try {
    settled = await settleChallengerPredictions();
    await ensureStrengthModel();
    await refitCalibration();
    await refitLegacyCalibration();
    promoted = await runPromotionGate();
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    logger.warn({ err }, "challenger cycle failed");
  }
  // In-play challenger: separate table, separate gate (handles its own errors).
  await runInPlayCycle();
  lastRun = { at: new Date().toISOString(), settled, promoted, error };
  return lastRun;
}

export function startChallengerWorker() {
  if (workerTimer || process.env.MODEL_CHALLENGERS_ENABLED === "false") return;
  const interval = Number(process.env.CHALLENGER_CYCLE_MS ?? 30 * 60_000);
  const first = setTimeout(() => { void ensureTeamRatings(); void ensureStrengthModel(); void runChallengerCycle(); }, 90_000);
  first.unref();
  workerTimer = setInterval(() => { void runChallengerCycle(); }, interval);
  workerTimer.unref();
}

export function stopChallengerWorker() {
  if (workerTimer) clearInterval(workerTimer);
  workerTimer = null;
}
