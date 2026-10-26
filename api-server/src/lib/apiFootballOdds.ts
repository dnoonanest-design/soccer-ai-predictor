/**
 * Bookmaker odds from API-Football (match result, over/under 2.5, both teams
 * to score), pre-match and in play, stored in apif_odds_snapshots.
 *
 * Why: The Odds API covers about 40% of the app's fixtures and only 1X2 on
 * the current plan. API-Football's odds cover far more leagues and the goal
 * markets, from the existing API-Football allowance (no Odds API credits).
 * Collection only: nothing here changes a prediction. They are tested first
 * (see the backfill, which stores the final pre-match odds of matches from
 * the last week so tests do not have to wait).
 */
import { pool } from "@workspace/db";
import { fetchFootball } from "./soccerService";
import { logger } from "./logger";
import { isTrackedLeague } from "./leagueConfig";
import { CHECKPOINT_WINDOW_HOURS } from "./marketOddsSamplingPolicy";

export type BookOdds = {
  id: number; name: string | null;
  home: number | null; draw: number | null; away: number | null;
  over25: number | null; under25: number | null; bttsYes: number | null; bttsNo: number | null;
};
export type ParsedPrematch = { fixtureId: number; leagueId: number | null; kickoff: string | null; updated: string | null; books: BookOdds[] };
export type ParsedLive = { fixtureId: number; leagueId: number | null; minute: number | null; scoreHome: number | null; scoreAway: number | null; updated: string | null; usable: boolean; odds: Omit<BookOdds, "id" | "name"> };

type ApiValue = { value?: string | number | null; odd?: string | number | null; handicap?: string | number | null; main?: boolean | null; suspended?: boolean | null };
type ApiBet = { id?: number; name?: string; values?: ApiValue[] };

const price = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 1 ? n : null;
};
const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();

/** Full-match markets only: "Goals Over/Under First Half" and similar are skipped. */
function isFullMatch(name: string) {
  return !/half|1st|2nd|first|second|corner|card|team|home|away|asian|exact|odd\/even/.test(name);
}

/** Read 1X2, over/under 2.5 and BTTS prices from one list of bets. */
export function readMarkets(bets: ApiBet[] = []): Omit<BookOdds, "id" | "name"> {
  const out: Omit<BookOdds, "id" | "name"> = { home: null, draw: null, away: null, over25: null, under25: null, bttsYes: null, bttsNo: null };
  for (const bet of bets) {
    const name = norm(bet.name);
    const values = (bet.values ?? []).filter((v) => !v.suspended);
    const find = (label: string) => price(values.find((v) => norm(v.value) === label)?.odd);
    if (/^(match winner|fulltime result|full time result|1x2)$/.test(name)) {
      out.home ??= find("home"); out.draw ??= find("draw"); out.away ??= find("away");
    } else if (/^(goals over\/under|over\/under|over\/under line|total goals)$/.test(name) && isFullMatch(name)) {
      // Pre-match values read "Over 2.5"; live values read "Over" with handicap "2.5".
      const at = (side: "over" | "under") => price(values.find((v) => norm(v.value) === `${side} 2.5`
        || (norm(v.value) === side && String(v.handicap ?? "").trim() === "2.5"))?.odd);
      out.over25 ??= at("over"); out.under25 ??= at("under");
    } else if (/^both teams (to )?score$/.test(name)) {
      out.bttsYes ??= find("yes"); out.bttsNo ??= find("no");
    }
  }
  return out;
}

export function parsePrematch(item: any): ParsedPrematch | null {
  const fixtureId = Number(item?.fixture?.id);
  if (!(fixtureId > 0)) return null;
  const books: BookOdds[] = [];
  for (const b of item?.bookmakers ?? []) {
    const id = Number(b?.id);
    if (!(id >= 0)) continue;
    const m = readMarkets(b?.bets);
    if (Object.values(m).some((v) => v != null)) books.push({ id, name: b?.name ?? null, ...m });
  }
  return { fixtureId, leagueId: Number(item?.league?.id) || null, kickoff: item?.fixture?.date ?? null, updated: item?.update ?? null, books };
}

export function parseLive(item: any): ParsedLive | null {
  const fixtureId = Number(item?.fixture?.id);
  if (!(fixtureId > 0)) return null;
  const st = item?.status ?? {};
  const g = (v: unknown) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  return {
    fixtureId,
    leagueId: Number(item?.league?.id) || null,
    minute: g(item?.fixture?.status?.elapsed),
    scoreHome: g(item?.teams?.home?.goals), scoreAway: g(item?.teams?.away?.goals),
    updated: item?.update ?? null,
    // Prices are not meaningful while the provider has the market stopped or blocked.
    usable: !st.stopped && !st.blocked && !st.finished,
    odds: readMarkets(item?.odds),
  };
}

