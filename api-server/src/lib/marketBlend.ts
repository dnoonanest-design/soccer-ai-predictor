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

/**
 * 1X2 odds from both providers as no-vig percentages, one row per read.
 * API-Football rows (added 26 Oct 2026: they cover the ~60% of fixtures The
 * Odds API does not, and beat the formula there by 0.051 Brier on 96 unseen
 * matches) are dated by the provider's own update time. Set
 * APIF_ODDS_IN_PREDICTION=false to use The Odds API only.
 */
export const APIF_ODDS_IN_PREDICTION = process.env.APIF_ODDS_IN_PREDICTION !== "false";
const ODDS_1X2_SOURCE = `(
  SELECT fixture_id, bookmaker_key, implied_home_prob h, implied_draw_prob d, implied_away_prob a, observed_at, kickoff_at
    FROM market_odds_snapshots
  ${APIF_ODDS_IN_PREDICTION ? `UNION ALL
  SELECT fixture_id, 'apif-' || bookmaker_id,
         100 * (1 / home_odds) / (1 / home_odds + 1 / draw_odds + 1 / away_odds),
         100 * (1 / draw_odds) / (1 / home_odds + 1 / draw_odds + 1 / away_odds),
         100 * (1 / away_odds) / (1 / home_odds + 1 / draw_odds + 1 / away_odds),
         provider_updated_at AT TIME ZONE 'UTC', kickoff_at AT TIME ZONE 'UTC'
    FROM apif_odds_snapshots
   WHERE phase = 'prematch' AND home_odds > 1 AND draw_odds > 1 AND away_odds > 1` : ""}
) odds`;

/** Bookmakers' no-vig chance of over 2.5 goals and of both teams scoring (0-1). */
export type GoalConsensus = { over25: number | null; btts: number | null; bookmakers: number; observedAt: number };
let goalConsensus = new Map<number, GoalConsensus>();

