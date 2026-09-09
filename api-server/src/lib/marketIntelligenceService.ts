import { db, marketAssessments, marketOddsSnapshots, matchOutcomes, predictionSnapshots } from "@workspace/db";
import { and, asc, desc, eq, lte } from "drizzle-orm";
import { logger } from "./logger";

export type ThreeWayProbabilities = { home: number; draw: number; away: number };

export interface BookmakerOddsInput {
  bookmakerKey: string;
  homeDecimal: number;
  drawDecimal: number;
  awayDecimal: number;
  sourceUpdatedAt: Date;
  raw?: unknown;
}

export interface MarketAssessmentResult {
  asOf: string;
  independent: ThreeWayProbabilities;
  market: ThreeWayProbabilities;
  assisted: ThreeWayProbabilities;
  disagreement: ThreeWayProbabilities;
  marketWeight: number;
  movementStrength: number;
  consensusScore: number;
  bookmakerCount: number;
  movement: ThreeWayProbabilities;
  explanation: string[];
}

const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const capturedSourceObservations = new Set<string>();

function unitProb(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value > 1 ? value / 100 : value;
}

export function normaliseThreeWay(probs: ThreeWayProbabilities): ThreeWayProbabilities {
  const home = Math.max(0, unitProb(probs.home));
  const draw = Math.max(0, unitProb(probs.draw));
  const away = Math.max(0, unitProb(probs.away));
  const total = home + draw + away;
  if (total <= 0) return { home: 1 / 3, draw: 1 / 3, away: 1 / 3 };
  return { home: home / total, draw: draw / total, away: away / total };
}

/** Convert decimal prices to fair probabilities after removing overround. */
export function removeBookmakerMargin(odds: {
  home: number;
  draw: number;
  away: number;
}): { fair: ThreeWayProbabilities; overround: number } | null {
  if (![odds.home, odds.draw, odds.away].every((price) => Number.isFinite(price) && price > 1)) return null;
  const raw = { home: 1 / odds.home, draw: 1 / odds.draw, away: 1 / odds.away };
  const book = raw.home + raw.draw + raw.away;
  if (book <= 0) return null;
  return {
    fair: { home: raw.home / book, draw: raw.draw / book, away: raw.away / book },
    overround: book - 1,
  };
}

function average(rows: ThreeWayProbabilities[]): ThreeWayProbabilities {
  const count = rows.length || 1;
  return normaliseThreeWay({
    home: rows.reduce((sum, row) => sum + row.home, 0) / count,
    draw: rows.reduce((sum, row) => sum + row.draw, 0) / count,
    away: rows.reduce((sum, row) => sum + row.away, 0) / count,
  });
}

function roundProbabilities(probs: ThreeWayProbabilities): ThreeWayProbabilities {
  return {
    home: Math.round(probs.home * 10000) / 10000,
    draw: Math.round(probs.draw * 10000) / 10000,
    away: Math.round(probs.away * 10000) / 10000,
  };
}

export function calculateMarketAssessment(input: {
  independent: ThreeWayProbabilities;
  opening: ThreeWayProbabilities[];
  latest: ThreeWayProbabilities[];
  asOf?: Date;
  maxMarketWeight?: number;
}): MarketAssessmentResult | null {
  if (!input.latest.length) return null;
  const independent = normaliseThreeWay(input.independent);
  const market = average(input.latest.map(normaliseThreeWay));
  const opening = input.opening.length ? average(input.opening.map(normaliseThreeWay)) : market;
  const bookmakerCount = input.latest.length;

  // Total-variation distance is a stable 0..1 measure of the overall move.
  const movementStrength = clamp(
    (Math.abs(market.home - opening.home) + Math.abs(market.draw - opening.draw) + Math.abs(market.away - opening.away)) / 2,
  );
  const avgDispersion = input.latest.reduce((sum, row) => {
    const p = normaliseThreeWay(row);
    return sum + (Math.abs(p.home - market.home) + Math.abs(p.draw - market.draw) + Math.abs(p.away - market.away)) / 3;
  }, 0) / bookmakerCount;
  const consensusScore = clamp(1 - avgDispersion * 4);
  const coverage = clamp(bookmakerCount / 4);
  const cap = clamp(input.maxMarketWeight ?? 0.15, 0, 0.25);

  // Market influence is intentionally small. It rises only with bookmaker
  // coverage, agreement and meaningful movement; it can never replace the
  // independent statistical prediction.
  const marketWeight = Math.min(cap, coverage * consensusScore * (0.02 + movementStrength * 0.5));
  const assisted = normaliseThreeWay({
    home: independent.home * (1 - marketWeight) + market.home * marketWeight,
    draw: independent.draw * (1 - marketWeight) + market.draw * marketWeight,
    away: independent.away * (1 - marketWeight) + market.away * marketWeight,
  });
  const disagreement = {
    home: independent.home - market.home,
    draw: independent.draw - market.draw,
    away: independent.away - market.away,
  };
  const movement = {
    home: market.home - opening.home,
    draw: market.draw - opening.draw,
    away: market.away - opening.away,
  };
  const largest = (Object.entries(disagreement) as Array<[keyof ThreeWayProbabilities, number]>)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0];
  const explanation = [
    `${bookmakerCount} bookmaker${bookmakerCount === 1 ? "" : "s"} available at the prediction cutoff.`,
    `Market influence capped at ${(cap * 100).toFixed(0)}%; applied weight ${(marketWeight * 100).toFixed(1)}%.`,
    `Largest model-market difference: ${largest[0]} ${(largest[1] * 100).toFixed(1)} percentage points.`,
  ];

  return {
    asOf: (input.asOf ?? new Date()).toISOString(),
    independent: roundProbabilities(independent),
    market: roundProbabilities(market),
    assisted: roundProbabilities(assisted),
    disagreement: roundProbabilities(disagreement),
    marketWeight: Math.round(marketWeight * 10000) / 10000,
    movementStrength: Math.round(movementStrength * 10000) / 10000,
    consensusScore: Math.round(consensusScore * 10000) / 10000,
    bookmakerCount,
    movement: roundProbabilities(movement),
    explanation,
  };
}

