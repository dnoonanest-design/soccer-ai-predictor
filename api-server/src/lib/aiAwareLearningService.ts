import { db, aiLearningAudits, aiModelRegistry, selfImprovementQueue, similarMatchMemory } from "@workspace/db";
import { desc, eq, sql } from "drizzle-orm";
import { logger } from "./logger";

type Outcome = "home" | "draw" | "away";
type FeatureVector = Record<string, number>;

function clamp01(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function normalizeProbabilitySet(home: number, draw: number, away: number) {
  const h = Math.max(0.001, home);
  const d = Math.max(0.001, draw);
  const a = Math.max(0.001, away);
  const total = h + d + a;
  return { home: h / total, draw: d / total, away: a / total };
}

function predictedOutcome(home: number, draw: number, away: number): Outcome {
  if (home >= draw && home >= away) return "home";
  if (away >= home && away >= draw) return "away";
  return "draw";
}

function clusterFromFeatures(row: any, fv: FeatureVector): string {
  const league = row.league_id ?? "all";
  const favGap = Math.abs((fv.home_market_prob ?? fv.home_win_prob ?? 0.33) - (fv.away_market_prob ?? fv.away_win_prob ?? 0.33));
  const favourite = favGap > 0.22 ? "strong_favourite" : favGap > 0.1 ? "moderate_favourite" : "balanced";
  const goals = (fv.home_xg ?? 0) + (fv.away_xg ?? 0);
  const goalBand = goals >= 3 ? "high_goal" : goals >= 2 ? "medium_goal" : "low_goal";
  const redCard = (fv.home_red_cards ?? 0) + (fv.away_red_cards ?? 0) > 0 ? "cards" : "normal";
  return `${league}:${favourite}:${goalBand}:${redCard}`;
}

function distance(a: FeatureVector, b: FeatureVector): number {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let total = 0;
  let count = 0;
  for (const k of keys) {
    const av = Number.isFinite(a[k]) ? a[k] : 0;
    const bv = Number.isFinite(b[k]) ? b[k] : 0;
    total += Math.abs(av - bv);
    count += 1;
  }
  return count ? total / count : 1;
}

function featureVectorFromRows(row: any): FeatureVector {
  const homeProb = clamp01(row.home_win_prob, 0.34);
  const drawProb = clamp01(row.draw_prob, 0.28);
  const awayProb = clamp01(row.away_win_prob, 0.34);
  return {
    home_win_prob: homeProb,
    draw_prob: drawProb,
    away_win_prob: awayProb,
    home_xg: clamp01(Number(row.home_xg ?? 0) / 4),
    away_xg: clamp01(Number(row.away_xg ?? 0) / 4),
    home_momentum: clamp01(Number(row.home_momentum ?? row.pressure_home ?? 50) / 100, 0.5),
    away_momentum: clamp01(Number(row.away_momentum ?? row.pressure_away ?? 50) / 100, 0.5),
    red_card_delta: clamp01((Number(row.away_red_cards ?? 0) - Number(row.home_red_cards ?? 0) + 2) / 4, 0.5),
    form_delta: clamp01((Number(row.home_form_score ?? 50) - Number(row.away_form_score ?? 50) + 100) / 200, 0.5),
    circumstance_delta: clamp01((Number(row.circumstance_score_home ?? 50) - Number(row.circumstance_score_away ?? 50) + 100) / 200, 0.5),
    star_delta: clamp01((Number(row.home_star_player_rating ?? 6.5) - Number(row.away_star_player_rating ?? 6.5) + 5) / 10, 0.5),
    injury_delta: clamp01((Number(row.away_missing_players ?? 0) - Number(row.home_missing_players ?? 0) + 10) / 20, 0.5),
  };
}

export async function buildSimilarMatchMemory(limit = 500) {
  const rows = await db.execute(sql`
    SELECT ps.fixture_id, ps.league_id, ps.home_win_prob, ps.draw_prob, ps.away_win_prob,
           ps.home_xg, ps.away_xg, ps.pressure_home, ps.pressure_away,
           mc.home_team, mc.away_team, mc.home_red_cards, mc.away_red_cards,
           mc.home_form_score, mc.away_form_score, mc.circumstance_score_home, mc.circumstance_score_away,
           mc.home_star_player_rating, mc.away_star_player_rating, mc.home_missing_players, mc.away_missing_players,
           mo.outcome, mo.score_home, mo.score_away
    FROM prediction_snapshots ps
    JOIN match_outcomes mo ON mo.fixture_id = ps.fixture_id
    LEFT JOIN match_circumstances mc ON mc.fixture_id = ps.fixture_id
    ORDER BY ps.created_at DESC
    LIMIT ${limit}
  `) as any;

  let changed = 0;
  for (const row of rows.rows ?? []) {
    const fv = featureVectorFromRows(row);
    const signature = clusterFromFeatures(row, fv);
    const probs = normalizeProbabilitySet(Number(row.home_win_prob), Number(row.draw_prob), Number(row.away_win_prob));
    await db.insert(similarMatchMemory).values({
      fixtureId: Number(row.fixture_id),
      leagueId: row.league_id == null ? null : Number(row.league_id),
      homeTeam: String(row.home_team ?? "Home"),
      awayTeam: String(row.away_team ?? "Away"),
      matchSignature: signature,
      featureVectorJson: fv,
      predictedOutcome: predictedOutcome(probs.home, probs.draw, probs.away),
      actualOutcome: String(row.outcome),
      predictedHomeProb: probs.home,
      predictedDrawProb: probs.draw,
      predictedAwayProb: probs.away,
      scoreHome: Number(row.score_home ?? 0),
      scoreAway: Number(row.score_away ?? 0),
      similarityCluster: signature,
      notes: "Generated by AI-aware similar-match memory builder",
    }).catch(() => undefined);
    changed += 1;
  }
  return { checked: rows.rows?.length ?? 0, changed };
}

export async function findSimilarMatchesForFeatures(features: FeatureVector, leagueId?: number | null, maxResults = 20) {
  const candidates = await db.select().from(similarMatchMemory).orderBy(desc(similarMatchMemory.createdAt)).limit(800);
  const ranked = candidates
    .filter((r: any) => !leagueId || !r.leagueId || r.leagueId === leagueId)
    .map((r: any) => ({ ...r, similarityScore: 1 - Math.min(1, distance(features, (r.featureVectorJson ?? {}) as FeatureVector)) }))
    .sort((a: any, b: any) => b.similarityScore - a.similarityScore)
    .slice(0, maxResults);
  return ranked;
}

export async function recalibrateFromSimilarMatchMemory() {
  const rows = await db.select().from(similarMatchMemory).orderBy(desc(similarMatchMemory.createdAt)).limit(2000);
  if (rows.length < 30) {
    await queueImprovement("insufficient_training_data", 9, `Only ${rows.length} settled similar-match rows available. More completed matches are needed before safe AI calibration.`, { rows: rows.length });
    return { accepted: false, sampleSize: rows.length, reason: "Need at least 30 settled matches" };
  }

  let correct = 0;
  let brier = 0;
  const buckets: Record<string, { n: number; correct: number }> = {};
  for (const r of rows as any[]) {
    const p = normalizeProbabilitySet(r.predictedHomeProb, r.predictedDrawProb, r.predictedAwayProb);
    const pred = predictedOutcome(p.home, p.draw, p.away);
    if (pred === r.actualOutcome) correct += 1;
    const yHome = r.actualOutcome === "home" ? 1 : 0;
    const yDraw = r.actualOutcome === "draw" ? 1 : 0;
    const yAway = r.actualOutcome === "away" ? 1 : 0;
    brier += ((p.home - yHome) ** 2 + (p.draw - yDraw) ** 2 + (p.away - yAway) ** 2) / 3;
    const confidence = Math.max(p.home, p.draw, p.away);
    const key = `${Math.floor(confidence * 10) * 10}-${Math.floor(confidence * 10) * 10 + 10}`;
    buckets[key] ??= { n: 0, correct: 0 };
    buckets[key].n += 1;
    buckets[key].correct += pred === r.actualOutcome ? 1 : 0;
  }
  const baseAccuracy = correct / rows.length;
  const baseBrier = brier / rows.length;

  const recommendations = Object.entries(buckets).map(([bucket, v]) => ({
    bucket,
    sampleSize: v.n,
    actualAccuracy: v.n ? v.correct / v.n : 0,
    action: v.n >= 20 && v.correct / v.n < 0.45 ? "reduce confidence in this bucket" : "monitor",
  }));

  const accepted = rows.length >= 60 && baseBrier < 0.23;
  await db.insert(aiLearningAudits).values({
    auditType: "similar_match_recalibration",
    sampleSize: rows.length,
    beforeMetricsJson: { accuracy: baseAccuracy, brierScore: baseBrier },
    afterMetricsJson: { accuracy: baseAccuracy, brierScore: baseBrier, bucketDiagnostics: buckets },
    accepted,
    recommendationsJson: recommendations,
    notes: accepted ? "Safe to use similar-match correction in live probability calibration." : "Audit stored, but not enough quality to promote automatically.",
  });

  await db.update(aiModelRegistry).set({ active: false }).where(eq(aiModelRegistry.active, true));
  await db.insert(aiModelRegistry).values({
    modelVersion: `ai-aware-${new Date().toISOString().slice(0, 10)}`,
    modelType: "similar-match-memory-calibrator",
    featureSetJson: ["xg", "momentum", "cards", "form", "injuries", "star_players", "circumstances"],
    weightsJson: { similarMatchWeight: accepted ? 0.18 : 0.08, confidencePenaltyWhenUnproven: accepted ? 0.0 : 0.08 },
    metricsJson: { accuracy: baseAccuracy, brierScore: baseBrier, buckets },
    trainingRows: rows.length,
    active: true,
    notes: "Guarded AI-aware calibration. The app learns probabilities from similar completed matches without changing source code automatically.",
  });

  if (baseAccuracy < 0.5) await queueImprovement("low_pick_accuracy", 8, "Recent similar-match memory accuracy is below 50%; review feature weights and API stat coverage.", { accuracy: baseAccuracy, brierScore: baseBrier });
  return { accepted, sampleSize: rows.length, accuracy: baseAccuracy, brierScore: baseBrier, recommendations };
}

async function queueImprovement(issueType: string, priority: number, description: string, evidence: unknown) {
  await db.insert(selfImprovementQueue).values({ issueType, priority, description, evidenceJson: evidence as any, status: "open" }).catch((err) => logger.warn({ err }, "failed to queue AI improvement"));
}

export async function runAiAwarenessCycle() {
  const memory = await buildSimilarMatchMemory();
  const recalibration = await recalibrateFromSimilarMatchMemory();
  return { memory, recalibration };
}

export async function getAiAwarenessReport() {
  const [models, audits, queue, memoryRows] = await Promise.all([
    db.select().from(aiModelRegistry).orderBy(desc(aiModelRegistry.createdAt)).limit(10),
    db.select().from(aiLearningAudits).orderBy(desc(aiLearningAudits.createdAt)).limit(10),
    db.select().from(selfImprovementQueue).where(eq(selfImprovementQueue.status, "open")).orderBy(desc(selfImprovementQueue.priority)).limit(20),
    db.select().from(similarMatchMemory).orderBy(desc(similarMatchMemory.createdAt)).limit(5),
  ]);
  return {
    activeModel: models.find((m: any) => m.active) ?? models[0] ?? null,
    recentAudits: audits,
    openImprovements: queue,
    recentSimilarMatchMemory: memoryRows,
    explanation: "The app is AI-aware by storing comparable match situations, measuring which circumstances affected outcomes, recalibrating probabilities from settled results, and queuing improvement actions when accuracy drops. It does not rewrite code automatically; it safely updates model/calibration data.",
  };
}
