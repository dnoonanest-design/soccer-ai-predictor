/** API-Football seasons use the year in which the European season starts. */
export function currentFootballSeason(now = new Date()): number {
  const year = now.getUTCFullYear();
  return now.getUTCMonth() >= 6 ? year : year - 1;
}

export function configuredFootballSeason(value = process.env.FOOTBALL_SEASON): number {
  if (value && /^20\d{2}$/.test(value)) return Number(value);
  return currentFootballSeason();
}