export async function captureMarketOdds(input: {
  fixtureId: number;
  providerEventId?: string | null;
  kickoffAt?: Date | null;
  isInPlay: boolean;
  observedAt?: Date;
  bookmakers: BookmakerOddsInput[];
}): Promise<number> {
  const observedAt = input.observedAt ?? new Date();
  const values = input.bookmakers.flatMap((bookmaker) => {
    const observationKey = `${input.fixtureId}:${bookmaker.bookmakerKey}:h2h:${bookmaker.sourceUpdatedAt.toISOString()}`;
    if (capturedSourceObservations.has(observationKey)) return [];
    const converted = removeBookmakerMargin({
      home: bookmaker.homeDecimal,
      draw: bookmaker.drawDecimal,
      away: bookmaker.awayDecimal,
    });
    if (!converted) return [];
    return [{
      fixtureId: input.fixtureId,
      providerEventId: input.providerEventId ?? null,
      bookmakerKey: bookmaker.bookmakerKey,
      marketKey: "h2h",
      homeDecimal: bookmaker.homeDecimal,
      drawDecimal: bookmaker.drawDecimal,
      awayDecimal: bookmaker.awayDecimal,
      homeFairProb: converted.fair.home,
      drawFairProb: converted.fair.draw,
      awayFairProb: converted.fair.away,
      overround: converted.overround,
      isInPlay: input.isInPlay,
      kickoffAt: input.kickoffAt ?? null,
      sourceUpdatedAt: bookmaker.sourceUpdatedAt,
      observedAt,
      rawJson: bookmaker.raw ?? null,
      observationKey,
    }];
  });
  if (!values.length) return 0;
  try {
    const dbValues = values.map(({ observationKey: _observationKey, ...value }) => value);
    const inserted = await db.insert(marketOddsSnapshots).values(dbValues).onConflictDoNothing().returning({ id: marketOddsSnapshots.id });
    for (const value of values) capturedSourceObservations.add(value.observationKey);
    if (capturedSourceObservations.size > 20_000) capturedSourceObservations.clear();
    return inserted.length;
  } catch (err) {
    logger.warn({ err, fixtureId: input.fixtureId }, "failed to capture market odds snapshots");
    return 0;
  }
}

export async function getMarketAssessment(
  fixtureId: number,
  independent: ThreeWayProbabilities,
  asOf = new Date(),
): Promise<MarketAssessmentResult | null> {
  // observedAt is the leakage barrier: a stale provider timestamp does not make
  // data available before this application actually observed it.
  const rows = await db.select().from(marketOddsSnapshots)
    .where(and(eq(marketOddsSnapshots.fixtureId, fixtureId), lte(marketOddsSnapshots.observedAt, asOf)))
    .orderBy(asc(marketOddsSnapshots.observedAt));
  if (!rows.length) return null;

  const first = new Map<string, ThreeWayProbabilities>();
  const latest = new Map<string, ThreeWayProbabilities>();
  for (const row of rows) {
    const probs = { home: row.homeFairProb, draw: row.drawFairProb, away: row.awayFairProb };
    if (!first.has(row.bookmakerKey)) first.set(row.bookmakerKey, probs);
    latest.set(row.bookmakerKey, probs);
  }
  const result = calculateMarketAssessment({ independent, opening: [...first.values()], latest: [...latest.values()], asOf });
  if (!result) return null;

  try {
    await db.insert(marketAssessments).values({
      fixtureId,
      predictionAt: asOf,
      independentHomeProb: result.independent.home,
      independentDrawProb: result.independent.draw,
      independentAwayProb: result.independent.away,
      marketHomeProb: result.market.home,
      marketDrawProb: result.market.draw,
      marketAwayProb: result.market.away,
      assistedHomeProb: result.assisted.home,
      assistedDrawProb: result.assisted.draw,
      assistedAwayProb: result.assisted.away,
      marketWeight: result.marketWeight,
      movementStrength: result.movementStrength,
      consensusScore: result.consensusScore,
      bookmakerCount: result.bookmakerCount,
      isInPlay: rows[rows.length - 1]?.isInPlay ?? false,
      explanationJson: { movement: result.movement, disagreement: result.disagreement, explanation: result.explanation },
    });
  } catch (err) {
    logger.warn({ err, fixtureId }, "failed to save market assessment");
  }
  return result;
}