/** Pure: average each bookmaker's no-vig two-way price. */
export function goalConsensusFrom(rows: Array<{ o: number | null; u: number | null; y: number | null; n: number | null; observedAt: number }>): GoalConsensus | null {
  const two = (a: number | null, b: number | null) => (a && b && a > 1 && b > 1 ? (1 / a) / (1 / a + 1 / b) : null);
  const over = rows.map((r) => two(r.o, r.u)).filter((v): v is number => v != null);
  const btts = rows.map((r) => two(r.y, r.n)).filter((v): v is number => v != null);
  if (!over.length && !btts.length) return null;
  const avg = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);
  return { over25: avg(over), btts: avg(btts), bookmakers: Math.max(over.length, btts.length), observedAt: Math.max(...rows.map((r) => r.observedAt)) };
}
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
            fixture_id, h, d, a, observed_at
       FROM ${ODDS_1X2_SOURCE}
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
  // Goal markets (API-Football only; The Odds API plan carries 1X2 only).
  const goals = await pool.query(
    `SELECT DISTINCT ON (fixture_id, bookmaker_id)
            fixture_id, over25_odds o, under25_odds u, btts_yes_odds y, btts_no_odds n, provider_updated_at t
       FROM apif_odds_snapshots
      WHERE phase = 'prematch' AND kickoff_at > NOW() - INTERVAL '3 hours' AND kickoff_at < NOW() + INTERVAL '8 days'
        AND provider_updated_at > NOW() - INTERVAL '36 hours'
        AND (over25_odds IS NOT NULL OR btts_yes_odds IS NOT NULL)
      ORDER BY fixture_id, bookmaker_id, provider_updated_at DESC`,
  ).catch(() => ({ rows: [] as any[] }));
  const gGrouped = new Map<number, Array<{ o: number | null; u: number | null; y: number | null; n: number | null; observedAt: number }>>();
  for (const r of goals.rows as any[]) {
    const id = Number(r.fixture_id); const list = gGrouped.get(id) ?? [];
    const num = (v: unknown) => (v == null ? null : Number(v));
    list.push({ o: num(r.o), u: num(r.u), y: num(r.y), n: num(r.n), observedAt: new Date(r.t).getTime() });
    gGrouped.set(id, list);
  }
  const gNext = new Map<number, GoalConsensus>();
  for (const [id, list] of gGrouped) { const c = goalConsensusFrom(list); if (c) gNext.set(id, c); }
  goalConsensus = gNext;
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
/** Latest stored goal-market consensus for a fixture, only if observed before `asOf`. */
export function getGoalConsensus(fixtureId: number, asOf = Date.now()): GoalConsensus | null {
  const c = goalConsensus.get(fixtureId);
  if (!c || c.observedAt > asOf || asOf - c.observedAt > MAX_PRICE_AGE_MS) return null;
  return c;
}

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
export function __setMarketConsensusForTests(entries: Array<[number, MarketConsensus]>, goals: Array<[number, GoalConsensus]> = []): void {
  consensus = new Map(entries);
  goalConsensus = new Map(goals);
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
      `SELECT bookmaker_key, EXTRACT(EPOCH FROM (kickoff_at - observed_at)) / 3600 AS hours, h, d, a
         FROM ${ODDS_1X2_SOURCE}
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

/**
 * Goal markets (26 Oct 2026 test, 185 settled matches with API-Football odds):
 * over 2.5 — app 0.255 Brier (said 62%, actual 55.7%), constant guess 0.247,
 * bookmakers 0.240; the fitted blend left 0% on the app. BTTS — app 0.253,
 * constant 0.247, bookmakers 0.245 (gain not yet certain on this sample).
 * So where these prices are stored, the served over 2.5 and BTTS are the
 * bookmakers' consensus. Over 1.5 / over 3.5 are kept consistent with it.
 */
export const GOAL_MARKETS_FROM_ODDS = process.env.GOAL_MARKETS_FROM_ODDS !== "false";
export type ServedGoals = { over_15: number | null; over_25: number | null; over_35: number | null; btts: number | null };
export type GoalsApplied = {
  goals: ServedGoals;
  independent_goals: { over_25: number | null; btts: number | null };
  goal_market_blend: { bookmakers: number; odds_observed_at: string; markets: Array<"over_25" | "btts"> };
};

/** Pure: replace over 2.5 / BTTS with the bookmakers' consensus and keep over 1.5 >= over 2.5 >= over 3.5. */
export function goalsWithMarket(served: ServedGoals, market: GoalConsensus): GoalsApplied | null {
  const pct = (v: number) => Math.round(v * 10_000) / 100;
  const over25 = market.over25 != null ? pct(market.over25) : served.over_25;
  const btts = market.btts != null ? pct(market.btts) : served.btts;
  const markets = [...(market.over25 != null ? ["over_25" as const] : []), ...(market.btts != null ? ["btts" as const] : [])];
  if (!markets.length) return null;
  return {
    goals: {
      over_15: served.over_15 == null || over25 == null ? served.over_15 : Math.max(served.over_15, over25),
      over_25: over25,
      over_35: served.over_35 == null || over25 == null ? served.over_35 : Math.min(served.over_35, over25),
      btts,
    },
    independent_goals: { over_25: served.over_25, btts: served.btts },
    goal_market_blend: { bookmakers: market.bookmakers, odds_observed_at: new Date(market.observedAt).toISOString(), markets },
  };
}

export async function goalMarketsForServedPrediction(fixtureId: number, status: string, kickoff: string, served: ServedGoals, now = Date.now()): Promise<GoalsApplied | null> {
  if (!MARKET_IN_PREDICTION_ENABLED || !GOAL_MARKETS_FROM_ODDS || status !== "upcoming" || !(Date.parse(kickoff) > now)) return null;
  await ensureMarketConsensus();
  const market = getGoalConsensus(fixtureId, now);
  return market ? goalsWithMarket(served, market) : null;
}
