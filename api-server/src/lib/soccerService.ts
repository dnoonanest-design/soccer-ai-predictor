import { logger } from "./logger";
import { waitForRateLimit } from "./rateLimiter";
import { isTrackedLeague } from "./leagueConfig";
import {
  captureMarketOdds,
  type BookmakerOddsInput,
} from "./marketIntelligenceService";

const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY ?? "";
const ODDS_API_KEY = process.env.ODDS_API_KEY ?? "";
const now = new Date();
const DEFAULT_SEASON = String(
  now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1,
);
const SEASON = process.env.FOOTBALL_SEASON ?? DEFAULT_SEASON;
const API_FOOTBALL_BASE = "https://v3.football.api-sports.io";
const ODDS_API_BASE = "https://api.the-odds-api.com/v4";

// ─── Per-endpoint cache TTLs (ms) ────────────────────────────────────────────
const CACHE_TTL = {
  live_fixtures: 30_000,
  soccer_odds_live: 30_000,
  soccer_odds_prematch: 300_000,
  today_fixtures: 3_600_000,
  team_stats: 3_600_000,
  standings: 3_600_000,
  h2h: 86_400_000,
  player_stats: 60_000,
};

// ─── Cache store ──────────────────────────────────────────────────────────────
type CacheEntry<T> = { data: T; fetchedAt: number };
const cache = new Map<string, CacheEntry<unknown>>();
const inFlight = new Map<string, Promise<unknown>>();

function getCached<T>(key: string, ttl: number): T | null {
  const entry = cache.get(key) as CacheEntry<T> | undefined;
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > ttl) return null;
  return entry.data;
}

function setCache<T>(key: string, data: T): void {
  cache.set(key, { data, fetchedAt: Date.now() });
}

async function singleFlight<T>(
  key: string,
  work: () => Promise<T>,
): Promise<T> {
  const existing = inFlight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const request = work();
  inFlight.set(key, request);
  try {
    return await request;
  } finally {
    inFlight.delete(key);
  }
}

// ─── Match window detection ───────────────────────────────────────────────────
let _liveMatchCount = 0;
export function hasLiveMatches(): boolean {
  return _liveMatchCount > 0;
}

