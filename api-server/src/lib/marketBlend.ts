/**
 * Odds-informed pre-match forecast, shown beside the independent prediction.
 *
 * Odds test (25 Oct 2026, 322 unseen matches with stored odds):
 *   step9 alone 0.579 Brier, opening odds 0.566, closing odds 0.563, best
 *   step9/odds blend 0.563 (weight on step9 about 0.05-0.1). Odds movement
 *   from opening to closing added nothing once the latest price was known
 *   (the side the money moved to won 63 times; closing odds expected 63).
 *
 * So the bookmakers' current consensus, lightly blended with step9, is the
 * most accurate "who is likely to win" number available. It never replaces
 * the independent prediction: that one must stay free of odds so its value
 * flags still mean "the model disagrees with the market". The challenger
 * "step10-market-blend" records this forecast so it is scored on real results.
 *
 * Reads only prices already stored in market_odds_snapshots before the
 * forecast time; makes no odds-provider request.
 */
import { pool } from "@workspace/db";
import { logger } from "./logger";
import { forecastStrength } from "./strengthModel";

type Unit = { home: number; draw: number; away: number };

/** Weight on the model when blending; the rest goes to the market. */
export const MARKET_BLEND_MODEL_WEIGHT = Math.min(0.5, Math.max(0, Number(process.env.MARKET_BLEND_MODEL_WEIGHT ?? 0.1)));
const REFRESH_MS = 2 * 60_000;
/** Prices older than this before the forecast are not "current". */
const MAX_PRICE_AGE_MS = 36 * 60 * 60_000;

export type MarketConsensus = Unit & { bookmakers: number; observedAt: number };

let consensus = new Map<number, MarketConsensus>();
let refreshedAt = 0;
let refreshing: Promise<void> | null = null;

/** No-vig average across bookmakers' latest pre-kickoff prices (percent inputs -> 0-1). */
export function consensusFromRows(rows: Array<{ h: number; d: number; a: number; observedAt: number }>): MarketConsensus | null {
  const usable = rows.filter((r) => [r.h, r.d, r.a].every((v) => Number.isFinite(v) && v > 0));
  if (!usable.length) return null;
  const p = [0, 0, 0];
  for (const r of usable) {
    const t = r.h + r.d + r.a;
    p[0] += r.h / t / usable.length; p[1] += r.d / t / usable.length; p[2] += r.a / t / usable.length;
  }
  return { home: p[0], draw: p[1], away: p[2], bookmakers: usable.length, observedAt: Math.max(...usable.map((r) => r.observedAt)) };
}

/** Weighted average of model and market, renormalised. */
export function blendWithMarket(model: Unit, market: Unit, modelWeight = MARKET_BLEND_MODEL_WEIGHT): Unit {
  const w = Math.min(1, Math.max(0, modelWeight));
  const h = w * model.home + (1 - w) * market.home;
  const d = w * model.draw + (1 - w) * market.draw;
  const a = w * model.away + (1 - w) * market.away;
  const t = h + d + a;
  return { home: h / t, draw: d / t, away: a / t };
}

async function refresh(): Promise<void> {
  const res = await pool.query(
    `SELECT DISTINCT ON (fixture_id, bookmaker_key)
            fixture_id, implied_home_prob h, implied_draw_prob d, implied_away_prob a, observed_at
       FROM market_odds_snapshots
      WHERE kickoff_at > NOW() - INTERVAL '3 hours'
        AND kickoff_at < NOW() + INTERVAL '8 days'
        AND observed_at < kickoff_at
        AND observed_at > NOW() - INTERVAL '36 hours'
      ORDER BY fixture_id, bookmaker_key, observed_at DESC`,
  );
  const grouped = new Map<number, Array<{ h: number; d: number; a: number; observedAt: number }>>();
  for (const r of res.rows as any[]) {
    const id = Number(r.fixture_id);
    const list = grouped.get(id) ?? [];
    list.push({ h: Number(r.h), d: Number(r.d), a: Number(r.a), observedAt: new Date(r.observed_at).getTime() });
    grouped.set(id, list);
  }
  const next = new Map<number, MarketConsensus>();
  for (const [id, rows] of grouped) { const c = consensusFromRows(rows); if (c) next.set(id, c); }
  consensus = next;
  refreshedAt = Date.now();
}

/** Refresh the consensus cache at most every two minutes; never throws. */
export async function ensureMarketConsensus(): Promise<void> {
  if (Date.now() - refreshedAt < REFRESH_MS) return;
  refreshing ??= refresh()
    .catch((err) => { refreshedAt = Date.now(); logger.warn({ err }, "market consensus refresh failed"); })
    .finally(() => { refreshing = null; });
  await refreshing;
}

