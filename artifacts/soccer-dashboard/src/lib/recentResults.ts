/** A team's recent completed matches, as returned by /api/teams/:id/results. */
export type TeamRecentResult = {
  fixture_id: number;
  date: string;
  competition: string;
  home_team: string;
  away_team: string;
  home_score: number;
  away_score: number;
  venue: "home" | "away";
  opponent: string;
  result: "W" | "D" | "L";
};

export type TeamResultsResponse = {
  team_id: number;
  team_name: string;
  matches: TeamRecentResult[];
};

/** Wins, draws, losses and goals across the listed matches, from the team's side. */
export function summariseResults(matches: TeamRecentResult[]) {
  let w = 0, d = 0, l = 0, gf = 0, ga = 0;
  for (const m of matches) {
    if (m.result === "W") w++; else if (m.result === "D") d++; else l++;
    const mine = m.venue === "home" ? m.home_score : m.away_score;
    const theirs = m.venue === "home" ? m.away_score : m.home_score;
    gf += mine; ga += theirs;
  }
  return { w, d, l, gf, ga, played: matches.length };
}