// ─── Core fetchers ────────────────────────────────────────────────────────────
export async function fetchFootball(path: string): Promise<unknown> {
  if (!API_FOOTBALL_KEY) {
    logger.warn("API_FOOTBALL_KEY not set");
    return null;
  }
  const url = `${API_FOOTBALL_BASE}${path}`;
  await waitForRateLimit();
  try {
    const res = await fetch(url, {
      headers: { "x-apisports-key": API_FOOTBALL_KEY },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      logger.error({ status: res.status, path }, "API-Football request failed");
      return null;
    }
    const json = (await res.json()) as { response: unknown };
    return json.response;
  } catch (err) {
    logger.error({ err, path }, "API-Football request errored or timed out");
    return null;
  }
}

async function fetchOdds(path: string): Promise<unknown> {
  if (!ODDS_API_KEY) {
    logger.warn("ODDS_API_KEY not set");
    return null;
  }
  const url = `${ODDS_API_BASE}${path}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) {
      logger.error({ status: res.status }, "Odds API request failed");
      return null;
    }
    return res.json();
  } catch (err) {
    logger.error({ err }, "Odds API request errored or timed out");
    return null;
  }
}

// ─── Interfaces ───────────────────────────────────────────────────────────────
export interface Team {
  id: number;
  name: string;
  logo: string | null;
}

export interface Odds {
  home_win: number | null;
  draw: number | null;
  away_win: number | null;
  home_odds: number | null;
  draw_odds: number | null;
  away_odds: number | null;
}

export interface Score {
  home: number | null;
  away: number | null;
}

export interface Match {
  id: number;
  league_id: number;
  league_name: string;
  league_logo: string | null;
  country: string;
  home_team: Team;
  away_team: Team;
  status: string;
  status_detail: string;
  minute: number | null;
  score: Score;
  score_ht: Score | null;
  kickoff: string;
  odds: Odds;
}

export interface League {
  id: number;
  name: string;
  logo: string | null;
  country: string;
  match_count: number;
  live_count: number;
}

export interface DashboardSummary {
  live_count: number;
  upcoming_count: number;
  finished_count: number;
  total_matches: number;
  leagues_active: number;
  last_updated: string;
}

type ApiFootballFixture = {
  fixture: {
    id: number;
    date: string;
    status: { long: string; short: string; elapsed: number | null };
  };
  league: { id: number; name: string; logo: string; country: string };
  teams: {
    home: { id: number; name: string; logo: string };
    away: { id: number; name: string; logo: string };
  };
  goals: { home: number | null; away: number | null };
  score?: {
    halftime?: { home: number | null; away: number | null } | null;
    fulltime?: { home: number | null; away: number | null } | null;
  };
};

type OddsApiEvent = {
  id: string;
  sport_key: string;
  home_team: string;
  away_team: string;
  bookmakers: Array<{
    key: string;
    title?: string;
    last_update?: string;
    markets: Array<{
      key: string;
      outcomes: Array<{ name: string; price: number }>;
    }>;
  }>;
};

// ─── Status normaliser ────────────────────────────────────────────────────────
function normaliseStatus(short: string): string {
  if (["1H", "2H", "ET", "BT", "P", "LIVE"].includes(short)) return "live";
  if (["HT"].includes(short)) return "live";
  if (["FT", "AET", "PEN", "AWD", "WO"].includes(short)) return "finished";
  return "upcoming";
}

// ─── Odds helpers ─────────────────────────────────────────────────────────────
function oddsToProb(decimal: number): number {
  if (decimal <= 0) return 0;
  return Math.round((1 / decimal) * 100 * 10) / 10;
}

const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .trim();

function findOddsEvent(
  homeTeam: string,
  awayTeam: string,
  oddsEvents: OddsApiEvent[],
) {
  const normHome = normalize(homeTeam);
  const normAway = normalize(awayTeam);
  return oddsEvents.find((e) => {
    const eHome = normalize(e.home_team);
    const eAway = normalize(e.away_team);
    return (
      (eHome.includes(normHome.slice(0, 5)) ||
        normHome.includes(eHome.slice(0, 5))) &&
      (eAway.includes(normAway.slice(0, 5)) ||
        normAway.includes(eAway.slice(0, 5)))
    );
  });
}

function extractOdds(
  homeTeam: string,
  awayTeam: string,
  oddsEvents: OddsApiEvent[],
): Odds {
  const nullOdds: Odds = {
    home_win: null,
    draw: null,
    away_win: null,
    home_odds: null,
    draw_odds: null,
    away_odds: null,
  };
  const normHome = normalize(homeTeam);
  const normAway = normalize(awayTeam);
  const event = findOddsEvent(homeTeam, awayTeam, oddsEvents);
  if (!event) return nullOdds;
  const bookmaker =
    event.bookmakers.find((b) => b.key === "pinnacle") ??
    event.bookmakers.find((b) => b.key === "betfair") ??
    event.bookmakers[0];
  if (!bookmaker) return nullOdds;
  const h2h = bookmaker.markets.find((m) => m.key === "h2h");
  if (!h2h) return nullOdds;
  const homeOc = h2h.outcomes.find(
    (o) => normalize(o.name) === normHome || o.name === event.home_team,
  );
  const awayOc = h2h.outcomes.find(
    (o) => normalize(o.name) === normAway || o.name === event.away_team,
  );
  const drawOc = h2h.outcomes.find((o) => o.name.toLowerCase() === "draw");
  const homeDecimal = homeOc?.price ?? null;
  const awayDecimal = awayOc?.price ?? null;
  const drawDecimal = drawOc?.price ?? null;
  let homeProb = homeDecimal ? oddsToProb(homeDecimal) : null;
  let drawProb = drawDecimal ? oddsToProb(drawDecimal) : null;
  let awayProb = awayDecimal ? oddsToProb(awayDecimal) : null;
  if (homeProb !== null && drawProb !== null && awayProb !== null) {
    const total = homeProb + drawProb + awayProb;
    if (total > 0) {
      homeProb = Math.round((homeProb / total) * 100 * 10) / 10;
      drawProb = Math.round((drawProb / total) * 100 * 10) / 10;
      awayProb = Math.round((100 - homeProb - drawProb) * 10) / 10;
    }
  }
  return {
    home_win: homeProb,
    draw: drawProb,
    away_win: awayProb,
    home_odds: homeDecimal,
    draw_odds: drawDecimal,
    away_odds: awayDecimal,
  };
}

function bookmakerSnapshots(
  event: OddsApiEvent,
  observedAt: Date,
): BookmakerOddsInput[] {
  const normHome = normalize(event.home_team);
  const normAway = normalize(event.away_team);
  return event.bookmakers.flatMap((bookmaker) => {
    const h2h = bookmaker.markets.find((market) => market.key === "h2h");
    if (!h2h) return [];
    const home = h2h.outcomes.find(
      (outcome) => normalize(outcome.name) === normHome,
    );
    const away = h2h.outcomes.find(
      (outcome) => normalize(outcome.name) === normAway,
    );
    const draw = h2h.outcomes.find(
      (outcome) => outcome.name.toLowerCase() === "draw",
    );
    if (!home || !draw || !away) return [];
    const parsedUpdate = bookmaker.last_update
      ? new Date(bookmaker.last_update)
      : observedAt;
    return [
      {
        bookmakerKey: bookmaker.key,
        homeDecimal: home.price,
        drawDecimal: draw.price,
        awayDecimal: away.price,
        sourceUpdatedAt: Number.isNaN(parsedUpdate.getTime())
          ? observedAt
          : parsedUpdate,
        raw: { title: bookmaker.title, outcomes: h2h.outcomes },
      },
    ];
  });
}

// ─── Individual data fetchers ─────────────────────────────────────────────────
async function getTodayFixtures(): Promise<ApiFootballFixture[]> {
  const cached = getCached<ApiFootballFixture[]>(
    "today_fixtures",
    CACHE_TTL.today_fixtures,
  );
  if (cached) return cached;
  return singleFlight("today_fixtures", async () => {
    const today = new Date().toISOString().split("T")[0];
    const data = (await fetchFootball(
      `/fixtures?date=${today}&season=${SEASON}&timezone=UTC`,
    )) as ApiFootballFixture[] | null;
    if (!Array.isArray(data)) return [];
    // ── FIXED: Only keep tracked leagues ──────────────────────────────────────
    const fixtures = (data ?? []).filter((f) => isTrackedLeague(f.league.id));
    setCache("today_fixtures", fixtures);
    return fixtures;
  });
}

async function getLiveFixtures(): Promise<ApiFootballFixture[]> {
  const cached = getCached<ApiFootballFixture[]>(
    "live_fixtures",
    CACHE_TTL.live_fixtures,
  );
  if (cached) return cached;
  return singleFlight("live_fixtures", async () => {
    const data = (await fetchFootball("/fixtures?live=all")) as
      | ApiFootballFixture[]
      | null;
    if (!Array.isArray(data)) return [];
    // ── FIXED: Only keep tracked leagues ──────────────────────────────────────
    const fixtures = (data ?? []).filter((f) => isTrackedLeague(f.league.id));
    _liveMatchCount = fixtures.length;
    setCache("live_fixtures", fixtures);
    return fixtures;
  });
}

async function getSoccerOdds(live: boolean): Promise<OddsApiEvent[]> {
  const ttl = live
    ? CACHE_TTL.soccer_odds_live
    : CACHE_TTL.soccer_odds_prematch;
  const cached = getCached<OddsApiEvent[]>("soccer_odds", ttl);
  if (cached) return cached;
  return singleFlight("soccer_odds", async () => {
    const data = (await fetchOdds(
      `/sports/soccer/odds?apiKey=${ODDS_API_KEY}&regions=eu&markets=h2h&oddsFormat=decimal&dateFormat=iso`,
    )) as OddsApiEvent[] | null;
    if (!Array.isArray(data)) return [];
    const events = Array.isArray(data) ? data : [];
    setCache("soccer_odds", events);
    return events;
  });
}

function isInMatchPollingWindow(fixtures: ApiFootballFixture[]): boolean {
  const time = Date.now();
  return fixtures.some((fixture) => {
    if (normaliseStatus(fixture.fixture.status.short) === "live") return true;
    const kickoff = new Date(fixture.fixture.date).getTime();
    return (
      Number.isFinite(kickoff) &&
      time >= kickoff - 15 * 60_000 &&
      time <= kickoff + 4 * 60 * 60_000
    );
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────
export async function getAllMatches(
  leagueId?: number | null,
  status?: string | null,
): Promise<Match[]> {
  const todayFixtures = await getTodayFixtures();
  const shouldPollLive =
    hasLiveMatches() || isInMatchPollingWindow(todayFixtures);
  const liveFixtures = shouldPollLive ? await getLiveFixtures() : [];

  // Only fetch odds if matches are active
  const hasActiveMatches =
    liveFixtures.length > 0 ||
    todayFixtures.some(
      (f) => normaliseStatus(f.fixture.status.short) !== "finished",
    );
  const oddsEvents = hasActiveMatches
    ? await getSoccerOdds(liveFixtures.length > 0)
    : [];

  const combined = new Map<number, ApiFootballFixture>();
  for (const f of todayFixtures) combined.set(f.fixture.id, f);
  for (const f of liveFixtures) combined.set(f.fixture.id, f);

  let matches = Array.from(combined.values()).map((f) =>
    fixtureToMatch(f, oddsEvents),
  );

  // Store every available bookmaker, not only the display bookmaker. This is
  // append-only and de-duplicated by the provider's update timestamp.
  const observedAt = new Date();
  void Promise.allSettled(
    Array.from(combined.values()).map((fixture) => {
      const event = findOddsEvent(
        fixture.teams.home.name,
        fixture.teams.away.name,
        oddsEvents,
      );
      if (!event) return Promise.resolve(0);
      return captureMarketOdds({
        fixtureId: fixture.fixture.id,
        providerEventId: event.id,
        kickoffAt: new Date(fixture.fixture.date),
        isInPlay: normaliseStatus(fixture.fixture.status.short) === "live",
        observedAt,
        bookmakers: bookmakerSnapshots(event, observedAt),
      });
    }),
  ).catch((err) => logger.warn({ err }, "Market odds persistence failed"));

  if (leagueId != null) {
    matches = matches.filter((m) => m.league_id === leagueId);
  }

  if (status && status !== "all") {
    const liveIds = new Set(liveFixtures.map((f) => f.fixture.id));
    if (status === "live") {
      matches = matches.filter((m) => liveIds.has(m.id) || m.status === "live");
    } else {
      matches = matches.filter((m) => m.status === status);
    }
  }

  matches.sort((a, b) => {
    const order: Record<string, number> = { live: 0, upcoming: 1, finished: 2 };
    return (order[a.status] ?? 3) - (order[b.status] ?? 3);
  });

  return matches;
}

function fixtureToMatch(
  f: ApiFootballFixture,
  oddsEvents: OddsApiEvent[],
): Match {
  const status = normaliseStatus(f.fixture.status.short);
  return {
    id: f.fixture.id,
    league_id: f.league.id,
    league_name: f.league.name,
    league_logo: f.league.logo || null,
    country: f.league.country,
    home_team: {
      id: f.teams.home.id,
      name: f.teams.home.name,
      logo: f.teams.home.logo || null,
    },
    away_team: {
      id: f.teams.away.id,
      name: f.teams.away.name,
      logo: f.teams.away.logo || null,
    },
    status,
    status_detail: f.fixture.status.short,
    minute: f.fixture.status.elapsed ?? null,
    score: { home: f.goals.home, away: f.goals.away },
    score_ht:
      f.score?.halftime?.home != null && f.score?.halftime?.away != null
        ? { home: f.score.halftime.home, away: f.score.halftime.away }
        : null,
    kickoff: f.fixture.date,
    odds: extractOdds(f.teams.home.name, f.teams.away.name, oddsEvents),
  };
}

export async function getMatchById(id: number): Promise<Match | null> {
  const matches = await getAllMatches();
  return matches.find((m) => m.id === id) ?? null;
}

export async function getLeagues(): Promise<League[]> {
  const matches = await getAllMatches();
  const leagueMap = new Map<
    number,
    { name: string; logo: string | null; country: string; matches: Match[] }
  >();
  for (const m of matches) {
    if (!leagueMap.has(m.league_id)) {
      leagueMap.set(m.league_id, {
        name: m.league_name,
        logo: m.league_logo,
        country: m.country,
        matches: [],
      });
    }
    leagueMap.get(m.league_id)!.matches.push(m);
  }
  return Array.from(leagueMap.entries()).map(([id, data]) => ({
    id,
    name: data.name,
    logo: data.logo,
    country: data.country,
    match_count: data.matches.length,
    live_count: data.matches.filter((m) => m.status === "live").length,
  }));
}

export async function getDashboardSummary(): Promise<DashboardSummary> {
  const matches = await getAllMatches();
  const live = matches.filter((m) => m.status === "live").length;
  const upcoming = matches.filter((m) => m.status === "upcoming").length;
  const finished = matches.filter((m) => m.status === "finished").length;
  const leagueIds = new Set(matches.map((m) => m.league_id));
  return {
    live_count: live,
    upcoming_count: upcoming,
    finished_count: finished,
    total_matches: matches.length,
    leagues_active: leagueIds.size,
    last_updated: new Date().toISOString(),
  };
}
