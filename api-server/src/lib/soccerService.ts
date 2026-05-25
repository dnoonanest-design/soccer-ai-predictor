import { logger } from "./logger";

const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY ?? "";
const ODDS_API_KEY = process.env.ODDS_API_KEY ?? "";
const SEASON = process.env.FOOTBALL_SEASON ?? "2025";
const API_FOOTBALL_BASE = "https://v3.football.api-sports.io";
const ODDS_API_BASE = "https://api.the-odds-api.com/v4";

// ─── Focus leagues ──────────────────────────────────────────────────────────
// The prediction model performs best on competitions where API-Football
// provides reliable lineup, injury, statistics, and H2H data.
//
// Override via environment: FOCUS_LEAGUE_IDS="39,140,78,135,61,2,3"
// Disable filtering entirely: FOCUS_LEAGUE_IDS="*"
//
// Default: the six competitions with strongest data coverage and user interest.
export const FOCUS_LEAGUE_IDS: ReadonlySet<number> = (() => {
  const raw = process.env.FOCUS_LEAGUE_IDS ?? "";
  if (raw.trim() === "*") return new Set<number>();   // empty set = no filter
  if (raw.trim()) {
    const parsed = raw.split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (parsed.length > 0) return new Set(parsed);
  }
  return new Set([
    39,   // Premier League
    140,  // La Liga
    78,   // Bundesliga
    135,  // Serie A
    61,   // Ligue 1
    2,    // UEFA Champions League
  ]);
})();

/** Returns true when this league should be included in the dashboard and predictions. */
export function isLeagueFocused(leagueId: number): boolean {
  return FOCUS_LEAGUE_IDS.size === 0 || FOCUS_LEAGUE_IDS.has(leagueId);
}

// ─── Odds API sport-key filter ───────────────────────────────────────────────
// The Odds API returns ALL soccer competitions in one response.
// Filtering by these sport keys before caching reduces the events array from
// hundreds of entries to ~6 competitions, which speeds up the name-matching
// in extractOdds() and keeps memory usage low.
// If FOCUS_LEAGUE_IDS is overridden via env, this map still covers the defaults;
// unknown league IDs simply get no odds (handled gracefully by extractOdds).
const FOCUS_SPORT_KEYS = new Set([
  "soccer_epl",                   // Premier League
  "soccer_spain_la_liga",         // La Liga
  "soccer_germany_bundesliga",    // Bundesliga
  "soccer_italy_serie_a",         // Serie A
  "soccer_france_ligue_one",      // Ligue 1
  "soccer_uefa_champs_league",    // UEFA Champions League
]);

// ── S3: Tiered cache TTLs ────────────────────────────────────────────────────
// Live fixture lists need rapid refresh; upcoming/finished need far less.
// Each cache entry stores its own TTL alongside the data.
const LIVE_FIXTURE_TTL_MS    = 14_000;   // 14s — live score/minute updates
const TODAY_FIXTURE_TTL_MS   = 60_000;   // 60s — upcoming/finished today

interface CacheEntry<T> {
  data: T;
  fetchedAt: number;
  ttl: number;
}

const cache = new Map<string, CacheEntry<unknown>>();

function getCached<T>(key: string, ttl?: number): T | null {
  const entry = cache.get(key) as CacheEntry<T> | undefined;
  if (!entry) return null;
  const effectiveTtl = ttl ?? entry.ttl;
  if (Date.now() - entry.fetchedAt > effectiveTtl) return null;
  return entry.data;
}

function setCache<T>(key: string, data: T, ttl: number = TODAY_FIXTURE_TTL_MS): void {
  cache.set(key, { data, fetchedAt: Date.now(), ttl });
}

// ── S4: Cache pruning ────────────────────────────────────────────────────────
function pruneCache(): void {
  const now = Date.now();
  const MAX_AGE = 24 * 60 * 60 * 1000;
  for (const [key, entry] of cache) {
    if (now - entry.fetchedAt > MAX_AGE) cache.delete(key);
  }
}
if (typeof setInterval !== "undefined") {
  setInterval(pruneCache, 60 * 60 * 1000);
}

