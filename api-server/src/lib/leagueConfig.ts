// ── Leagues to track ──────────────────────────────────────────────────────────
// Only these leagues will have stats collected, predictions generated,
// and player data stored. Everything else is ignored.

export const TRACKED_LEAGUE_IDS = new Set([
  // ── Top 5 European Leagues ────────────────────────────────────────────────
  39,   // Premier League (England)
  140,  // La Liga (Spain)
  135,  // Serie A (Italy)
  78,   // Bundesliga (Germany)
  61,   // Ligue 1 (France)

  // ── European Club Competitions ────────────────────────────────────────────
  2,    // UEFA Champions League
  3,    // UEFA Europa League
  848,  // UEFA Conference League

  // ── Other Top European Leagues ────────────────────────────────────────────
  94,   // Primeira Liga (Portugal)
  88,   // Eredivisie (Netherlands)
  203,  // Süper Lig (Turkey)
  144,  // Jupiler Pro League (Belgium)
  119,  // Superliga (Denmark)
  103,  // Eliteserien (Norway)
  113,  // Allsvenskan (Sweden)
  169,  // Super League (Switzerland)

  // ── Major Internationals ─────────────────────────────────────────────────
  1,    // World Cup
  4,    // Euro Championship
  5,    // UEFA Nations League
  6,    // Africa Cup of Nations
  7,    // Asian Cup
  8,    // Copa America
  9,    // CONCACAF Gold Cup
  10,   // FIFA Friendlies

  // ── Other Notable Leagues ─────────────────────────────────────────────────
  307,  // Saudi Pro League
  253,  // MLS (USA)
  71,   // Serie A (Brazil)
  128,  // Liga Profesional (Argentina)
]);

export function isTrackedLeague(leagueId: number): boolean {
  return TRACKED_LEAGUE_IDS.has(leagueId);
}
