import { pool } from "@workspace/db";
import { fetchFootball, resolveSeasonForCompetition, type Match } from "./soccerService";
import { setBounded, DEFAULT_CACHE_MAX_ENTRIES } from "./boundedCache";
import { logger } from "./logger";

/** Whether a listed player is in this match's squad, once the provider has published lineups or absences. */
export type LineupStatus = "starting" | "bench" | "not_in_squad" | "injured_or_suspended" | "doubtful";

export interface PresentationPlayer {
  id: number;
  name: string;
  number: number | null;
  position: string | null;
  photo: string | null;
  grid?: string | null;
  value?: number | null;
  appearances?: number;
  minutes?: number;
  lineup_status?: LineupStatus | null;
  /** Absence reason from the provider's injury list, e.g. "Hamstring Injury" or "Suspended". */
  absence_reason?: string | null;
}

export interface LeaderEntry extends PresentationPlayer {
  goals: number;
  assists: number;
  fouls: number;
  yellow_cards: number;
  red_cards: number;
  rating: number | null;
}

export interface ScoringFormEntry {
  id: number;
  name: string;
  /** Consecutive most recent team matches (that he played in) with a goal. */
  scoring_streak: number;
  goals_last5: number;
  matches_last5: number;
  last_goal_at: string | null;
  lineup_status?: LineupStatus | null;
}

interface TeamPresentation {
  team_id: number;
  team_name: string;
  formation: string | null;
  coach: string | null;
  starting_xi: PresentationPlayer[];
  substitutes: PresentationPlayer[];
  star_player: PresentationPlayer | null;
  in_form: PresentationPlayer[];
  top_scorer: PresentationPlayer | null;
  top_assister: PresentationPlayer | null;
  top_fouler: PresentationPlayer | null;
  /** Top 5 lists, season to date. */
  star_players: LeaderEntry[];
  top_scorers: LeaderEntry[];
  top_assisters: LeaderEntry[];
  most_fouls: LeaderEntry[];
  /** Players on a goal-scoring run, from the team's recent matches in our records. */
  scoring_form: ScoringFormEntry[];
  scoring_form_matches: number;
}

export interface MatchPresentation {
  match_id: number;
  season: number;
  lineups_announced: boolean;
  player_stats_available: boolean;
  source: "API-Football";
  note: string;
  home: TeamPresentation;
  away: TeamPresentation;
}

type ApiLineup = {
  team?: { id?: number; name?: string };
  formation?: string | null;
  coach?: { name?: string | null };
  startXI?: Array<{ player?: { id?: number; name?: string; number?: number | null; pos?: string | null; grid?: string | null } }>;
  substitutes?: Array<{ player?: { id?: number; name?: string; number?: number | null; pos?: string | null; grid?: string | null } }>;
};

type ApiInjury = { team?: { id?: number }; player?: { id?: number; name?: string; type?: string | null; reason?: string | null } };

type ApiPlayerRow = {
  player?: { id?: number; name?: string; photo?: string | null };
  statistics?: Array<{
    games?: { appearences?: number | null; appearances?: number | null; minutes?: number | null; rating?: string | number | null; position?: string | null };
    goals?: { total?: number | null; assists?: number | null };
    fouls?: { committed?: number | null };
    cards?: { yellow?: number | null; red?: number | null };
  }>;
};

type RatedPlayer = PresentationPlayer & { rating: number; goals: number; assists: number; fouls: number; yellow: number; red: number };
type CacheEntry = { value: MatchPresentation; fetchedAt: number };
const cache = new Map<number, CacheEntry>();
const playerCache = new Map<string, { value: ApiPlayerRow[]; fetchedAt: number }>();
const PLAYER_CACHE_TTL = 6 * 60 * 60_000;
const LIST_SIZE = 5;

