/**
 * Goal markets (over 2.5 goals, both teams to score) with their own champion.
 *
 * Audit, 24 Nov 2026, on 601 settled matches: the original formula's goal
 * numbers were no better than quoting the league average (over 2.5 Brier
 * 0.248 vs 0.248 constant; BTTS 0.259 vs 0.249), while step 9's beat it
 * (0.241 and 0.248). The gains were t = 1.7 and t = 2.8, short of the t >= 3
 * the app asks for, so step 9's goal numbers serve only after passing this
 * gate on matches settled after the gate went live as well as before.
 *
 * Only the model's OWN goal numbers change: the 30% bookmaker share is added
 * afterwards exactly as before, and 1X2 numbers are untouched. Step 9 reads no
 * odds, so the served goal numbers stay led by the app's own process.
 */
import { pool } from "@workspace/db";
import type { CanonicalPredictionResult } from "./canonicalPredictionService";
import type { PredictionMatch } from "./predictionInputBoundary";
import { ensureStrengthModel, forecastStrength } from "./strengthModel";
import { logger } from "./logger";

export const GOAL_CHALLENGER = "step9-strength-ratings";

export const GOAL_RULES = {
  minMatches: Number(process.env.GOAL_GATE_MIN_MATCHES ?? 300),
  /** Average Brier gain across the two markets, per match. */
  minBrierGain: Number(process.env.GOAL_GATE_MIN_BRIER_GAIN ?? 0.003),
  minTStat: Number(process.env.GOAL_GATE_MIN_TSTAT ?? 3),
  /** Neither market may get worse by more than this (Brier). */
  maxMarketLoss: 0.002,
  autoPromote: process.env.GOAL_GATE_AUTO_PROMOTE !== "false",
};

type GoalRow = { o25: number; bt: number; co25: number; cbt: number; oa: boolean; ba: boolean };

/** Pure: per-market and combined Brier gains of the challenger over the champion, with a paired t. */
export function goalGateEvidence(rows: GoalRow[]) {
  const n = rows.length;
  const sq = (p: number, y: boolean) => (p - (y ? 1 : 0)) ** 2;
  const dO = rows.map((r) => sq(r.co25, r.oa) - sq(r.o25, r.oa));
  const dB = rows.map((r) => sq(r.cbt, r.ba) - sq(r.bt, r.ba));
  const dC = dO.map((v, i) => (v + dB[i]) / 2);
  const mean = (d: number[]) => (d.length ? d.reduce((s, v) => s + v, 0) / d.length : 0);
  const tstat = (d: number[]) => {
    if (d.length < 2) return 0;
    const m = mean(d), sd = Math.sqrt(d.reduce((s, v) => s + (v - m) ** 2, 0) / (d.length - 1));
    return sd > 0 ? m / (sd / Math.sqrt(d.length)) : 0;
  };
  const r4 = (v: number) => Math.round(v * 10_000) / 10_000;
  const evidence = {
    matches: n,
    over25Gain: r4(mean(dO)), bttsGain: r4(mean(dB)),
    combinedGain: r4(mean(dC)), tStat: Math.round(tstat(dC) * 100) / 100,
  };
  const reasons: string[] = [];
  if (n < GOAL_RULES.minMatches) reasons.push(`needs ${GOAL_RULES.minMatches} settled matches (has ${n})`);
  if (evidence.combinedGain < GOAL_RULES.minBrierGain) reasons.push(`goal-market Brier gain must be at least ${GOAL_RULES.minBrierGain}`);
  if (evidence.tStat < GOAL_RULES.minTStat) reasons.push(`gain must be at least ${GOAL_RULES.minTStat} standard errors from zero`);
  if (evidence.over25Gain < -GOAL_RULES.maxMarketLoss) reasons.push("over 2.5 must not get worse");
  if (evidence.bttsGain < -GOAL_RULES.maxMarketLoss) reasons.push("both teams to score must not get worse");
  return { ...evidence, eligible: reasons.length === 0, reasons };
}

let cache: { champion: string; since: Date | null; at: number } | null = null;

async function getGoalChampion(fresh = false) {
  if (!fresh && cache && Date.now() - cache.at < 60_000) return cache;
  try {
    const r = await pool.query(`SELECT goal_champion, goal_champion_since FROM model_serving_state WHERE id = 1`);
    cache = { champion: r.rows[0]?.goal_champion ?? "legacy", since: r.rows[0]?.goal_champion_since ? new Date(r.rows[0].goal_champion_since) : null, at: Date.now() };
  } catch {
    cache = { champion: "legacy", since: null, at: Date.now() };
  }
  return cache;
}

