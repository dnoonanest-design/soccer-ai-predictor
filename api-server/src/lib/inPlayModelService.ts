/**
 * In-play challenger.
 *
 * The live model turns the pre-match expected goals into probabilities for the
 * rest of the match using six hand-set multipliers (team behind 1.18, team
 * ahead 0.85, red cards 0.68 / 1.12, telemetry spread 0.6, live-xG slope 0.12).
 * This service fits those six numbers on settled live snapshots
 * (deep_match_stats joined to match_outcomes), keeps the fit only when it beats
 * the hand-set values on the newest 20% of fixtures, and then records the
 * fitted model beside the live model at every live checkpoint. It serves only
 * after passing its own promotion gate on matches it never saw, judged per
 * fixture (checkpoints of one match are not independent).
 *
 * Pre-match and in-play results stay apart: these rows live in
 * model_inplay_predictions, never in the pre-match challenger table.
 */
import { pool } from "@workspace/db";
import type { Match } from "./soccerService";
import type { CanonicalPredictionResult } from "./canonicalPredictionService";
import {
  DEFAULT_INPLAY_PARAMS,
  liveScoreAdjustedProbs,
  type InPlayParams,
  type LiveMatchStatsInput,
} from "./enhancedStatsService";
import { applyDataQualityReliability } from "./predictionDataQuality";
import { logger } from "./logger";

type Unit = { home: number; draw: number; away: number };
type Outcome = "home" | "draw" | "away";

export const INPLAY_CHALLENGER = "inplay-fitted";

export const INPLAY_RULES = {
  minFitFixtures: Number(process.env.INPLAY_MIN_FIT_FIXTURES ?? 150),
  minFixtures: Number(process.env.INPLAY_MIN_FIXTURES ?? 200),
  minBrierImprovement: Number(process.env.INPLAY_MIN_BRIER_GAIN ?? 0.003),
  minTStat: Number(process.env.INPLAY_MIN_TSTAT ?? 3),
  minDaysBetweenPromotions: 7,
  autoPromote: process.env.INPLAY_AUTO_PROMOTE !== "false",
};

const BOUNDS: Record<keyof InPlayParams, [number, number]> = {
  trailing: [0.8, 1.7],
  leading: [0.55, 1.2],
  redOwn: [0.35, 1.0],
  redOpp: [0.9, 1.6],
  telemetrySpread: [0, 1.2],
  liveXgSlope: [0, 0.4],
};
const KEYS = Object.keys(BOUNDS) as Array<keyof InPlayParams>;

// ── Pure fitting ─────────────────────────────────────────────────────────────

export type InPlaySnapshot = {
  fixtureId: number;
  at: number;
  minute: number;
  scoreHome: number;
  scoreAway: number;
  lambdaHome: number;
  lambdaAway: number;
  liveStats?: LiveMatchStatsInput;
  outcome: Outcome;
};

export function snapshotProbs(s: InPlaySnapshot, params: InPlayParams): Unit {
  const p = liveScoreAdjustedProbs(s.scoreHome, s.scoreAway, s.minute, s.lambdaHome, s.lambdaAway, s.liveStats, params);
  return { home: p.homeWin / 100, draw: p.draw / 100, away: p.awayWin / 100 };
}

export function meanLogLoss(rows: InPlaySnapshot[], params: InPlayParams): number {
  if (!rows.length) return Infinity;
  let sum = 0;
  for (const r of rows) sum -= Math.log(Math.max(1e-6, snapshotProbs(r, params)[r.outcome]));
  return sum / rows.length;
}

export function meanBrier(rows: InPlaySnapshot[], params: InPlayParams): number {
  if (!rows.length) return Infinity;
  let sum = 0;
  for (const r of rows) {
    const p = snapshotProbs(r, params);
    sum += (p.home - (r.outcome === "home" ? 1 : 0)) ** 2 + (p.draw - (r.outcome === "draw" ? 1 : 0)) ** 2 + (p.away - (r.outcome === "away" ? 1 : 0)) ** 2;
  }
  return sum / rows.length;
}