async function insertRow(r: {
  fixtureId: number; leagueId: number | null; kickoff: Date | null; phase: "prematch" | "live"; source: "sampler" | "backfill" | "live";
  bookId: number; bookName: string | null; minute?: number | null; scoreHome?: number | null; scoreAway?: number | null;
  o: Omit<BookOdds, "id" | "name">; updated: Date;
}): Promise<number> {
  try {
    const res = await pool.query(
      `INSERT INTO apif_odds_snapshots
         (fixture_id, league_id, kickoff_at, phase, source, bookmaker_id, bookmaker_name, minute, score_home, score_away,
          home_odds, draw_odds, away_odds, over25_odds, under25_odds, btts_yes_odds, btts_no_odds, provider_updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       ON CONFLICT (fixture_id, bookmaker_id, phase, provider_updated_at) DO NOTHING`,
      [r.fixtureId, r.leagueId, r.kickoff, r.phase, r.source, r.bookId, r.bookName, r.minute ?? null, r.scoreHome ?? null, r.scoreAway ?? null,
        r.o.home, r.o.draw, r.o.away, r.o.over25, r.o.under25, r.o.bttsYes, r.o.bttsNo, r.updated],
    );
    return res.rowCount ?? 0;
  } catch (err) {
    // The trigger refuses pre-match odds updated after kickoff and live odds after the result; both are expected.
    logger.debug({ err, fixtureId: r.fixtureId }, "API-Football odds row not stored");
    return 0;
  }
}

/** Fetch and store one fixture's pre-match odds. Returns rows stored and the markets seen. */
export async function capturePrematchOdds(fixtureId: number, kickoffIso: string | null, source: "sampler" | "backfill") {
  const data = (await fetchFootball(`/odds?fixture=${fixtureId}`)) as any[];
  const markets = new Set<string>();
  let stored = 0, books = 0;
  for (const item of Array.isArray(data) ? data : []) {
    for (const b of item?.bookmakers ?? []) for (const bet of b?.bets ?? []) markets.add(String(bet?.name));
    const p = parsePrematch(item);
    if (!p) continue;
    const kickoff = kickoffIso ?? p.kickoff;
    const updated = p.updated ? new Date(p.updated) : null;
    if (!updated || !Number.isFinite(updated.getTime())) continue;
    books += p.books.length;
    for (const b of p.books) {
      stored += await insertRow({ fixtureId, leagueId: p.leagueId, kickoff: kickoff ? new Date(kickoff) : null, phase: "prematch", source,
        bookId: b.id, bookName: b.name, o: b, updated });
    }
  }
  return { stored, books, markets: [...markets] };
}

// ── Pre-match schedule ───────────────────────────────────────────────────────

/** API-Football refreshes pre-match odds every few hours; read less often than The Odds API. */
export function apifReadDue(hoursToKickoff: number, hoursSinceLastRead: number | null): boolean {
  if (!(hoursToKickoff > 0) || hoursToKickoff > CHECKPOINT_WINDOW_HOURS) return false;
  if (hoursSinceLastRead == null) return true;
  // 3 days / 2 days / 1 day checkpoints, then every 3 hours, hourly from 6 hours, every 30 minutes in the last hour.
  if (hoursToKickoff > 24) return [72, 48, 24].some((c) => hoursToKickoff <= c + 3 && hoursToKickoff + hoursSinceLastRead > c + 3);
  if (hoursToKickoff > 6) return hoursSinceLastRead >= 3;
  if (hoursToKickoff > 1) return hoursSinceLastRead >= 1;
  return hoursSinceLastRead >= 0.5;
}

const MAX_CALLS_PER_RUN = Math.max(1, Number(process.env.APIF_ODDS_MAX_CALLS_PER_RUN ?? 30));
let samplerRunning = false;
let lastSampler: Record<string, unknown> | null = null;

export async function runApifOddsSampler() {
  if (samplerRunning) return { skipped: true };
  samplerRunning = true;
  try {
    const { getAllMatches } = await import("./soccerService");
    const now = Date.now();
    const upcoming = (await getAllMatches(null, "upcoming")).filter((m) =>
      m.status === "upcoming" && isTrackedLeague(m.league_id) && Date.parse(m.kickoff) > now);
    const ids = upcoming.map((m) => m.id);
    const last = new Map<number, number>();
    if (ids.length) {
      const res = await pool.query(
        `SELECT fixture_id, MAX(observed_at) t FROM apif_odds_snapshots WHERE fixture_id = ANY($1::int[]) AND phase = 'prematch' AND source = 'sampler' GROUP BY 1`,
        [ids],
      );
      for (const r of res.rows as any[]) last.set(Number(r.fixture_id), new Date(r.t).getTime());
    }
    const due = upcoming
      .map((m) => ({ m, h: (Date.parse(m.kickoff) - now) / 3.6e6, since: last.has(m.id) ? (now - last.get(m.id)!) / 3.6e6 : null }))
      .filter((x) => apifReadDue(x.h, x.since))
      .sort((a, b) => a.h - b.h)
      .slice(0, MAX_CALLS_PER_RUN);
    let stored = 0;
    for (const { m } of due) stored += (await capturePrematchOdds(m.id, m.kickoff, "sampler").catch(() => ({ stored: 0 }))).stored;
    lastSampler = { at: new Date().toISOString(), upcoming: upcoming.length, due: due.length, stored };
    return lastSampler;
  } finally {
    samplerRunning = false;
  }
}

