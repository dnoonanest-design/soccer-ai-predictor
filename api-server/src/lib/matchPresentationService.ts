import { fetchFootball, resolveSeasonForCompetition, type Match } from "./soccerService";

export interface PresentationPlayer {
  id: number;
  name: string;
  number: number | null;
  position: string | null;
  photo: string | null;
  value?: number | null;
  appearances?: number;
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
  startXI?: Array<{ player?: { id?: number; name?: string; number?: number | null; pos?: string | null } }>;
  substitutes?: Array<{ player?: { id?: number; name?: string; number?: number | null; pos?: string | null } }>;
};

type ApiPlayerRow = {
  player?: { id?: number; name?: string; photo?: string | null };
  statistics?: Array<{
    games?: { appearences?: number | null; rating?: string | number | null };
    goals?: { total?: number | null; assists?: number | null };
    fouls?: { committed?: number | null };
  }>;
};

type RatedPlayer = PresentationPlayer & { rating: number; goals: number; assists: number; fouls: number };
type CacheEntry = { value: MatchPresentation; fetchedAt: number };
const cache = new Map<number, CacheEntry>();
const playerCache = new Map<string, { value: ApiPlayerRow[]; fetchedAt: number }>();
const PLAYER_CACHE_TTL = 6 * 60 * 60_000;

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
  }] : []);
}

function playerStats(rows: ApiPlayerRow[]): RatedPlayer[] {
  return rows.flatMap((row) => {
    const player = row.player;
    const stats = row.statistics?.[0];
    if (!player?.id || !player.name || !stats) return [];
    return [{
      id: player.id,
      name: player.name,
      number: null,
      position: null,
      photo: player.photo ?? null,
      appearances: n(stats.games?.appearences),
      rating: n(stats.games?.rating),
      goals: n(stats.goals?.total),
      assists: n(stats.goals?.assists),
      fouls: n(stats.fouls?.committed),
    }];
  });
}

function publicPlayer(player: RatedPlayer | undefined, metric: keyof Pick<RatedPlayer, "rating" | "goals" | "assists" | "fouls">): PresentationPlayer | null {
  if (!player) return null;
  const { rating, goals, assists, fouls, ...base } = player;
  return { ...base, value: player[metric] };
}

function best(players: RatedPlayer[], metric: "rating" | "goals" | "assists" | "fouls") {
  const minimumAppearances = metric === "rating" ? 3 : 1;
  const leader = [...players].filter((p) => (p.appearances ?? 0) >= minimumAppearances).sort((a, b) => b[metric] - a[metric] || b.appearances! - a.appearances!)[0];
  return leader && leader[metric] > 0 ? leader : undefined;
}

function buildTeam(matchTeam: Match["home_team"], lineup: ApiLineup | undefined, rows: ApiPlayerRow[]): TeamPresentation {
  const players = playerStats(rows);
  const inForm = [...players]
    .filter((p) => (p.appearances ?? 0) >= 3 && p.rating > 0)
    .sort((a, b) => b.rating - a.rating)
    .slice(0, 3)
    .map((p) => publicPlayer(p, "rating")!);
  return {
    team_id: matchTeam.id,
    team_name: matchTeam.name,
    formation: lineup?.formation ?? null,
    coach: lineup?.coach?.name ?? null,
    starting_xi: lineupPlayers(lineup?.startXI),
    substitutes: lineupPlayers(lineup?.substitutes),
    star_player: publicPlayer(best(players, "rating"), "rating"),
    in_form: inForm,
    top_scorer: publicPlayer(best(players, "goals"), "goals"),
    top_assister: publicPlayer(best(players, "assists"), "assists"),
    top_fouler: publicPlayer(best(players, "fouls"), "fouls"),
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
  playerCache.set(cacheKey, { value: rows, fetchedAt: Date.now() });
  return rows;
}

export async function getMatchPresentation(match: Match): Promise<MatchPresentation> {
  const ttl = match.status === "live" ? 5 * 60_000 : match.status === "upcoming" ? 10 * 60_000 : 60 * 60_000;
  const existing = cache.get(match.id);
  if (existing && Date.now() - existing.fetchedAt < ttl) return existing.value;

  const season = await resolveSeasonForCompetition(match.league_id);
  const lineupData = (await fetchFootball(`/fixtures/lineups?fixture=${match.id}`)) as ApiLineup[];
  const homeRows = await fetchTeamPlayers(match.home_team.id, match.league_id, season);
  const awayRows = await fetchTeamPlayers(match.away_team.id, match.league_id, season);
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
    note: lineupsAnnounced ? "Official fixture lineups and season-to-date player statistics." : "Lineups have not been announced by the data provider. Player rankings use season-to-date statistics only.",
    home: buildTeam(match.home_team, homeLineup, homeRows),
    away: buildTeam(match.away_team, awayLineup, awayRows),
  };
  cache.set(match.id, { value, fetchedAt: Date.now() });
  return value;
}