const clamp = (k: keyof InPlayParams, v: number) => Math.max(BOUNDS[k][0], Math.min(BOUNDS[k][1], v));

/** Bounded pattern search on mean log loss, starting from the hand-set values. */
export async function fitInPlayParams(
  rows: InPlaySnapshot[],
  start: InPlayParams = DEFAULT_INPLAY_PARAMS,
  rounds = 30,
  yieldEvery?: () => Promise<void>,
): Promise<InPlayParams> {
  let best: InPlayParams = { ...start };
  let bestLoss = meanLogLoss(rows, best);
  const step: Record<keyof InPlayParams, number> = Object.fromEntries(
    KEYS.map((k) => [k, (BOUNDS[k][1] - BOUNDS[k][0]) / 8]),
  ) as Record<keyof InPlayParams, number>;
  for (let r = 0; r < rounds; r++) {
    let improved = false;
    for (const k of KEYS) {
      for (const dir of [1, -1]) {
        const trial = { ...best, [k]: clamp(k, best[k] + dir * step[k]) };
        if (trial[k] === best[k]) continue;
        const loss = meanLogLoss(rows, trial);
        if (loss < bestLoss - 1e-9) { best = trial; bestLoss = loss; improved = true; break; }
      }
      if (yieldEvery) await yieldEvery();
    }
    if (!improved) {
      for (const k of KEYS) step[k] /= 2;
      if (KEYS.every((k) => step[k] < 1e-3)) break;
    }
  }
  return best;
}

/**
 * Chronological holdout: fit on the oldest 80% of fixtures, compare with the
 * hand-set values on the newest 20%. Returns the parameters refitted on all
 * fixtures only when the holdout improved; otherwise null (keep hand-set).
 */