// ── In play ──────────────────────────────────────────────────────────────────

let lastLive: Record<string, unknown> | null = null;

/** One call returns live odds for every match in play; keep the tracked ones. */
export async function captureLiveOdds() {
  const data = (await fetchFootball(`/odds/live`)) as any[];
  let stored = 0, matches = 0;
  for (const item of Array.isArray(data) ? data : []) {
    const p = parseLive(item);
    if (!p || !p.usable || !isTrackedLeague(p.leagueId ?? 0)) continue;
    const updated = p.updated ? new Date(p.updated) : new Date();
    if (!Object.values(p.odds).some((v) => v != null)) continue;
    matches++;
    // API-Football live odds come as one aggregated feed: bookmaker 0.
    stored += await insertRow({ fixtureId: p.fixtureId, leagueId: p.leagueId, kickoff: null, phase: "live", source: "live",
      bookId: 0, bookName: "API-Football live", minute: p.minute, scoreHome: p.scoreHome, scoreAway: p.scoreAway, o: p.odds, updated });
  }
  lastLive = { at: new Date().toISOString(), matches, stored };
  return lastLive;
}

// ── Backfill and coverage ────────────────────────────────────────────────────

/** Store the final pre-match odds of finished, predicted matches from the last few days. */
export async function backfillApifOdds(days = 7, maxCalls = 300) {
  const res = await pool.query(
    `SELECT DISTINCT a.fixture_id, a.kickoff_at
       FROM prediction_audit_records a
      WHERE a.phase = 'prematch' AND a.kickoff_at > NOW() - ($1 || ' days')::interval AND a.kickoff_at < NOW() - INTERVAL '2 hours'
        AND NOT EXISTS (SELECT 1 FROM apif_odds_snapshots s WHERE s.fixture_id = a.fixture_id AND s.phase = 'prematch')
      ORDER BY a.kickoff_at DESC
      LIMIT $2`,
    [String(Math.min(8, Math.max(1, days))), Math.min(1000, Math.max(1, maxCalls))],
  );
  let fixtures = 0, withOdds = 0, stored = 0;
  const markets = new Map<string, number>();
  for (const r of res.rows as any[]) {
    fixtures++;
    try {
      const out = await capturePrematchOdds(Number(r.fixture_id), new Date(r.kickoff_at).toISOString(), "backfill");
      if (out.books) withOdds++;
      stored += out.stored;
      for (const m of out.markets) markets.set(m, (markets.get(m) ?? 0) + 1);
    } catch (err) {
      logger.warn({ err, fixtureId: r.fixture_id }, "API-Football odds backfill failed for fixture");
    }
  }
  return { fixtures, withOdds, stored, topMarkets: [...markets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15) };
}

export async function getApifOddsCoverage() {
  const res = await pool.query(
    `SELECT phase, source, COUNT(*)::int rows, COUNT(DISTINCT fixture_id)::int fixtures,
            COUNT(DISTINCT fixture_id) FILTER (WHERE home_odds IS NOT NULL)::int with_1x2,
            COUNT(DISTINCT fixture_id) FILTER (WHERE over25_odds IS NOT NULL)::int with_over25,
            COUNT(DISTINCT fixture_id) FILTER (WHERE btts_yes_odds IS NOT NULL)::int with_btts,
            MAX(observed_at) last
       FROM apif_odds_snapshots GROUP BY 1, 2 ORDER BY 1, 2`,
  );
  return { coverage: res.rows, sampler: lastSampler, live: lastLive };
}

// ── Workers ──────────────────────────────────────────────────────────────────

let started = false;
export function startApifOddsWorkers() {
  if (started || process.env.APIF_ODDS_ENABLED === "false") return;
  started = true;
  const pre = () => runApifOddsSampler().catch((err) => logger.warn({ err }, "API-Football odds sampler failed"));
  const live = async () => {
    try {
      const { getAllMatches } = await import("./soccerService");
      // Only call when a tracked match is in play.
      const anyLive = (await getAllMatches(null, "live")).some((m) => m.status === "live");
      if (anyLive) await captureLiveOdds();
    } catch (err) {
      logger.warn({ err }, "API-Football live odds capture failed");
    }
  };
  setTimeout(pre, 45_000);
  setInterval(pre, 5 * 60_000).unref?.();
  setInterval(live, 60_000).unref?.();
}