export async function getGoalMarketReport() {
  const state = await getGoalChampion(true);
  const res = await pool.query(
    `SELECT DISTINCT ON (fixture_id) over25_prob o25, btts_prob bt, champion_over25_prob co25, champion_btts_prob cbt, over25_actual oa, btts_actual ba
       FROM model_challenger_predictions
      WHERE challenger = $1 AND settled_at IS NOT NULL AND captured_at < kickoff_at
        AND over25_prob IS NOT NULL AND btts_prob IS NOT NULL AND champion_over25_prob IS NOT NULL AND champion_btts_prob IS NOT NULL
        AND over25_actual IS NOT NULL AND btts_actual IS NOT NULL
        AND captured_at >= $2
      ORDER BY fixture_id, captured_at DESC`,
    [GOAL_CHALLENGER, state.since ?? new Date(0)],
  );
  const rows: GoalRow[] = (res.rows as any[]).map((r) => ({ o25: +r.o25, bt: +r.bt, co25: +r.co25, cbt: +r.cbt, oa: Boolean(r.oa), ba: Boolean(r.ba) }));
  return {
    champion: state.champion,
    championSince: state.since?.toISOString() ?? null,
    challenger: GOAL_CHALLENGER,
    rules: GOAL_RULES,
    standing: state.champion === GOAL_CHALLENGER ? null : goalGateEvidence(rows),
    note: "Goal markets only (over 2.5, both teams to score): the model's own numbers before the 30% bookmaker share. 1X2 has its own gate.",
  };
}

export async function runGoalMarketGate(): Promise<boolean> {
  if (!GOAL_RULES.autoPromote) return false;
  const report = await getGoalMarketReport();
  if (report.champion !== "legacy" || !report.standing?.eligible) return false;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE model_serving_state SET goal_champion = $1, goal_champion_since = NOW() WHERE id = 1`, [GOAL_CHALLENGER]);
    await client.query(
      `INSERT INTO model_promotion_log (previous_champion, new_champion, evidence) VALUES ('goals:legacy', $1, $2)`,
      [`goals:${GOAL_CHALLENGER}`, JSON.stringify({ ...report.standing, rules: GOAL_RULES })],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  cache = null;
  logger.info({ evidence: report.standing }, "goal-market champion promoted");
  return true;
}

export async function rollbackGoalMarkets(reason: string): Promise<boolean> {
  const state = await getGoalChampion(true);
  if (state.champion === "legacy") return false;
  await pool.query(`UPDATE model_serving_state SET goal_champion = 'legacy', goal_champion_since = NOW() WHERE id = 1`);
  await pool.query(
    `INSERT INTO model_promotion_log (previous_champion, new_champion, evidence) VALUES ($1, 'goals:legacy', $2)`,
    [`goals:${state.champion}`, JSON.stringify({ manualRollback: true, reason })],
  );
  cache = null;
  return true;
}

/** Pure: replace the own goal numbers, keeping over 1.5 >= over 2.5 >= over 3.5. */
export function withGoalNumbers(m: { over15: number; over25: number; over35: number; btts: number }) {
  const over25 = m.over25;
  return {
    over_15: Math.max(m.over15, over25),
    over_25: over25,
    over_35: Math.min(m.over35, over25),
    btts: m.btts,
  };
}

/**
 * Pre-match: once promoted, step 9's goal numbers replace the formula's own.
 * Matches step 9 cannot rate keep the formula's numbers.
 */
export async function applyGoalChampion(match: PredictionMatch, result: CanonicalPredictionResult): Promise<CanonicalPredictionResult> {
  try {
    if (match.status !== "upcoming") return result;
    const state = await getGoalChampion();
    if (state.champion !== GOAL_CHALLENGER || result.prediction.serving_model === GOAL_CHALLENGER) return result;
    await ensureStrengthModel();
    const f = forecastStrength(match.league_id, match.home_team.id, match.away_team.id);
    if (!f) return result;
    return {
      ...result,
      prediction: {
        ...result.prediction,
        ...withGoalNumbers(f.markets),
        goal_model: GOAL_CHALLENGER,
        pipeline_version: `${result.prediction.pipeline_version}+goals-${GOAL_CHALLENGER}`,
      },
    };
  } catch (err) {
    logger.warn({ err, fixtureId: match.id }, "goal-market champion unavailable; serving formula goal numbers");
    return result;
  }
}

/** Test hook. */
export function __setGoalChampionForTests(champion: string) { cache = { champion, since: null, at: Date.now() }; }