export async function fitWithHoldout(rows: InPlaySnapshot[], minFixtures: number, yieldEvery?: () => Promise<void>) {
  const fixtures = [...new Map(rows.map((r) => [r.fixtureId, r.at])).entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
  if (fixtures.length < minFixtures) {
    return { params: null, fixtures: fixtures.length, snapshots: rows.length, holdout: null as null | Record<string, number>, reason: `needs ${minFixtures} settled live fixtures (has ${fixtures.length})` };
  }
  const cut = new Set(fixtures.slice(Math.floor(fixtures.length * 0.8)));
  const train = rows.filter((r) => !cut.has(r.fixtureId)), test = rows.filter((r) => cut.has(r.fixtureId));
  const trainFit = await fitInPlayParams(train, DEFAULT_INPLAY_PARAMS, 30, yieldEvery);
  const holdout = {
    fixtures: cut.size,
    defaultLogLoss: round4(meanLogLoss(test, DEFAULT_INPLAY_PARAMS)),
    fittedLogLoss: round4(meanLogLoss(test, trainFit)),
    defaultBrier: round4(meanBrier(test, DEFAULT_INPLAY_PARAMS)),
    fittedBrier: round4(meanBrier(test, trainFit)),
  };
  if (!(holdout.fittedLogLoss < holdout.defaultLogLoss && holdout.fittedBrier <= holdout.defaultBrier)) {
    return { params: null, fixtures: fixtures.length, snapshots: rows.length, holdout, reason: "fitted values did not beat the hand-set values on the newest 20% of fixtures" };
  }
  const params = await fitInPlayParams(rows, trainFit, 30, yieldEvery);
  return { params: roundParams(params), fixtures: fixtures.length, snapshots: rows.length, holdout, reason: null as string | null };
}

const round4 = (v: number) => Math.round(v * 10_000) / 10_000;
const roundParams = (p: InPlayParams): InPlayParams =>
  Object.fromEntries(KEYS.map((k) => [k, round4(p[k])])) as InPlayParams;

// ── Data ─────────────────────────────────────────────────────────────────────

const num = (v: unknown) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/** Expected goals the live model used at that moment (player form and substitutions included). */
export function liveLambdas(enhanced: any): { home: number; away: number } | null {
  const hx = num(enhanced?.home_xg), ax = num(enhanced?.away_xg);
  if (hx == null || ax == null || hx <= 0 || ax <= 0) return null;
  const hf = num(enhanced?.live_player_performance?.home_factor) ?? 1;
  const af = num(enhanced?.live_player_performance?.away_factor) ?? 1;
  return {
    home: Math.max(0.01, hx * hf + (num(enhanced?.home_sub_xg_delta) ?? 0)),
    away: Math.max(0.01, ax * af + (num(enhanced?.away_sub_xg_delta) ?? 0)),
  };
}

async function loadSnapshots(): Promise<InPlaySnapshot[]> {
  // One snapshot per fixture per 15-minute block; only fixtures with a result.
  const result = await pool.query(
    `SELECT DISTINCT ON (d.fixture_id, d.minute / 15)
            d.fixture_id, d.minute, d.score_home, d.score_away, d.raw_stats_json, d.collected_at, o.outcome
       FROM deep_match_stats d
       JOIN match_outcomes o ON o.fixture_id = d.fixture_id
      WHERE d.status = 'live' AND d.minute BETWEEN 15 AND 89
        AND d.score_home IS NOT NULL AND d.score_away IS NOT NULL
        AND d.collected_at > NOW() - INTERVAL '540 days'
      ORDER BY d.fixture_id, d.minute / 15, d.collected_at ASC
      LIMIT 40000`,
  );
  const rows: InPlaySnapshot[] = [];
  for (const r of result.rows as any[]) {
    const raw = typeof r.raw_stats_json === "string" ? JSON.parse(r.raw_stats_json) : r.raw_stats_json;
    const lambdas = liveLambdas(raw?.enhanced);
    if (!lambdas || !["home", "draw", "away"].includes(String(r.outcome))) continue;
    rows.push({
      fixtureId: Number(r.fixture_id),
      at: new Date(r.collected_at).getTime(),
      minute: Number(r.minute),
      scoreHome: Number(r.score_home),
      scoreAway: Number(r.score_away),
      lambdaHome: lambdas.home,
      lambdaAway: lambdas.away,
      liveStats: { home: raw?.home ?? undefined, away: raw?.away ?? undefined },
      outcome: String(r.outcome) as Outcome,
    });
  }
  return rows;
}

// ── State ────────────────────────────────────────────────────────────────────

let fitted: InPlayParams | null = null;
let lastFit: Record<string, unknown> | null = null;
let serving: { champion: string; params: InPlayParams | null; since: Date | null; at: number } | null = null;
let fitTimer: NodeJS.Timeout | null = null;
let fitting: Promise<void> | null = null;

export async function refitInPlayModel(): Promise<Record<string, unknown>> {
  if (!fitting) {
    fitting = (async () => {
      try {
        const rows = await loadSnapshots();
        const out = await fitWithHoldout(rows, INPLAY_RULES.minFitFixtures, () => new Promise((r) => setImmediate(r)));
        fitted = out.params;
        lastFit = { at: new Date().toISOString(), ...out };
        logger.info({ fit: lastFit }, "in-play model refit");
      } catch (err) {
        lastFit = { at: new Date().toISOString(), error: err instanceof Error ? err.message : String(err) };
        logger.warn({ err }, "in-play model refit failed");
      } finally {
        fitting = null;
      }
    })();
  }
  await fitting;
  return lastFit ?? {};
}

async function getInPlayServing(fresh = false) {
  if (!fresh && serving && Date.now() - serving.at < 60_000) return serving;
  try {
    const r = await pool.query(`SELECT inplay_champion, inplay_params, inplay_updated_at FROM model_serving_state WHERE id = 1`);
    const row = r.rows[0];
    const champion = row?.inplay_champion ? String(row.inplay_champion) : "legacy";
    const params = row?.inplay_params ? (typeof row.inplay_params === "string" ? JSON.parse(row.inplay_params) : row.inplay_params) : null;
    serving = { champion, params, since: row?.inplay_updated_at ? new Date(row.inplay_updated_at) : null, at: Date.now() };
  } catch {
    serving = { champion: "legacy", params: null, since: null, at: Date.now() };
  }
  return serving;
}

// ── Serving and capture ──────────────────────────────────────────────────────

function fittedProbsPercent(match: Match, result: CanonicalPredictionResult, params: InPlayParams): Unit | null {
  const raw = result.prediction as any;
  const stats = result.stats;
  if (!stats?.home || !stats?.away || match.minute == null || match.score?.home == null || match.score?.away == null) return null;
  const lambdas = liveLambdas(raw);
  if (!lambdas) return null;
  const p = liveScoreAdjustedProbs(match.score.home, match.score.away, match.minute, lambdas.home, lambdas.away,
    { home: stats.home as any, away: stats.away as any }, params);
  // Same data-quality step the live model goes through, so only the six
  // multipliers differ between the two.
  const q = applyDataQualityReliability({ home: p.homeWin, draw: p.draw, away: p.awayWin }, stats.home, stats.away, raw.confidence_score ?? null);
  return q.probabilities;
}

/**
 * Called for every live prediction. Adds the model that is not serving as
 * inplay_alternative (for recording at checkpoints), and swaps in the fitted
 * model's numbers once it has been promoted.
 */
export async function applyInPlayModel(match: Match, result: CanonicalPredictionResult): Promise<CanonicalPredictionResult> {
  try {
    const state = await getInPlayServing();
    const pred = result.prediction;
    if (pred.prediction_source !== "statistical-model") return result;
    if (state.champion === INPLAY_CHALLENGER && state.params) {
      const p = fittedProbsPercent(match, result, state.params);
      if (!p) return result;
      const fair = (v: number) => (v > 0 ? Math.round((100 / v) * 100) / 100 : 0);
      return {
        ...result,
        prediction: {
          ...pred,
          home_win: p.home, draw: p.draw, away_win: p.away,
          fair_home_odds: fair(p.home), fair_draw_odds: fair(p.draw), fair_away_odds: fair(p.away),
          serving_model: INPLAY_CHALLENGER,
          inplay_alternative: { model: "legacy", home: pred.home_win, draw: pred.draw, away: pred.away_win },
        },
      };
    }
    if (!fitted) return result;
    const p = fittedProbsPercent(match, result, fitted);
    if (!p) return result;
    return { ...result, prediction: { ...pred, inplay_alternative: { model: INPLAY_CHALLENGER, ...p } } };
  } catch (err) {
    logger.warn({ err, fixtureId: match.id }, "in-play model unavailable; serving live model");
    return result;
  }
}

/** Store the alternative beside the sealed live checkpoint (both 0-1). */
export async function recordInPlayChallenger(
  match: Match,
  checkpoint: string,
  champion: Unit,
  alternative: { model: string; home: number; draw: number; away: number } | undefined,
): Promise<boolean> {
  if (!alternative || match.minute == null) return false;
  const p = { home: alternative.home / 100, draw: alternative.draw / 100, away: alternative.away / 100 };
  if (![p.home, p.draw, p.away].every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) return false;
  const params = alternative.model === INPLAY_CHALLENGER ? ((await getInPlayServing()).champion === INPLAY_CHALLENGER ? serving?.params : fitted) : null;
  const r = await pool.query(
    `INSERT INTO model_inplay_predictions
       (fixture_id, league_id, challenger, checkpoint, minute,
        home_win_prob, draw_prob, away_win_prob, champion_home_prob, champion_draw_prob, champion_away_prob, params)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (fixture_id, challenger, checkpoint) DO NOTHING`,
    [match.id, match.league_id ?? null, alternative.model, checkpoint, match.minute,
      p.home, p.draw, p.away, champion.home, champion.draw, champion.away, params ? JSON.stringify(params) : null],
  );
  return (r.rowCount ?? 0) > 0;
}

// ── Settlement, report, gate ─────────────────────────────────────────────────

export async function settleInPlayPredictions(): Promise<number> {
  const r = await pool.query(
    `WITH s AS (
       SELECT c.id, o.outcome,
              (o.outcome = 'home')::int yh, (o.outcome = 'draw')::int yd, (o.outcome = 'away')::int ya
         FROM model_inplay_predictions c JOIN match_outcomes o ON o.fixture_id = c.fixture_id
        WHERE c.settled_at IS NULL AND o.outcome IN ('home','draw','away')
     )
     UPDATE model_inplay_predictions c
        SET actual_outcome = s.outcome,
            brier_score = POWER(c.home_win_prob - s.yh, 2) + POWER(c.draw_prob - s.yd, 2) + POWER(c.away_win_prob - s.ya, 2),
            champion_brier_score = POWER(c.champion_home_prob - s.yh, 2) + POWER(c.champion_draw_prob - s.yd, 2) + POWER(c.champion_away_prob - s.ya, 2),
            log_loss = -LN(GREATEST(1e-6, CASE s.outcome WHEN 'home' THEN c.home_win_prob WHEN 'draw' THEN c.draw_prob ELSE c.away_win_prob END)),
            champion_log_loss = -LN(GREATEST(1e-6, CASE s.outcome WHEN 'home' THEN c.champion_home_prob WHEN 'draw' THEN c.champion_draw_prob ELSE c.champion_away_prob END)),
            settled_at = NOW()
       FROM s WHERE c.id = s.id`,
  );
  return r.rowCount ?? 0;
}

export async function getInPlayReport() {
  const state = await getInPlayServing(true);
  const since = state.since ?? new Date(0);
  // Per-fixture averages first: checkpoints of one match share its result.
  const r = await pool.query(
    `WITH per_fixture AS (
       SELECT challenger, fixture_id,
              AVG(brier_score) b, AVG(champion_brier_score) cb,
              AVG(champion_brier_score - brier_score) g, AVG(champion_log_loss - log_loss) lg,
              COUNT(*) n
         FROM model_inplay_predictions
        WHERE settled_at IS NOT NULL AND captured_at >= $1
        GROUP BY challenger, fixture_id
     )
     SELECT challenger, COUNT(*)::int fixtures, SUM(n)::int checkpoints,
            AVG(b) brier, AVG(cb) champion_brier, AVG(g) gain, STDDEV_SAMP(g) gain_sd, AVG(lg) ll_gain
       FROM per_fixture GROUP BY challenger`,
    [since],
  );
  const pending = await pool.query(
    `SELECT challenger, COUNT(DISTINCT fixture_id)::int n FROM model_inplay_predictions
      WHERE settled_at IS NULL AND captured_at >= $1 GROUP BY challenger`,
    [since],
  );
  const pendingBy = new Map<string, number>(pending.rows.map((x: any) => [String(x.challenger), Number(x.n)]));
  const n4 = (v: unknown) => (v == null || !Number.isFinite(Number(v)) ? null : round4(Number(v)));
  const byId = new Map<string, any>(r.rows.map((x: any) => [String(x.challenger), x]));
  const ids = new Set<string>([...byId.keys(), ...pendingBy.keys()]);
  const standings = [...ids].map((id) => {
    const x = byId.get(id) ?? {};
    const fixtures = Number(x.fixtures ?? 0), gain = n4(x.gain), sd = Number(x.gain_sd), llGain = n4(x.ll_gain);
    const tStat = gain != null && Number.isFinite(sd) && sd > 0 && fixtures > 1 ? Math.round((gain / (sd / Math.sqrt(fixtures))) * 100) / 100 : null;
    const reasons: string[] = [];
    if (fixtures < INPLAY_RULES.minFixtures) reasons.push(`needs ${INPLAY_RULES.minFixtures} settled live fixtures (has ${fixtures})`);
    if (gain == null || gain < INPLAY_RULES.minBrierImprovement) reasons.push(`Brier gain must be at least ${INPLAY_RULES.minBrierImprovement}`);
    if (tStat == null || tStat < INPLAY_RULES.minTStat) reasons.push(`gain must be at least ${INPLAY_RULES.minTStat} standard errors from zero (per fixture)`);
    if (llGain == null || llGain <= 0) reasons.push("log loss must also improve");
    return {
      challenger: id, pending: pendingBy.get(id) ?? 0, fixtures, checkpoints: Number(x.checkpoints ?? 0),
      brier: n4(x.brier), championBrier: n4(x.champion_brier), brierGain: gain, tStat, logLossGain: llGain,
      eligible: reasons.length === 0, reasons,
    };
  });
  return {
    champion: state.champion,
    championSince: state.since?.toISOString() ?? null,
    servingParams: state.champion === INPLAY_CHALLENGER ? state.params : DEFAULT_INPLAY_PARAMS,
    fittedParams: fitted,
    defaultParams: DEFAULT_INPLAY_PARAMS,
    lastFit,
    rules: INPLAY_RULES,
    standings,
    note: "In-play results only. Each challenger is compared with the live model at the same checkpoints; the gate counts fixtures, not checkpoints.",
  };
}

export async function runInPlayGate(): Promise<string | null> {
  const report = await getInPlayReport();
  if (!INPLAY_RULES.autoPromote || report.champion === INPLAY_CHALLENGER) return null;
  const winner = report.standings.find((s) => s.challenger === INPLAY_CHALLENGER && s.eligible);
  if (!winner || !fitted) return null;
  const recent = await pool.query(
    `SELECT 1 FROM model_promotion_log WHERE new_champion LIKE 'inplay%' AND decided_at > NOW() - ($1 || ' days')::interval LIMIT 1`,
    [String(INPLAY_RULES.minDaysBetweenPromotions)],
  );
  if (recent.rowCount) return null;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE model_serving_state SET inplay_champion = $1, inplay_params = $2, inplay_updated_at = NOW() WHERE id = 1`,
      [INPLAY_CHALLENGER, JSON.stringify(fitted)],
    );
    await client.query(
      `INSERT INTO model_promotion_log (previous_champion, new_champion, evidence) VALUES ($1, $2, $3)`,
      [`inplay:${report.champion}`, INPLAY_CHALLENGER, JSON.stringify({ ...winner, params: fitted, rules: INPLAY_RULES })],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  serving = null;
  logger.info({ evidence: winner, params: fitted }, "in-play challenger promoted");
  return INPLAY_CHALLENGER;
}

export async function rollbackInPlay(reason: string) {
  const state = await getInPlayServing(true);
  if (state.champion === "legacy") return false;
  await pool.query(`UPDATE model_serving_state SET inplay_champion = 'legacy', inplay_params = NULL, inplay_updated_at = NOW() WHERE id = 1`);
  await pool.query(
    `INSERT INTO model_promotion_log (previous_champion, new_champion, evidence) VALUES ($1, 'inplay:legacy', $2)`,
    [state.champion, JSON.stringify({ manualRollback: true, reason })],
  );
  serving = null;
  return true;
}

let lastCycle: Record<string, unknown> | null = null;
export async function runInPlayCycle() {
  let settled = 0, promoted: string | null = null, error: string | null = null;
  try {
    settled = await settleInPlayPredictions();
    promoted = await runInPlayGate();
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    logger.warn({ err }, "in-play challenger cycle failed");
  }
  lastCycle = { at: new Date().toISOString(), settled, promoted, error };
  return lastCycle;
}
export const getInPlayLastCycle = () => lastCycle;

export function startInPlayWorker() {
  if (fitTimer || process.env.MODEL_CHALLENGERS_ENABLED === "false") return;
  const first = setTimeout(() => { void refitInPlayModel(); }, 3 * 60_000);
  first.unref();
  fitTimer = setInterval(() => { void refitInPlayModel(); }, Number(process.env.INPLAY_REFIT_MS ?? 12 * 60 * 60_000));
  fitTimer.unref();
}

export function stopInPlayWorker() {
  if (fitTimer) clearInterval(fitTimer);
  fitTimer = null;
}

/** Test hook. */
export function __setFittedInPlayParams(p: InPlayParams | null) { fitted = p; serving = null; }