/** Latest stored consensus for a fixture, only if it was observed before `asOf`. */
export function getMarketConsensus(fixtureId: number, asOf = Date.now()): MarketConsensus | null {
  const c = consensus.get(fixtureId);
  if (!c || c.observedAt > asOf || asOf - c.observedAt > MAX_PRICE_AGE_MS) return null;
  return c;
}

type MatchLike = { id: number; league_id?: number | null; status: string; kickoff: string; home_team: { id: number }; away_team: { id: number } };

export type MarketInformed = {
  /** Percentages, 0-100. */
  home: number; draw: number; away: number;
  model: "step9-strength-ratings" | "market-only";
  model_weight: number;
  bookmakers: number;
  odds_observed_at: string;
};

/** The odds-informed forecast for one pre-match fixture, or null without stored odds. */
export function marketInformedForecast(match: MatchLike, now = Date.now()): MarketInformed | null {
  if (match.status !== "upcoming" || Date.parse(match.kickoff) <= now) return null;
  const market = getMarketConsensus(match.id, now);
  if (!market) return null;
  const s9 = forecastStrength(match.league_id ?? 0, match.home_team.id, match.away_team.id);
  // Only step9 was tested in a blend; without it, the market alone is the better number.
  const weight = s9 ? MARKET_BLEND_MODEL_WEIGHT : 0;
  const p = s9 ? blendWithMarket(s9.probs, market, weight) : { home: market.home, draw: market.draw, away: market.away };
  const home = Math.round(p.home * 10_000) / 100, draw = Math.round(p.draw * 10_000) / 100;
  return {
    home, draw, away: Math.round((100 - home - draw) * 100) / 100,
    model: s9 ? "step9-strength-ratings" : "market-only",
    model_weight: weight,
    bookmakers: market.bookmakers,
    odds_observed_at: new Date(market.observedAt).toISOString(),
  };
}

/** Test hook. */
export function __setMarketConsensusForTests(entries: Array<[number, MarketConsensus]>): void {
  consensus = new Map(entries);
  refreshedAt = Date.now();
}

// ── In play ──────────────────────────────────────────────────────────────────
//
// Live prices come from inplay_odds_snapshots (kept from the odds the app
// already downloads). A price is used only when it is fresh and was quoted at
// the current score, so a pre-goal price is never shown just after a goal.
// Not yet tested against results: the challenger "inplay-market-blend"
// records it at live checkpoints so it is scored on real outcomes.

export const INPLAY_MARKET_CHALLENGER = "inplay-market-blend";
/** The bookmaker must have updated the price within this window. */
export const LIVE_PRICE_MAX_AGE_MS = 2 * 60_000;
const LIVE_REFRESH_MS = 30_000;

export type LivePrice = { h: number; d: number; a: number; scoreHome: number | null; scoreAway: number | null; updatedAt: number };

let livePrices = new Map<number, LivePrice[]>();
let liveRefreshedAt = 0;
let liveRefreshing: Promise<void> | null = null;

async function refreshLive(): Promise<void> {
  const res = await pool.query(
    `SELECT DISTINCT ON (fixture_id, bookmaker_key)
            fixture_id, implied_home_prob h, implied_draw_prob d, implied_away_prob a,
            score_home, score_away, COALESCE(bookmaker_updated_at, observed_at) AS updated_at
       FROM inplay_odds_snapshots
      WHERE observed_at > NOW() - INTERVAL '10 minutes'
      ORDER BY fixture_id, bookmaker_key, observed_at DESC`,
  );
  const next = new Map<number, LivePrice[]>();
  for (const r of res.rows as any[]) {
    const id = Number(r.fixture_id);
    const list = next.get(id) ?? [];
    list.push({ h: Number(r.h), d: Number(r.d), a: Number(r.a),
      scoreHome: r.score_home == null ? null : Number(r.score_home), scoreAway: r.score_away == null ? null : Number(r.score_away),
      updatedAt: new Date(r.updated_at).getTime() });
    next.set(id, list);
  }
  livePrices = next;
  liveRefreshedAt = Date.now();
}

/** Refresh live prices at most every 30 seconds; never throws. */
export async function ensureLiveMarket(): Promise<void> {
  if (Date.now() - liveRefreshedAt < LIVE_REFRESH_MS) return;
  liveRefreshing ??= refreshLive()
    .catch((err) => { liveRefreshedAt = Date.now(); logger.warn({ err }, "live market refresh failed"); })
    .finally(() => { liveRefreshing = null; });
  await liveRefreshing;
}

/** Consensus of fresh prices quoted at exactly this score, or null. */
export function liveConsensusFrom(prices: LivePrice[], score: { home: number | null; away: number | null }, now: number): MarketConsensus | null {
  if (score.home == null || score.away == null) return null;
  const usable = prices.filter((p) => p.scoreHome === score.home && p.scoreAway === score.away
    && p.updatedAt <= now + 30_000 && now - p.updatedAt <= LIVE_PRICE_MAX_AGE_MS);
  return consensusFromRows(usable.map((p) => ({ h: p.h, d: p.d, a: p.a, observedAt: p.updatedAt })));
}

