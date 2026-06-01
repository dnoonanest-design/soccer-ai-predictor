export const COUNTRY_PRIORITY: Record<string, number> = {
  England: 1,
  Spain: 2,
  Italy: 3,
  Germany: 4,
  France: 5,
  Portugal: 6,
  Belgium: 7,
  Netherlands: 8,
  Scotland: 9,
};

export const LEAGUE_ID_PRIORITY: Record<number, number> = {
  2: 1,    // UEFA Champions League
  3: 2,    // UEFA Europa League
  848: 3,  // UEFA Conference League
  39: 10,  // Premier League
  40: 11,  // Championship
  41: 12,  // League One
  42: 13,  // League Two
  45: 14,  // FA Cup
  48: 15,  // League Cup
  140: 20, // La Liga
  141: 21, // Segunda División
  135: 30, // Serie A
  136: 31, // Serie B
  78: 40,  // Bundesliga
  79: 41,  // 2. Bundesliga
  61: 50,  // Ligue 1
  62: 51,  // Ligue 2
  94: 60,  // Primeira Liga
  95: 61,  // Liga Portugal 2
  144: 70, // Jupiler Pro League
  88: 80,  // Eredivisie
  89: 81,  // Eerste Divisie
  179: 90, // Scottish Premiership
  180: 91, // Scottish Championship
  203: 200, // Süper Lig
  253: 210, // MLS
  71: 220,  // Brasileirão
  128: 230, // Liga Profesional Argentina
};

export function leagueSortKey(leagueId: number, country: string): number {
  const byId = LEAGUE_ID_PRIORITY[leagueId];
  if (byId !== undefined) return byId;

  const countryRank = COUNTRY_PRIORITY[country];
  if (countryRank !== undefined) return 100 + countryRank * 10 + 5;

  return 9999;
}