// ── S1: In-flight deduplication ─────────────────────────────────────────────
const _inFlight = new Map<string, Promise<unknown>>();
// ── S2: 5-second timeout on all external API calls ──────────────────────────
const API_TIMEOUT_MS = 5000;

async function fetchFootball(path: string): Promise<unknown> {
  if (!API_FOOTBALL_KEY) {
    logger.warn("API_FOOTBALL_KEY not set");
    return null;
  }
  if (_inFlight.has(path)) return _inFlight.get(path)!;
  const url = `${API_FOOTBALL_BASE}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  const promise = fetch(url, {
    headers: { "x-apisports-key": API_FOOTBALL_KEY },
    signal: controller.signal,
  })
    .then(async (res) => {
      if (!res.ok) { logger.error({ status: res.status, url }, "API-Football request failed"); return null; }
      const json = (await res.json()) as { response: unknown };
      return json.response ?? null;
    })
    .catch((err: unknown) => {
      if ((err as any)?.name === "AbortError") logger.warn({ url }, "soccerService: api call timed out after 5s");
      else logger.error({ err, url }, "soccerService: fetch error");
      return null;
    })
    .finally(() => {
      clearTimeout(timer);
      _inFlight.delete(path);
    });
  _inFlight.set(path, promise);
  return promise;
}

async function fetchOdds(path: string): Promise<unknown> {
  if (!ODDS_API_KEY) {
    logger.warn("ODDS_API_KEY not set");
    return null;
  }
  const url = `${ODDS_API_BASE}${path}`;
  const res = await fetch(url);
  if (!res.ok) {
    logger.error({ status: res.status, url }, "Odds API request failed");
    return null;
  }
  return res.json();
}

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

function normaliseStatus(short: string): string {
  if (["1H", "2H", "ET", "BT", "P", "LIVE"].includes(short)) return "live";
  if (["HT"].includes(short)) return "live";
  if (["FT", "AET", "PEN", "AWD", "WO"].includes(short)) return "finished";
  return "upcoming";
}

function oddsToProb(decimal: number): number {
  if (decimal <= 0) return 0;
  return Math.round((1 / decimal) * 100 * 10) / 10;
}

type OddsApiEvent = {
  id: string;
  sport_key: string;
  home_team: string;
  away_team: string;
  bookmakers: Array<{
    key: string;
    markets: Array<{
      key: string;
      outcomes: Array<{ name: string; price: number }>;
    }>;
  }>;
};

function extractOdds(
  homeTeam: string,
  awayTeam: string,
  oddsEvents: OddsApiEvent[]
): Odds {
  const nullOdds: Odds = {
    home_win: null,
    draw: null,
    away_win: null,
    home_odds: null,
    draw_odds: null,
    away_odds: null,
  };

  const normalize = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .trim();
  const normHome = normalize(homeTeam);
  const normAway = normalize(awayTeam);

  const event = oddsEvents.find((e) => {
    const eHome = normalize(e.home_team);
    const eAway = normalize(e.away_team);
    return (
      (eHome.includes(normHome.slice(0, 5)) ||
        normHome.includes(eHome.slice(0, 5))) &&
      (eAway.includes(normAway.slice(0, 5)) ||
        normAway.includes(eAway.slice(0, 5)))
    );
  });

  if (!event) return nullOdds;

  const bookmaker =
    event.bookmakers.find((b) => b.key === "pinnacle") ??
    event.bookmakers.find((b) => b.key === "betfair") ??
    event.bookmakers[0];

  if (!bookmaker) return nullOdds;

  const h2h = bookmaker.markets.find((m) => m.key === "h2h");
  if (!h2h) return nullOdds;

  const homeOc = h2h.outcomes.find((o) => normalize(o.name) === normHome || o.name === event.home_team);
  const awayOc = h2h.outcomes.find((o) => normalize(o.name) === normAway || o.name === event.away_team);
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

async function getTodayFixtures(): Promise<ApiFootballFixture[]> {
  // S3: use 60s TTL for today's fixtures — scores rarely change in 14s anyway
  // and this cuts fixture API calls dramatically under concurrent user load.
  const cached = getCached<ApiFootballFixture[]>("today_fixtures");
  if (cached) return cached;

  const today = new Date().toISOString().split("T")[0];
  const data = (await fetchFootball(
    `/fixtures?date=${today}&season=${SEASON}&timezone=UTC`
  )) as ApiFootballFixture[] | null;

  const allFixtures = data ?? [];
  // Apply focus-league filter — keeps only the competitions where model accuracy
  // is highest. This also reduces API quota usage downstream (stats, H2H, lineups).
  const fixtures = allFixtures.filter((f) => isLeagueFocused(f.league.id));
  const anyLive = fixtures.some(f => ["1H","2H","ET","BT","P","LIVE","HT"].includes(f.fixture.status.short));
  setCache("today_fixtures", fixtures, anyLive ? LIVE_FIXTURE_TTL_MS : TODAY_FIXTURE_TTL_MS);
  return fixtures;
}

async function getLiveFixtures(): Promise<ApiFootballFixture[]> {
  const cached = getCached<ApiFootballFixture[]>("live_fixtures");
  if (cached) return cached;

  const data = (await fetchFootball(
    `/fixtures?live=all`
  )) as ApiFootballFixture[] | null;

  const allFixtures = data ?? [];
  // Apply same focus-league filter to live fixtures
  const fixtures = allFixtures.filter((f) => isLeagueFocused(f.league.id));
  setCache("live_fixtures", fixtures, LIVE_FIXTURE_TTL_MS);
  return fixtures;
}

async function getSoccerOdds(): Promise<OddsApiEvent[]> {
  const cached = getCached<OddsApiEvent[]>("soccer_odds");
  if (cached) return cached;

  const data = (await fetchOdds(
    `/sports/soccer/odds?apiKey=${ODDS_API_KEY}&regions=eu&markets=h2h&oddsFormat=decimal&dateFormat=iso`
  )) as OddsApiEvent[] | null;

  const allEvents = Array.isArray(data) ? (data as OddsApiEvent[]) : [];
  // Filter to focus-league sport keys only — reduces array size ~10× and
  // speeds up the name-matching in extractOdds() for every fixture.
  // Falls back to unfiltered if FOCUS_SPORT_KEYS is empty (future expansion).
  const events = FOCUS_SPORT_KEYS.size > 0
    ? allEvents.filter((e) => FOCUS_SPORT_KEYS.has(e.sport_key))
    : allEvents;
  setCache("soccer_odds", events);
  return events;
}

function fixtureToMatch(
  f: ApiFootballFixture,
  oddsEvents: OddsApiEvent[]
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
    score: {
      home: f.goals.home,
      away: f.goals.away,
    },
    score_ht: (f.score?.halftime?.home != null && f.score?.halftime?.away != null)
      ? { home: f.score.halftime.home, away: f.score.halftime.away }
      : null,
    kickoff: f.fixture.date,
    odds: extractOdds(f.teams.home.name, f.teams.away.name, oddsEvents),
  };
}

export async function getAllMatches(
  leagueId?: number | null,
  status?: string | null
): Promise<Match[]> {
  const [todayFixtures, liveFixtures, oddsEvents] = await Promise.all([
    getTodayFixtures(),
    getLiveFixtures(),
    getSoccerOdds(),
  ]);

  const liveIds = new Set(liveFixtures.map((f) => f.fixture.id));

  const combined = new Map<number, ApiFootballFixture>();
  for (const f of todayFixtures) combined.set(f.fixture.id, f);
  for (const f of liveFixtures) combined.set(f.fixture.id, f);

  let matches = Array.from(combined.values()).map((f) =>
    fixtureToMatch(f, oddsEvents)
  );

  if (leagueId != null) {
    matches = matches.filter((m) => m.league_id === leagueId);
  }

  if (status && status !== "all") {
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
