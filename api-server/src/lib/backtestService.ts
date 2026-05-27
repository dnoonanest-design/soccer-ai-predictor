import { logger } from "./logger";

const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY ?? "";
const API_FOOTBALL_BASE = "https://v3.football.api-sports.io";

// Top European leagues by API-Football ID
const DEFAULT_LEAGUES = [
  { id: 39, name: "Premier League", country: "England" },
  { id: 140, name: "La Liga", country: "Spain" },
  { id: 135, name: "Serie A", country: "Italy" },
  { id: 78, name: "Bundesliga", country: "Germany" },
  { id: 61, name: "Ligue 1", country: "France" },
  { id: 2, name: "Champions League", country: "Europe" },
];

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min cache — expensive call
let backtestCache: { data: BacktestResult; fetchedAt: number } | null = null;

export interface BacktestScenario {
  halftime_score: string;
  home_goals_ht: number;
  away_goals_ht: number;
  match_count: number;
  home_win_count: number;
  draw_count: number;
  away_win_count: number;
  home_win_pct: number;
  draw_pct: number;
  away_win_pct: number;
  lead_held: boolean | null;
}

export interface BacktestSummary {
  most_common_ht_score: string;
  comeback_rate: number;
  draw_ht_home_win_pct: number;
  draw_ht_draw_pct: number;
  draw_ht_away_win_pct: number;
  home_leading_ht_win_pct: number;
  away_leading_ht_win_pct: number;
}

export interface BacktestResult {
  total_matches: number;
  season: number;
  leagues: Array<{ id: number; name: string; country: string }>;
  scenarios: BacktestScenario[];
  summary: BacktestSummary;
  generated_at: string;
}

type ApiFixture = {
  fixture: { id: number; status: { short: string } };
  goals: { home: number | null; away: number | null };
  score: {
    halftime: { home: number | null; away: number | null };
    fulltime: { home: number | null; away: number | null };
  };
};

async function fetchFixtures(leagueId: number, season: number): Promise<ApiFixture[]> {
  if (!API_FOOTBALL_KEY) return [];
  const url = `${API_FOOTBALL_BASE}/fixtures?league=${leagueId}&season=${season}&status=FT`;
  try {
    const res = await fetch(url, {
      headers: { "x-apisports-key": API_FOOTBALL_KEY },
    });
    if (!res.ok) {
      logger.warn({ status: res.status, leagueId, season }, "API-Football fixture fetch failed");
      return [];
    }
    const json = (await res.json()) as { response: ApiFixture[] };
    return Array.isArray(json.response) ? json.response : [];
  } catch (err) {
    logger.error({ err, leagueId, season }, "Error fetching fixtures");
    return [];
  }
}

function pct(n: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((n / total) * 1000) / 10;
}

function determineResult(
  ftHome: number,
  ftAway: number
): "home_win" | "draw" | "away_win" {
  if (ftHome > ftAway) return "home_win";
  if (ftAway > ftHome) return "away_win";
  return "draw";
}

