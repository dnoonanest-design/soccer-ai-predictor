// Agreed product scope: top two divisions and domestic cups in England,
// France, Spain, Portugal, Germany, Italy and the Netherlands, plus UEFA club
// competitions. Keeping one canonical list prevents collection and display
// routes from silently disagreeing.
export const TRACKED_LEAGUE_IDS = new Set([
  39,
  40,
  45,
  48, // England
  140,
  141,
  143, // Spain
  78,
  79,
  81, // Germany
  135,
  136,
  137, // Italy
  61,
  62,
  66, // France
  94,
  95,
  96, // Portugal
  88,
  89,
  90, // Netherlands
  2,
  3,
  848, // Champions, Europa, Conference League
]);

export function isTrackedLeague(leagueId: number): boolean {
  return TRACKED_LEAGUE_IDS.has(leagueId);
}