type LiveMatchLike = { id: number; status: string; score?: { home: number | null; away: number | null } | null };

export type LiveMarketInformed = Omit<MarketInformed, "model"> & { model: "live-model"; phase: "live" };

/**
 * Odds-informed in-play forecast: the live model (10%) blended with fresh
 * in-play prices at the current score. `served` is the live prediction in percent.
 */
export function liveMarketInformedForecast(match: LiveMatchLike, served: { home: number; draw: number; away: number }, now = Date.now()): LiveMarketInformed | null {
  if (match.status !== "live" || !match.score) return null;
  const market = liveConsensusFrom(livePrices.get(match.id) ?? [], match.score, now);
  if (!market) return null;
  const t = served.home + served.draw + served.away;
  if (!(t > 0)) return null;
  const model = { home: served.home / t, draw: served.draw / t, away: served.away / t };
  const p = blendWithMarket(model, market, MARKET_BLEND_MODEL_WEIGHT);
  const home = Math.round(p.home * 10_000) / 100, draw = Math.round(p.draw * 10_000) / 100;
  return {
    home, draw, away: Math.round((100 - home - draw) * 100) / 100,
    model: "live-model", phase: "live",
    model_weight: MARKET_BLEND_MODEL_WEIGHT,
    bookmakers: market.bookmakers,
    odds_observed_at: new Date(market.observedAt).toISOString(),
  };
}

/** Test hook. */
export function __setLivePricesForTests(entries: Array<[number, LivePrice[]]>): void {
  livePrices = new Map(entries);
  liveRefreshedAt = Date.now();
}

// ── Pre-match odds movement (3 days, 2 days, 1 day, latest) ─────────────────

export type MovementPoint = { label: string; hours_before: number; home: number; draw: number; away: number; bookmakers: number };
export type OddsMovement = { points: MovementPoint[]; shortening: "home" | "draw" | "away" | null; drifting: "home" | "draw" | "away" | null };

const MOVEMENT_TARGETS: Array<[string, number]> = [["3 days", 72], ["2 days", 48], ["1 day", 24]];
/** A read within this many hours of a checkpoint stands for it. */
const MOVEMENT_TOLERANCE_HOURS = 6;
/** Moves under 2 points are noise in the movement test. */
export const MOVEMENT_MIN_POINTS = 2;
const movementCache = new Map<number, { at: number; value: OddsMovement | null }>();

type Read = { book: string; hours: number; h: number; d: number; a: number };

/** Pure: consensus at each checkpoint (each book's read nearest to it) plus the latest. */
export function oddsMovementFrom(reads: Read[]): OddsMovement | null {
  if (!reads.length) return null;
  const books = [...new Set(reads.map((r) => r.book))];
  const pick = (choose: (list: Read[]) => Read | undefined) =>
    consensusFromRows(books.map((b) => choose(reads.filter((r) => r.book === b))).filter((r): r is Read => !!r)
      .map((r) => ({ h: r.h, d: r.d, a: r.a, observedAt: -r.hours })));
  const points: MovementPoint[] = [];
  const pct = (v: number) => Math.round(v * 1000) / 10;
  for (const [label, target] of MOVEMENT_TARGETS) {
    const c = pick((list) => list.filter((r) => Math.abs(r.hours - target) <= MOVEMENT_TOLERANCE_HOURS)
      .sort((x, y) => Math.abs(x.hours - target) - Math.abs(y.hours - target))[0]);
    if (c) points.push({ label, hours_before: target, home: pct(c.home), draw: pct(c.draw), away: pct(c.away), bookmakers: c.bookmakers });
  }
  const latest = pick((list) => [...list].sort((x, y) => x.hours - y.hours)[0]);
  if (latest) {
    const hours = Math.round(-latest.observedAt * 10) / 10;
    // Only add "latest" if it is a different moment from the last checkpoint.
    if (!points.length || points[points.length - 1].hours_before - hours > MOVEMENT_TOLERANCE_HOURS / 2) {
      points.push({ label: "Latest", hours_before: hours, home: pct(latest.home), draw: pct(latest.draw), away: pct(latest.away), bookmakers: latest.bookmakers });
    }
  }
  if (points.length < 2) return { points, shortening: null, drifting: null };
  const first = points[0], last = points[points.length - 1];
  const moves = (["home", "draw", "away"] as const).map((k) => [k, last[k] - first[k]] as const);
  const most = moves.reduce((a, b) => (b[1] > a[1] ? b : a)), least = moves.reduce((a, b) => (b[1] < a[1] ? b : a));
  return {
    points,
    shortening: most[1] >= MOVEMENT_MIN_POINTS ? most[0] : null,
    drifting: least[1] <= -MOVEMENT_MIN_POINTS ? least[0] : null,
  };
}

