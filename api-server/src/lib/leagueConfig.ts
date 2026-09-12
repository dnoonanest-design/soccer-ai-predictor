// Competitions the predictor is allowed to process.
//
// Product scope:
// - Top two divisions in England, France, Spain, Portugal, Germany, Italy,
//   and the Netherlands
// - Domestic cups for those countries
// - UEFA Champions League, Europa League, and Conference League
//
// Bookmaker odds remain optional. A missing oddsSportKey means the core
// predictor still covers the competition, but The Odds API does not currently
// expose a dedicated v4 sport key for it.

export type TrackedCompetition = {
  id: number;
  country: string;
  name: string;
  kind: "league" | "cup" | "uefa";
  tier?: 1 | 2;
  oddsSportKey?: string;
};

export const TRACKED_COMPETITIONS: readonly TrackedCompetition[] = [
  // England
  { id: 39, country: "England", name: "Premier League", kind: "league", tier: 1, oddsSportKey: "soccer_epl" },
  { id: 40, country: "England", name: "Championship", kind: "league", tier: 2, oddsSportKey: "soccer_efl_champ" },
  { id: 45, country: "England", name: "FA Cup", kind: "cup", oddsSportKey: "soccer_fa_cup" },
  { id: 48, country: "England", name: "EFL Cup", kind: "cup", oddsSportKey: "soccer_england_efl_cup" },

  // France
  { id: 61, country: "France", name: "Ligue 1", kind: "league", tier: 1, oddsSportKey: "soccer_france_ligue_one" },
  { id: 62, country: "France", name: "Ligue 2", kind: "league", tier: 2, oddsSportKey: "soccer_france_ligue_two" },
  { id: 66, country: "France", name: "Coupe de France", kind: "cup", oddsSportKey: "soccer_france_coupe_de_france" },

  // Spain
  { id: 140, country: "Spain", name: "La Liga", kind: "league", tier: 1, oddsSportKey: "soccer_spain_la_liga" },
  { id: 141, country: "Spain", name: "Segunda Division", kind: "league", tier: 2, oddsSportKey: "soccer_spain_segunda_division" },
  { id: 143, country: "Spain", name: "Copa del Rey", kind: "cup", oddsSportKey: "soccer_spain_copa_del_rey" },

  // Portugal
  { id: 94, country: "Portugal", name: "Primeira Liga", kind: "league", tier: 1, oddsSportKey: "soccer_portugal_primeira_liga" },
  { id: 95, country: "Portugal", name: "Liga Portugal 2", kind: "league", tier: 2 },
  { id: 96, country: "Portugal", name: "Taca de Portugal", kind: "cup" },

  // Germany
  { id: 78, country: "Germany", name: "Bundesliga", kind: "league", tier: 1, oddsSportKey: "soccer_germany_bundesliga" },
  { id: 79, country: "Germany", name: "2. Bundesliga", kind: "league", tier: 2, oddsSportKey: "soccer_germany_bundesliga2" },
  { id: 81, country: "Germany", name: "DFB-Pokal", kind: "cup", oddsSportKey: "soccer_germany_dfb_pokal" },

  // Italy
  { id: 135, country: "Italy", name: "Serie A", kind: "league", tier: 1, oddsSportKey: "soccer_italy_serie_a" },
  { id: 136, country: "Italy", name: "Serie B", kind: "league", tier: 2, oddsSportKey: "soccer_italy_serie_b" },
  { id: 137, country: "Italy", name: "Coppa Italia", kind: "cup", oddsSportKey: "soccer_italy_coppa_italia" },

  // Netherlands
  { id: 88, country: "Netherlands", name: "Eredivisie", kind: "league", tier: 1, oddsSportKey: "soccer_netherlands_eredivisie" },
  { id: 89, country: "Netherlands", name: "Eerste Divisie", kind: "league", tier: 2 },
  { id: 90, country: "Netherlands", name: "KNVB Beker", kind: "cup" },

  // UEFA club competitions
  { id: 2, country: "Europe", name: "UEFA Champions League", kind: "uefa", oddsSportKey: "soccer_uefa_champs_league" },
  { id: 3, country: "Europe", name: "UEFA Europa League", kind: "uefa", oddsSportKey: "soccer_uefa_europa_league" },
  { id: 848, country: "Europe", name: "UEFA Conference League", kind: "uefa", oddsSportKey: "soccer_uefa_europa_conference_league" },
] as const;

export const TRACKED_LEAGUE_IDS = new Set(
  TRACKED_COMPETITIONS.map((competition) => competition.id),
);

const ODDS_SPORT_KEY_BY_LEAGUE_ID = new Map<number, string>(
  TRACKED_COMPETITIONS.flatMap((competition) =>
    competition.oddsSportKey
      ? [[competition.id, competition.oddsSportKey] as const]
      : [],
  ),
);

export function isTrackedLeague(leagueId: number): boolean {
  return TRACKED_LEAGUE_IDS.has(leagueId);
}

export function getOddsSportKeyForLeague(leagueId: number): string | null {
  return ODDS_SPORT_KEY_BY_LEAGUE_ID.get(leagueId) ?? null;
}

export function getTrackedCompetition(leagueId: number): TrackedCompetition | null {
  return TRACKED_COMPETITIONS.find((competition) => competition.id === leagueId) ?? null;
}