function n(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function lineupPlayers(rows: ApiLineup["startXI"]): PresentationPlayer[] {
  return (rows ?? []).flatMap(({ player }) => player?.id && player.name ? [{
    id: player.id,
    name: player.name,
    number: player.number ?? null,
    position: player.pos ?? null,
    photo: null,
    grid: player.grid ?? null,
  }] : []);
}

export function playerStats(rows: ApiPlayerRow[]): RatedPlayer[] {
  const byId = new Map<number, RatedPlayer & { ratingTotal: number; ratingWeight: number }>();
  for (const row of rows) {
    const player = row.player;
    const entries = row.statistics ?? [];
    if (!player?.id || !player.name || !entries.length) continue;
    // One entry per player, adding up his competition blocks (and the
    // whole-season fallback rows, which only follow rows without statistics).
    const p = byId.get(player.id) ?? {
      id: player.id, name: player.name, number: null, position: null, photo: player.photo ?? null, grid: null,
      appearances: 0, minutes: 0, rating: 0, goals: 0, assists: 0, fouls: 0, yellow: 0, red: 0, ratingTotal: 0, ratingWeight: 0,
    };
    for (const stats of entries) {
      const apps = n(stats.games?.appearences ?? stats.games?.appearances);
      const rating = n(stats.games?.rating);
      p.appearances = (p.appearances ?? 0) + apps;
      p.minutes = (p.minutes ?? 0) + n(stats.games?.minutes);
      p.goals += n(stats.goals?.total);
      p.assists += n(stats.goals?.assists);
      p.fouls += n(stats.fouls?.committed);
      p.yellow += n(stats.cards?.yellow);
      p.red += n(stats.cards?.red);
      if (!p.position && stats.games?.position) p.position = stats.games.position;
      if (rating > 0) {
        const weight = Math.max(1, apps);
        p.ratingTotal += rating * weight;
        p.ratingWeight += weight;
      }
    }
    p.rating = p.ratingWeight ? p.ratingTotal / p.ratingWeight : 0;
    byId.set(player.id, p);
  }
  return [...byId.values()].map(({ ratingTotal: _t, ratingWeight: _w, ...rest }) => rest);
}

function publicPlayer(player: RatedPlayer | undefined, metric: "rating" | "goals" | "assists" | "fouls"): PresentationPlayer | null {
  if (!player) return null;
  const { rating, goals, assists, fouls, yellow, red, ...base } = player;
  void rating; void goals; void assists; void fouls; void yellow; void red;
  return { ...base, value: metric === "rating" ? Math.round(player.rating * 100) / 100 : player[metric] };
}

/** Top players by a metric; rating needs 3+ appearances so one good cameo cannot lead. */
export function leaders(players: RatedPlayer[], metric: "rating" | "goals" | "assists" | "fouls", size = LIST_SIZE): RatedPlayer[] {
  const minimumAppearances = metric === "rating" ? 3 : 1;
  return [...players]
    .filter((p) => (p.appearances ?? 0) >= minimumAppearances && p[metric] > 0)
    .sort((a, b) => b[metric] - a[metric] || (b.appearances ?? 0) - (a.appearances ?? 0) || (a.minutes ?? 0) - (b.minutes ?? 0))
    .slice(0, size);
}

function leaderEntry(p: RatedPlayer, metric: "rating" | "goals" | "assists" | "fouls"): LeaderEntry {
  return {
    ...publicPlayer(p, metric)!,
    goals: p.goals, assists: p.assists, fouls: p.fouls, yellow_cards: p.yellow, red_cards: p.red,
    rating: p.rating > 0 ? Math.round(p.rating * 100) / 100 : null,
  };
}

export type SquadContext = { starting: Set<number>; bench: Set<number>; out: Map<number, string | null>; doubtful: Map<number, string | null>; announced: boolean };

export function squadContext(lineup: ApiLineup | undefined, injuries: ApiInjury[], teamId: number): SquadContext {
  const ids = (rows: ApiLineup["startXI"]) => new Set((rows ?? []).map((r) => Number(r.player?.id)).filter((v) => v > 0));
  const out = new Map<number, string | null>(), doubtful = new Map<number, string | null>();
  for (const i of injuries) {
    const id = Number(i.player?.id);
    if (i.team?.id !== teamId || !(id > 0)) continue;
    if (/questionable|doubtful/i.test(i.player?.type ?? "")) doubtful.set(id, i.player?.reason ?? null);
    else out.set(id, i.player?.reason ?? null);
  }
  const starting = ids(lineup?.startXI), bench = ids(lineup?.substitutes);
  return { starting, bench, out, doubtful, announced: starting.size >= 11 };
}

/** Where a player stands for this match; null until lineups or absences say anything about him. */
export function lineupStatus(id: number, ctx: SquadContext): { status: LineupStatus | null; reason: string | null } {
  if (ctx.announced) {
    if (ctx.starting.has(id)) return { status: "starting", reason: null };
    if (ctx.bench.has(id)) return { status: "bench", reason: null };
    if (ctx.out.has(id)) return { status: "injured_or_suspended", reason: ctx.out.get(id) ?? null };
    return { status: "not_in_squad", reason: null };
  }
  if (ctx.out.has(id)) return { status: "injured_or_suspended", reason: ctx.out.get(id) ?? null };
  if (ctx.doubtful.has(id)) return { status: "doubtful", reason: ctx.doubtful.get(id) ?? null };
  return { status: null, reason: null };
}

function withStatus<T extends { id: number }>(p: T, ctx: SquadContext): T & { lineup_status: LineupStatus | null; absence_reason: string | null } {
  const s = lineupStatus(p.id, ctx);
  return { ...p, lineup_status: s.status, absence_reason: s.reason };
}

export type Appearance = { fixtureId: number; date: number; playerId: number; name: string; minutes: number; goals: number };

/**
 * Players on a goal-scoring run: consecutive most recent team matches in which
 * they played and scored, plus goals in the team's last 5 matches.
 */
export function scoringForm(rows: Appearance[], size = LIST_SIZE): { entries: Omit<ScoringFormEntry, "lineup_status">[]; matches: number } {
  const fixtures = [...new Map(rows.map((r) => [r.fixtureId, r.date])).entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  const last5 = new Set(fixtures.slice(0, 5));
  const byPlayer = new Map<number, Appearance[]>();
  for (const r of rows) { const l = byPlayer.get(r.playerId) ?? []; l.push(r); byPlayer.set(r.playerId, l); }
  const entries: Omit<ScoringFormEntry, "lineup_status">[] = [];
  for (const [id, apps] of byPlayer) {
    const played = apps.filter((a) => a.minutes > 0).sort((a, b) => b.date - a.date);
    let streak = 0;
    for (const a of played) { if (a.goals > 0) streak++; else break; }
    const recent = apps.filter((a) => last5.has(a.fixtureId));
    const goals5 = recent.reduce((s, a) => s + a.goals, 0);
    if (streak < 2 && goals5 < 3) continue;
    const lastGoal = played.find((a) => a.goals > 0);
    entries.push({
      id, name: apps[0].name, scoring_streak: streak, goals_last5: goals5,
      matches_last5: recent.filter((a) => a.minutes > 0).length,
      last_goal_at: lastGoal ? new Date(lastGoal.date).toISOString() : null,
    });
  }
  entries.sort((a, b) => b.scoring_streak - a.scoring_streak || b.goals_last5 - a.goals_last5);
  return { entries: entries.slice(0, size), matches: fixtures.length };
}

async function loadRecentAppearances(teamId: number, before: Date): Promise<Appearance[]> {
  try {
    const res = await pool.query(
      `WITH recent AS (
         SELECT fixture_id, MAX(match_date) d FROM player_match_stats
          WHERE team_id = $1 AND match_date < $2
          GROUP BY fixture_id ORDER BY d DESC LIMIT 8
       )
       SELECT p.fixture_id, r.d, p.player_id, p.player_name, COALESCE(p.minutes_played, 0) minutes, COALESCE(p.goals, 0) goals
         FROM player_match_stats p JOIN recent r USING (fixture_id)
        WHERE p.team_id = $1`,
      [teamId, before],
    );
    return res.rows.map((r: any) => ({ fixtureId: Number(r.fixture_id), date: new Date(r.d).getTime(), playerId: Number(r.player_id), name: String(r.player_name), minutes: Number(r.minutes), goals: Number(r.goals) }));
  } catch (err) {
    logger.warn({ err, teamId }, "recent player appearances unavailable");
    return [];
  }
}

function buildTeam(matchTeam: Match["home_team"], lineup: ApiLineup | undefined, rows: ApiPlayerRow[], injuries: ApiInjury[], appearances: Appearance[]): TeamPresentation {
  const players = playerStats(rows);
  const ctx = squadContext(lineup, injuries, matchTeam.id);
  const stars = leaders(players, "rating");
  const form = scoringForm(appearances);
  return {
    team_id: matchTeam.id,
    team_name: matchTeam.name,
    formation: lineup?.formation ?? null,
    coach: lineup?.coach?.name ?? null,
    starting_xi: lineupPlayers(lineup?.startXI),
    substitutes: lineupPlayers(lineup?.substitutes),
    // Single leaders kept for older clients.
    star_player: publicPlayer(stars[0], "rating"),
    in_form: stars.slice(0, 3).map((p) => publicPlayer(p, "rating")!),
    top_scorer: publicPlayer(leaders(players, "goals", 1)[0], "goals"),
    top_assister: publicPlayer(leaders(players, "assists", 1)[0], "assists"),
    top_fouler: publicPlayer(leaders(players, "fouls", 1)[0], "fouls"),
    star_players: stars.map((p) => withStatus(leaderEntry(p, "rating"), ctx)),
    top_scorers: leaders(players, "goals").map((p) => withStatus(leaderEntry(p, "goals"), ctx)),
    top_assisters: leaders(players, "assists").map((p) => withStatus(leaderEntry(p, "assists"), ctx)),
    most_fouls: leaders(players, "fouls").map((p) => withStatus(leaderEntry(p, "fouls"), ctx)),
    scoring_form: form.entries.map((e) => ({ ...e, lineup_status: lineupStatus(e.id, ctx).status })),
    scoring_form_matches: form.matches,
  };
}

async function fetchTeamPlayers(teamId: number, leagueId: number, season: number): Promise<ApiPlayerRow[]> {
  const cacheKey = `${teamId}:${leagueId}:${season}`;
  const cached = playerCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < PLAYER_CACHE_TTL) return cached.value;
  const rows: ApiPlayerRow[] = [];
  // API-Football paginates squads at 20 rows. Read the full senior squad so
  // leader labels cannot be distorted by whichever players happen to be page 1.
  for (let page = 1; page <= 3; page += 1) {
    const batch = (await fetchFootball(`/players?team=${teamId}&league=${leagueId}&season=${season}&page=${page}`)) as ApiPlayerRow[];
    rows.push(...batch);
    if (batch.length < 20) break;
  }
  // Friendlies and cross-competition fixtures commonly have official lineups
  // but no player aggregates under the fixture's competition ID. Fall back to
  // provider-backed totals for this team across the same season.
  if (playerStats(rows).length === 0) {
    for (let page = 1; page <= 3; page += 1) {
      const batch = (await fetchFootball(`/players?team=${teamId}&season=${season}&page=${page}`)) as ApiPlayerRow[];
      rows.push(...batch);
      if (batch.length < 20) break;
    }
  }
  setBounded(playerCache, cacheKey, { value: rows, fetchedAt: Date.now() }, DEFAULT_CACHE_MAX_ENTRIES);
  return rows;
}

/**
 * How long a built page stays cached. Close to kickoff without published
 * lineups it is rebuilt every minute (the provider call behind it is held for
 * 2 minutes), so lineups appear within a couple of minutes of publication.
 */
export function presentationTtl(status: string, kickoff: string, lineupsAnnounced: boolean, now = Date.now()): number {
  if (status === "live") return 5 * 60_000;
  if (status !== "upcoming") return 60 * 60_000;
  const minsToKickoff = (Date.parse(kickoff) - now) / 60_000;
  if (!lineupsAnnounced && minsToKickoff <= 90) return 60_000;
  return 10 * 60_000;
}

export async function getMatchPresentation(match: Match): Promise<MatchPresentation> {
  const existing = cache.get(match.id);
  if (existing && Date.now() - existing.fetchedAt < presentationTtl(match.status, match.kickoff, existing.value.lineups_announced)) return existing.value;

  const season = await resolveSeasonForCompetition(match.league_id);
  const kickoff = new Date(match.kickoff);
  const [lineupResult, homeResult, awayResult, injuryResult, homeApps, awayApps] = await Promise.allSettled([
    fetchFootball(`/fixtures/lineups?fixture=${match.id}`) as Promise<ApiLineup[]>,
    fetchTeamPlayers(match.home_team.id, match.league_id, season),
    fetchTeamPlayers(match.away_team.id, match.league_id, season),
    fetchFootball(`/injuries?fixture=${match.id}`) as Promise<ApiInjury[]>,
    loadRecentAppearances(match.home_team.id, kickoff),
    loadRecentAppearances(match.away_team.id, kickoff),
  ]);
  const ok = <T,>(r: PromiseSettledResult<T>, fallback: T): T => (r.status === "fulfilled" && r.value ? r.value : fallback);
  const lineupData = ok(lineupResult, [] as ApiLineup[]);
  const homeRows = ok(homeResult, [] as ApiPlayerRow[]);
  const awayRows = ok(awayResult, [] as ApiPlayerRow[]);
  const injuries = ok(injuryResult, [] as ApiInjury[]);
  const homeLineup = lineupData.find((entry) => entry.team?.id === match.home_team.id);
  const awayLineup = lineupData.find((entry) => entry.team?.id === match.away_team.id);
  const lineupsAnnounced = Boolean(homeLineup?.startXI?.length && awayLineup?.startXI?.length);
  const statsAvailable = homeRows.length > 0 || awayRows.length > 0;
  const value: MatchPresentation = {
    match_id: match.id,
    season,
    lineups_announced: lineupsAnnounced,
    player_stats_available: statsAvailable,
    source: "API-Football",
    note: lineupsAnnounced
      ? "Official fixture lineups and season-to-date player statistics."
      : "Lineups not announced yet (usually 20-60 minutes before kickoff); this page checks every minute. Player rankings use season-to-date statistics.",
    home: buildTeam(match.home_team, homeLineup, homeRows, injuries, ok(homeApps, [] as Appearance[])),
    away: buildTeam(match.away_team, awayLineup, awayRows, injuries, ok(awayApps, [] as Appearance[])),
  };
  setBounded(cache, match.id, { value, fetchedAt: Date.now() }, DEFAULT_CACHE_MAX_ENTRIES);
  return value;
}