export async function getMarketHistory(fixtureId: number, limit = 250) {
  return db.select().from(marketOddsSnapshots)
    .where(eq(marketOddsSnapshots.fixtureId, fixtureId))
    .orderBy(desc(marketOddsSnapshots.observedAt))
    .limit(Math.min(Math.max(limit, 1), 1000));
}

export async function assessLatestIndependentPrediction(fixtureId: number, asOf = new Date()) {
  // Use an immutable prediction snapshot from at/before the same cutoff. The
  // upserted match_predictions row may have been updated later and would leak.
  const rows = await db.select().from(predictionSnapshots)
    .where(and(eq(predictionSnapshots.fixtureId, fixtureId), lte(predictionSnapshots.createdAt, asOf)))
    .orderBy(desc(predictionSnapshots.createdAt))
    .limit(1);
  const prediction = rows[0];
  if (!prediction) return null;
  return getMarketAssessment(fixtureId, {
    home: prediction.homeWinProb,
    draw: prediction.drawProb,
    away: prediction.awayWinProb,
  }, asOf);
}

export async function getMarketPerformanceReport() {
  const rows = await db.select({
    fixtureId: marketAssessments.fixtureId,
    predictionAt: marketAssessments.predictionAt,
    independentHome: marketAssessments.independentHomeProb,
    independentDraw: marketAssessments.independentDrawProb,
    independentAway: marketAssessments.independentAwayProb,
    marketHome: marketAssessments.marketHomeProb,
    marketDraw: marketAssessments.marketDrawProb,
    marketAway: marketAssessments.marketAwayProb,
    assistedHome: marketAssessments.assistedHomeProb,
    assistedDraw: marketAssessments.assistedDrawProb,
    assistedAway: marketAssessments.assistedAwayProb,
    actual: matchOutcomes.outcome,
  }).from(marketAssessments)
    .innerJoin(matchOutcomes, eq(marketAssessments.fixtureId, matchOutcomes.fixtureId))
    .where(eq(marketAssessments.isInPlay, false))
    .orderBy(desc(marketAssessments.predictionAt));

  // Evaluate one frozen pre-match assessment per fixture to avoid counting a
  // frequently refreshed match more heavily than other matches.
  const unique = new Map<number, typeof rows[number]>();
  for (const row of rows) if (!unique.has(row.fixtureId)) unique.set(row.fixtureId, row);
  const samples = [...unique.values()];
  const keys = ["home", "draw", "away"] as const;
  const metric = (kind: "independent" | "market" | "assisted") => {
    let brier = 0;
    let logLoss = 0;
    let correct = 0;
    for (const row of samples) {
      const probs = kind === "independent"
        ? [row.independentHome, row.independentDraw, row.independentAway]
        : kind === "market"
          ? [row.marketHome, row.marketDraw, row.marketAway]
          : [row.assistedHome, row.assistedDraw, row.assistedAway];
      const actualIndex = Math.max(0, keys.indexOf(row.actual as typeof keys[number]));
      const pickIndex = probs.indexOf(Math.max(...probs));
      if (pickIndex === actualIndex) correct++;
      for (let i = 0; i < 3; i++) brier += Math.pow(probs[i] - (i === actualIndex ? 1 : 0), 2);
      logLoss -= Math.log(clamp(probs[actualIndex], 1e-6, 1 - 1e-6));
    }
    const n = samples.length;
    return {
      sampleSize: n,
      pickAccuracy: n ? Math.round((correct / n) * 10000) / 10000 : null,
      brierScore: n ? Math.round((brier / n) * 10000) / 10000 : null,
      logLoss: n ? Math.round((logLoss / n) * 10000) / 10000 : null,
    };
  };
  return {
    sampleSize: samples.length,
    independent: metric("independent"),
    market: metric("market"),
    marketAssisted: metric("assisted"),
    note: "One latest pre-match assessment per settled fixture; lower Brier score and log loss are better.",
  };
}
