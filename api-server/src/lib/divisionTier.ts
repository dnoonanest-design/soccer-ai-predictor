/**
 * Which division of its country's league pyramid a club plays in, from the
 * name API-Football gives its league (tier 1 = top flight).
 *
 * Why: the formula judged a club by its own league record and, for leagues
 * outside the tracked top two divisions, assumed the country's top-flight
 * strength. A Spanish fifth-tier club scoring twice a game against amateur
 * sides therefore looked stronger than a second-division side. Cup ties
 * between divisions need the division gap itself.
 */

type Rule = [RegExp, number];

// Order matters: more specific names first.
const RULES: Rule[] = [
  // England
  [/^premier league$/, 1], [/^championship$/, 2], [/^league one$/, 3], [/^league two$/, 4],
  [/^national league - (north|south)/, 6], [/^national league$/, 5],
  [/^non league premier/, 7], [/^non league div(ision)? one/, 8], [/^non league/, 9],
  // Spain
  [/^la liga$/, 1], [/^segunda divisi[oó]n$/, 2],
  [/^primera (divisi[oó]n )?(rfef|federaci[oó]n)/, 3], [/^segunda (divisi[oó]n )?(rfef|federaci[oó]n)/, 4],
  [/^tercera (divisi[oó]n )?(rfef|federaci[oó]n)/, 5], [/^tercera divisi[oó]n/, 5],
  // Italy
  [/^serie a$/, 1], [/^serie b$/, 2], [/^serie c/, 3], [/^serie d/, 4], [/^eccellenza/, 5],
  // Germany
  [/^bundesliga$/, 1], [/^2\. bundesliga$/, 2], [/^3\. liga$/, 3], [/^regionalliga/, 4], [/^oberliga/, 5],
  [/^(verbandsliga|landesliga)/, 6],
  // France
  [/^ligue 1$/, 1], [/^ligue 2$/, 2], [/^(national|ligue 3)$/, 3], [/^national 2/, 4], [/^national 3/, 5],
  [/^(r[ée]gional|r1|division d'honneur)/, 6],
  // Portugal
  [/^(primeira liga|liga portugal)$/, 1], [/^(segunda liga|liga portugal 2)$/, 2], [/^liga 3/, 3],
  [/^campeonato de portugal/, 4],
  // Netherlands
  [/^eredivisie$/, 1], [/^eerste divisie$/, 2], [/^tweede divisie/, 3], [/^derde divisie/, 4],
  [/^(vierde divisie|hoofdklasse)/, 5],
];

const NOT_A_LEAGUE = /cup|copa|coppa|pokal|coupe|ta[cç]a|beker|trophy|super|friendl|shield|play-?off|champions|europa|conference/i;
/** Reserve, youth and women's sides are not the club's first team. */
const NOT_FIRST_TEAM = /\b(u1[0-9]|u2[0-3]|youth|primavera|reserve|women|femenin|feminin|frauen)\b/i;

/** Cups, play-offs, friendlies and continental competitions: not a club's division. */
export function isCupOrContinental(name: string): boolean {
  return NOT_A_LEAGUE.test(name);
}

/** Tier for a league name, or null when the name is not a recognised domestic league. */
export function divisionTierFromLeagueName(name: string | null | undefined): number | null {
  const n = String(name ?? "").trim().toLowerCase();
  if (!n || NOT_A_LEAGUE.test(n) || NOT_FIRST_TEAM.test(n)) return null;
  for (const [re, tier] of RULES) if (re.test(n)) return tier;
  return null;
}

/** The club's division from its recent competitions: the league it played most often in. */
export function divisionTierFromCompetitions(competitions: Array<string | null | undefined>): number | null {
  const counts = new Map<number, number>();
  for (const c of competitions) {
    const t = divisionTierFromLeagueName(c);
    if (t != null) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  let best: number | null = null, n = 0;
  for (const [t, k] of counts) if (k > n) { best = t; n = k; }
  return best;
}
