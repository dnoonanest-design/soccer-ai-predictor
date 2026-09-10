export type MarketSide = "home" | "draw" | "away";

export interface ThreeWayProbabilities {
  home: number;
  draw: number;
  away: number;
}

export function calculateNoVigProbabilities(
  homeOdds: number,
  drawOdds: number,
  awayOdds: number,
): ThreeWayProbabilities | null {
  if (![homeOdds, drawOdds, awayOdds].every((v) => Number.isFinite(v) && v > 1.01 && v <= 1000)) {
    return null;
  }

  const rawHome = 1 / homeOdds;
  const rawDraw = 1 / drawOdds;
  const rawAway = 1 / awayOdds;
  const total = rawHome + rawDraw + rawAway;
  // Reject corrupt/mismatched markets. Normal 1X2 books cluster around 1.0;
  // this wide band retains exchanges and promotions without accepting feeds
  // such as 1.00 / 75 / 100.
  if (!Number.isFinite(total) || total < 0.80 || total > 1.50) return null;

  const home = round2((rawHome / total) * 100);
  const draw = round2((rawDraw / total) * 100);
  const away = round2(Math.max(0, 100 - home - draw));
  return { home, draw, away };
}

export function pickFromProbabilities(probs: ThreeWayProbabilities): MarketSide {
  const ordered: Array<[MarketSide, number]> = [
    ["home", probs.home],
    ["draw", probs.draw],
    ["away", probs.away],
  ];
  ordered.sort((a, b) => b[1] - a[1]);
  return ordered[0][0];
}

export function calculateProbabilityMovement(
  opening: ThreeWayProbabilities,
  closing: ThreeWayProbabilities,
): ThreeWayProbabilities {
  return {
    home: round2(closing.home - opening.home),
    draw: round2(closing.draw - opening.draw),
    away: round2(closing.away - opening.away),
  };
}

export function strongestPositiveMovement(movement: ThreeWayProbabilities): MarketSide {
  return pickFromProbabilities(movement);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