/** Stored pre-match reads for one fixture, summarised; cached for two minutes. */
export async function getOddsMovement(fixtureId: number): Promise<OddsMovement | null> {
  const hit = movementCache.get(fixtureId);
  if (hit && Date.now() - hit.at < REFRESH_MS) return hit.value;
  let value: OddsMovement | null = null;
  try {
    const res = await pool.query(
      `SELECT bookmaker_key, EXTRACT(EPOCH FROM (kickoff_at - observed_at)) / 3600 AS hours,
              implied_home_prob h, implied_draw_prob d, implied_away_prob a
         FROM market_odds_snapshots
        WHERE fixture_id = $1 AND kickoff_at IS NOT NULL AND observed_at < kickoff_at
          AND observed_at >= kickoff_at - INTERVAL '80 hours'`,
      [fixtureId],
    );
    value = oddsMovementFrom(res.rows.map((r: any) => ({ book: String(r.bookmaker_key), hours: Number(r.hours), h: Number(r.h), d: Number(r.d), a: Number(r.a) })));
  } catch (err) {
    logger.warn({ err, fixtureId }, "odds movement unavailable");
  }
  movementCache.set(fixtureId, { at: Date.now(), value });
  if (movementCache.size > 2000) movementCache.delete(movementCache.keys().next().value!);
  return value;
}

// ── Odds in the served pre-match prediction (25-26 Oct 2026 decision) ──────
//
// Test on 476 settled, sealed pre-match predictions with odds stored before
// the prediction was captured: the original formula 0.637 Brier / 46.6%
// correct; bookmakers' consensus at that moment 0.569 / 56.3% (gain 0.068
// ±0.022); the fitted blend put 0% on the formula; adding opening-to-latest
// movement made it slightly worse (0.574). For step 9 the tested best was
// 10% step 9 / 90% odds.
//
// So, where odds are stored, the served pre-match 1X2 numbers are the market
// consensus blended with the serving model at the weight below. Value flags
// and model-vs-model trials keep using the odds-free numbers (`independent`),
// otherwise they would compare the market with itself. Goal markets are not
// changed (only 1X2 prices are stored).

/** Weight left on each serving model when odds are available (the rest is the market). */
export const SERVED_MODEL_WEIGHT: Record<string, number> = {
  legacy: Number(process.env.SERVED_LEGACY_MODEL_WEIGHT ?? 0),
  "step9-strength-ratings": MARKET_BLEND_MODEL_WEIGHT,
};
export const SERVED_DEFAULT_MODEL_WEIGHT = MARKET_BLEND_MODEL_WEIGHT;
export const MARKET_IN_PREDICTION_ENABLED = process.env.MARKET_IN_PREDICTION_ENABLED !== "false";

export type ServedPercent = { home_win: number; draw: number; away_win: number };
export type MarketApplied = {
  probs: ServedPercent;
  independent: { home: number; draw: number; away: number; model: string };
  market_blend: { model_weight: number; bookmakers: number; odds_observed_at: string };
};

/** Pure: blend the served percentages with a consensus (0-1) at the serving model's weight. */
export function servedWithMarket(served: ServedPercent, servingModel: string, market: MarketConsensus): MarketApplied | null {
  const t = served.home_win + served.draw + served.away_win;
  if (!(t > 0)) return null;
  const weight = Math.min(1, Math.max(0, SERVED_MODEL_WEIGHT[servingModel] ?? SERVED_DEFAULT_MODEL_WEIGHT));
  const p = blendWithMarket({ home: served.home_win / t, draw: served.draw / t, away: served.away_win / t }, market, weight);
  const home = Math.round(p.home * 10_000) / 100, draw = Math.round(p.draw * 10_000) / 100;
  return {
    probs: { home_win: home, draw, away_win: Math.round((100 - home - draw) * 100) / 100 },
    independent: { home: served.home_win, draw: served.draw, away: served.away_win, model: servingModel },
    market_blend: { model_weight: weight, bookmakers: market.bookmakers, odds_observed_at: new Date(market.observedAt).toISOString() },
  };
}

/** Odds-adjusted served numbers for an upcoming fixture, or null without fresh stored odds. */
export async function marketForServedPrediction(fixtureId: number, status: string, kickoff: string, served: ServedPercent, servingModel: string, now = Date.now()): Promise<MarketApplied | null> {
  if (!MARKET_IN_PREDICTION_ENABLED || status !== "upcoming" || !(Date.parse(kickoff) > now)) return null;
  await ensureMarketConsensus();
  const market = getMarketConsensus(fixtureId, now);
  return market ? servedWithMarket(served, servingModel, market) : null;
}