export async function runBacktest(
  season?: number | null,
  leagueIds?: string | null
): Promise<BacktestResult> {
  if (backtestCache && Date.now() - backtestCache.fetchedAt < CACHE_TTL_MS) {
    return backtestCache.data;
  }

  // Default to last full season
  const analyzeSeason = season ?? new Date().getFullYear() - 1;

  const leagues = leagueIds
    ? leagueIds.split(",").map((id) => {
        const lid = parseInt(id.trim(), 10);
        return DEFAULT_LEAGUES.find((l) => l.id === lid) ?? { id: lid, name: `League ${lid}`, country: "" };
      })
    : DEFAULT_LEAGUES;

  // Fetch all leagues in parallel
  const allFixtureSets = await Promise.all(
    leagues.map((l) => fetchFixtures(l.id, analyzeSeason))
  );

  const allFixtures = allFixtureSets.flat().filter((f) => {
    const ht = f.score?.halftime;
    const ft = f.score?.fulltime;
    return (
      ht?.home != null &&
      ht?.away != null &&
      ft?.home != null &&
      ft?.away != null
    );
  });

  // Group by halftime score
  type Group = {
    htHome: number;
    htAway: number;
    home_win: number;
    draw: number;
    away_win: number;
    total: number;
  };

  const groups = new Map<string, Group>();

  for (const f of allFixtures) {
    const htHome = f.score.halftime.home!;
    const htAway = f.score.halftime.away!;
    const ftHome = f.score.fulltime.home!;
    const ftAway = f.score.fulltime.away!;
    const key = `${htHome}-${htAway}`;
    const result = determineResult(ftHome, ftAway);

    if (!groups.has(key)) {
      groups.set(key, { htHome, htAway, home_win: 0, draw: 0, away_win: 0, total: 0 });
    }
    const g = groups.get(key)!;
    g.total++;
    g[result]++;
  }

  // Sort: 0-0 first, then by frequency
  const scenarios: BacktestScenario[] = Array.from(groups.entries())
    .sort((a, b) => b[1].total - a[1].total)
    .map(([key, g]) => {
      const htScore = `${g.htHome}-${g.htAway}`;
      let lead_held: boolean | null = null;
      if (g.htHome > g.htAway) {
        lead_held = pct(g.home_win, g.total) >= 50;
      } else if (g.htAway > g.htHome) {
        lead_held = pct(g.away_win, g.total) >= 50;
      }
      return {
        halftime_score: htScore,
        home_goals_ht: g.htHome,
        away_goals_ht: g.htAway,
        match_count: g.total,
        home_win_count: g.home_win,
        draw_count: g.draw,
        away_win_count: g.away_win,
        home_win_pct: pct(g.home_win, g.total),
        draw_pct: pct(g.draw, g.total),
        away_win_pct: pct(g.away_win, g.total),
        lead_held,
      };
    });

  // Summary stats
  const mostCommon = scenarios[0]?.halftime_score ?? "0-0";

  // Comeback rate: matches where leading team at HT did NOT win
  let ledAtHt = 0;
  let ledAndWon = 0;
  for (const s of scenarios) {
    if (s.home_goals_ht !== s.away_goals_ht) {
      ledAtHt += s.match_count;
      ledAndWon += s.home_goals_ht > s.away_goals_ht
        ? s.home_win_count
        : s.away_win_count;
    }
  }
  const comebackRate = pct(ledAtHt - ledAndWon, ledAtHt);

  const nilNil = groups.get("0-0");
  const homeLeading = scenarios.filter((s) => s.home_goals_ht > s.away_goals_ht);
  const awayLeading = scenarios.filter((s) => s.away_goals_ht > s.home_goals_ht);

  const sumPct = (items: BacktestScenario[], key: keyof BacktestScenario): number => {
    const totalMatches = items.reduce((s, x) => s + x.match_count, 0);
    const totalWins = items.reduce((s, x) => s + (x[key] as number), 0);
    return pct(totalWins, totalMatches);
  };

  const summary: BacktestSummary = {
    most_common_ht_score: mostCommon,
    comeback_rate: comebackRate,
    draw_ht_home_win_pct: nilNil ? pct(nilNil.home_win, nilNil.total) : 0,
    draw_ht_draw_pct: nilNil ? pct(nilNil.draw, nilNil.total) : 0,
    draw_ht_away_win_pct: nilNil ? pct(nilNil.away_win, nilNil.total) : 0,
    home_leading_ht_win_pct: sumPct(homeLeading, "home_win_count"),
    away_leading_ht_win_pct: sumPct(awayLeading, "away_win_count"),
  };

  const result: BacktestResult = {
    total_matches: allFixtures.length,
    season: analyzeSeason,
    leagues,
    scenarios,
    summary,
    generated_at: new Date().toISOString(),
  };

  backtestCache = { data: result, fetchedAt: Date.now() };
  return result;
}
