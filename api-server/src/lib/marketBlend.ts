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
