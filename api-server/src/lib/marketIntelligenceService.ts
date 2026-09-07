import { db, marketOddsSnapshots, matchOutcomes, matchPredictions } from "@workspace/db";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { logger } from "./logger";
import type { Match } from "./soccerService";
import {
  calculateNoVigProbabilities,
  calculateProbabilityMovement,
  pickFromProbabilities,
  strongestPositiveMovement,
  type MarketSide,
  type ThreeWayProbabilities,
} from "./marketIntelligenceMath";

export type RawOddsEvent = {
  id?: string;
  home_team: string;
  away_team: string;
  bookmakers: Array<{
    key: string;
    title?: string;
    markets: Array<{
      key: string;
      outcomes: Array<{ name: string; price: number }>;
    }>;
  }>;
};

const ENABLED = process.env.MARKET_INTELLIGENCE_ENABLED !== "false";
const BUCKET_MINUTES = clampInt(Number(process.env.MARKET_INTELLIGENCE_BUCKET_MINUTES ?? 30), 5, 120);
const MAX_BOOKMAKERS = clampInt(Number(process.env.MARKET_INTELLIGENCE_MAX_BOOKMAKERS ?? 4), 1, 12);
const DEFAULT_BOOKMAKERS = [
  "pinnacle",
  "betfair_ex_eu",
  "betfair",
  "bet365",
  "unibet_eu",
  "williamhill",
];
const PREFERRED_BOOKMAKERS = (process.env.MARKET_INTELLIGENCE_BOOKMAKERS ?? DEFAULT_BOOKMAKERS.join(","))
  .split(",")
  .map((v) => v.trim().toLowerCase())
  .filter(Boolean);

export const MARKET_INTELLIGENCE_POLICY = Object.freeze({
  corePredictionUsesBookmakerOdds: false,
  bookmakerDataRole: "evaluation_and_learning_only",
  explanation:
    "Bookmaker prices are tracked as a separate market-intelligence dataset. They do not alter the core statistical prediction probabilities or calibration weights.",
});

type MarketSnapshot = typeof marketOddsSnapshots.$inferSelect;
type OutcomeRow = typeof matchOutcomes.$inferSelect;
type PredictionRow = typeof matchPredictions.$inferSelect;

type EvaluatedFixture = {
  fixtureId: number;
  leagueId: number | null;
  homeTeam: string;
  awayTeam: string;
  actualOutcome: MarketSide | null;
  modelPick: MarketSide | null;
  openingMarketPick: MarketSide;
  closingMarketPick: MarketSide;
  movementLeader: MarketSide;
  opening: ThreeWayProbabilities;
  closing: ThreeWayProbabilities;
  movement: ThreeWayProbabilities;
  winnerProbabilityMovePts: number | null;
  modelCorrect: boolean | null;
  closingMarketCorrect: boolean | null;
  movementLeaderCorrect: boolean | null;
  modelMarketAgreed: boolean | null;
  bookmakerCount: number;
  snapshotCount: number;
  openingObservedAt: Date;
  closingObservedAt: Date;
};

/**
 * Persist bookmaker snapshots that were already returned by the existing odds
 * request. This function does not make any external API call of its own.
 */
export async function captureMarketSnapshots(
  matches: Match[],
  oddsEvents: RawOddsEvent[],
) {
  if (!ENABLED) return { enabled: false, observations: 0, fixtures: 0 };
  if (!matches.length || !oddsEvents.length) {
    return { enabled: true, observations: 0, fixtures: 0 };
  }

  const now = new Date();
  const captureBucket = getCaptureBucket(now);
  const candidates: Array<typeof marketOddsSnapshots.$inferInsert> = [];
  const capturedFixtures = new Set<number>();

  for (const match of matches) {
    // Keep the learning signal clean: opening/closing analysis is pre-match.
    if (match.status !== "upcoming") continue;

    const event = findOddsEvent(match.home_team.name, match.away_team.name, oddsEvents);
    if (!event) continue;

    const bookmakers = selectBookmakers(event.bookmakers);
    for (const bookmaker of bookmakers) {
      const prices = extractThreeWayPrices(
        match.home_team.name,
        match.away_team.name,
        event,
        bookmaker,
      );
      if (!prices) continue;

      const implied = calculateNoVigProbabilities(
        prices.home,
        prices.draw,
        prices.away,
      );
      if (!implied) continue;

      capturedFixtures.add(match.id);
      candidates.push({
        fixtureId: match.id,
        leagueId: match.league_id ?? null,
        homeTeam: match.home_team.name,
        awayTeam: match.away_team.name,
        kickoffAt: match.kickoff ? new Date(match.kickoff) : null,
        matchStatus: match.status,
        bookmakerKey: bookmaker.key,
        bookmakerName: bookmaker.title ?? bookmaker.key,
        homeOdds: prices.home,
        drawOdds: prices.draw,
        awayOdds: prices.away,
        impliedHomeProb: implied.home,
        impliedDrawProb: implied.draw,
        impliedAwayProb: implied.away,
        captureBucket,
        observedAt: now,
      });
    }
  }

  if (!candidates.length) {
    return { enabled: true, observations: 0, fixtures: 0 };
  }

  try {
    await db
      .insert(marketOddsSnapshots)
      .values(candidates)
      .onConflictDoUpdate({
        target: [
          marketOddsSnapshots.fixtureId,
          marketOddsSnapshots.bookmakerKey,
          marketOddsSnapshots.captureBucket,
        ],
        set: {
          bookmakerName: sql`excluded.bookmaker_name`,
          homeOdds: sql`excluded.home_odds`,
          drawOdds: sql`excluded.draw_odds`,
          awayOdds: sql`excluded.away_odds`,
          impliedHomeProb: sql`excluded.implied_home_prob`,
          impliedDrawProb: sql`excluded.implied_draw_prob`,
          impliedAwayProb: sql`excluded.implied_away_prob`,
          matchStatus: sql`excluded.match_status`,
          kickoffAt: sql`excluded.kickoff_at`,
          observedAt: sql`excluded.observed_at`,
        },
      });

    return {
      enabled: true,
      observations: candidates.length,
      fixtures: capturedFixtures.size,
      bookmakers: Array.from(new Set(candidates.map((c) => c.bookmakerKey))),
      captureBucket,
    };
  } catch (err) {
    // Market intelligence must never take the predictor offline.
    logger.warn({ err }, "market intelligence snapshot persistence failed");
    return {
      enabled: true,
      observations: 0,
      fixtures: capturedFixtures.size,
      persistenceError: true,
    };
  }
}

export async function getMarketIntelligenceReport(maxSnapshots = 10_000) {
  const limit = clampInt(maxSnapshots, 100, 50_000);
  const snapshots = await db
    .select()
    .from(marketOddsSnapshots)
    .orderBy(desc(marketOddsSnapshots.observedAt))
    .limit(limit);

  if (!snapshots.length) {
    return emptyReport();
  }

  const fixtureIds = Array.from(new Set(snapshots.map((s) => s.fixtureId)));
  const [outcomes, predictions] = await Promise.all([
    db.select().from(matchOutcomes).where(inArray(matchOutcomes.fixtureId, fixtureIds)),
    db
      .select()
      .from(matchPredictions)
      .where(
        and(
          inArray(matchPredictions.fixtureId, fixtureIds),
          eq(matchPredictions.isLive, false),
        ),
      ),
  ]);

  const outcomeByFixture = new Map(outcomes.map((o) => [o.fixtureId, o]));
  const predictionByFixture = new Map(predictions.map((p) => [p.fixtureId, p]));
  const snapshotsByFixture = groupByFixture(snapshots);

  const evaluated: EvaluatedFixture[] = [];
  for (const [fixtureId, fixtureSnapshots] of snapshotsByFixture) {
    const evaluation = evaluateFixture(
      fixtureId,
      fixtureSnapshots,
      outcomeByFixture.get(fixtureId),
      predictionByFixture.get(fixtureId),
    );
    if (evaluation) evaluated.push(evaluation);
  }

  evaluated.sort(
    (a, b) => b.closingObservedAt.getTime() - a.closingObservedAt.getTime(),
  );

  const settled = evaluated.filter((r) => r.actualOutcome !== null);
  const withModel = settled.filter((r) => r.modelCorrect !== null);
  // Multiple bookmakers captured at the same instant are not movement history.
  // Only evaluate movement after the market has actually been observed at
  // different times.
  const movementRows = settled.filter(
    (r) => r.closingObservedAt.getTime() > r.openingObservedAt.getTime(),
  );
  const disagreements = withModel.filter(
    (r) => r.modelPick !== null && r.modelPick !== r.closingMarketPick,
  );
  const largeMoves = movementRows.filter(
    (r) => Math.max(r.movement.home, r.movement.draw, r.movement.away) >= 2.5,
  );

  const bookmakerPerformance = calculateBookmakerPerformance(
    snapshotsByFixture,
    outcomeByFixture,
  );

  return {
    policy: MARKET_INTELLIGENCE_POLICY,
    capture: {
      bucketMinutes: BUCKET_MINUTES,
      maxBookmakersPerFixture: MAX_BOOKMAKERS,
      preferredBookmakers: PREFERRED_BOOKMAKERS,
      externalApiCallsAdded: 0,
    },
    samples: {
      snapshotRowsLoaded: snapshots.length,
      fixturesObserved: evaluated.length,
      settledFixtures: settled.length,
      fixturesWithMovementHistory: movementRows.length,
      bookmakersObserved: bookmakerPerformance.length,
    },
    metrics: {
      modelAccuracyPct: percentage(withModel.filter((r) => r.modelCorrect).length, withModel.length),
      closingMarketAccuracyPct: percentage(
        settled.filter((r) => r.closingMarketCorrect).length,
        settled.length,
      ),
      movementLeaderAccuracyPct: percentage(
        movementRows.filter((r) => r.movementLeaderCorrect).length,
        movementRows.length,
      ),
      winnerBackedByMarketPct: percentage(
        movementRows.filter((r) => (r.winnerProbabilityMovePts ?? 0) > 0).length,
        movementRows.length,
      ),
      modelMarketAgreementPct: percentage(
        withModel.filter((r) => r.modelMarketAgreed).length,
        withModel.length,
      ),
      whenModelAndMarketDisagree: {
        samples: disagreements.length,
        modelAccuracyPct: percentage(
          disagreements.filter((r) => r.modelCorrect).length,
          disagreements.length,
        ),
        marketAccuracyPct: percentage(
          disagreements.filter((r) => r.closingMarketCorrect).length,
          disagreements.length,
        ),
      },
      largeMovementSignals: {
        thresholdProbabilityPoints: 2.5,
        samples: largeMoves.length,
        movementLeaderAccuracyPct: percentage(
          largeMoves.filter((r) => r.movementLeaderCorrect).length,
          largeMoves.length,
        ),
      },
    },
    bookmakerPerformance,
    recentSettled: settled.slice(0, 50),
  };
}

export async function getFixtureMarketIntelligence(fixtureId: number) {
  const snapshots = await db
    .select()
    .from(marketOddsSnapshots)
    .where(eq(marketOddsSnapshots.fixtureId, fixtureId))
    .orderBy(asc(marketOddsSnapshots.observedAt));

  const [outcomes, predictions] = await Promise.all([
    db.select().from(matchOutcomes).where(eq(matchOutcomes.fixtureId, fixtureId)).limit(1),
    db
      .select()
      .from(matchPredictions)
      .where(
        and(
          eq(matchPredictions.fixtureId, fixtureId),
          eq(matchPredictions.isLive, false),
        ),
      )
      .limit(1),
  ]);

  return {
    policy: MARKET_INTELLIGENCE_POLICY,
    evaluation: snapshots.length
      ? evaluateFixture(fixtureId, snapshots, outcomes[0], predictions[0])
      : null,
    snapshots,
  };
}

function evaluateFixture(
  fixtureId: number,
  snapshots: MarketSnapshot[],
  outcome?: OutcomeRow,
  prediction?: PredictionRow,
): EvaluatedFixture | null {
  if (!snapshots.length) return null;

  const byBookmaker = new Map<string, MarketSnapshot[]>();
  for (const row of snapshots) {
    const bucket = byBookmaker.get(row.bookmakerKey) ?? [];
    bucket.push(row);
    byBookmaker.set(row.bookmakerKey, bucket);
  }

  const openings: MarketSnapshot[] = [];
  const closings: MarketSnapshot[] = [];
  for (const rows of byBookmaker.values()) {
    rows.sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
    openings.push(rows[0]);
    closings.push(rows[rows.length - 1]);
  }

  if (!openings.length || !closings.length) return null;

  const opening = averageProbabilities(openings);
  const closing = averageProbabilities(closings);
  const movement = calculateProbabilityMovement(opening, closing);
  const movementLeader = strongestPositiveMovement(movement);
  const openingMarketPick = pickFromProbabilities(opening);
  const closingMarketPick = pickFromProbabilities(closing);
  const actualOutcome = asMarketSide(outcome?.outcome);
  const modelPick = prediction
    ? pickFromProbabilities({
        home: toPct(prediction.homeWinProb),
        draw: toPct(prediction.drawProb),
        away: toPct(prediction.awayWinProb),
      })
    : null;

  const first = openings.reduce((a, b) =>
    a.observedAt <= b.observedAt ? a : b,
  );
  const last = closings.reduce((a, b) =>
    a.observedAt >= b.observedAt ? a : b,
  );

  return {
    fixtureId,
    leagueId: first.leagueId ?? null,
    homeTeam: first.homeTeam,
    awayTeam: first.awayTeam,
    actualOutcome,
    modelPick,
    openingMarketPick,
    closingMarketPick,
    movementLeader,
    opening,
    closing,
    movement,
    winnerProbabilityMovePts: actualOutcome ? movement[actualOutcome] : null,
    modelCorrect: actualOutcome && modelPick ? modelPick === actualOutcome : null,
    closingMarketCorrect: actualOutcome ? closingMarketPick === actualOutcome : null,
    movementLeaderCorrect: actualOutcome ? movementLeader === actualOutcome : null,
    modelMarketAgreed: modelPick ? modelPick === closingMarketPick : null,
    bookmakerCount: byBookmaker.size,
    snapshotCount: snapshots.length,
    openingObservedAt: first.observedAt,
    closingObservedAt: last.observedAt,
  };
}

function calculateBookmakerPerformance(
  snapshotsByFixture: Map<number, MarketSnapshot[]>,
  outcomeByFixture: Map<number, OutcomeRow>,
) {
  const stats = new Map<string, { samples: number; correct: number }>();

  for (const [fixtureId, snapshots] of snapshotsByFixture) {
    const actual = asMarketSide(outcomeByFixture.get(fixtureId)?.outcome);
    if (!actual) continue;

    const byBookmaker = new Map<string, MarketSnapshot[]>();
    for (const row of snapshots) {
      const rows = byBookmaker.get(row.bookmakerKey) ?? [];
      rows.push(row);
      byBookmaker.set(row.bookmakerKey, rows);
    }

    for (const [bookmakerKey, rows] of byBookmaker) {
      rows.sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime());
      const closing = rows[0];
      const pick = pickFromProbabilities(snapshotProbabilities(closing));
      const current = stats.get(bookmakerKey) ?? { samples: 0, correct: 0 };
      current.samples++;
      if (pick === actual) current.correct++;
      stats.set(bookmakerKey, current);
    }
  }

  return Array.from(stats.entries())
    .map(([bookmakerKey, value]) => ({
      bookmakerKey,
      samples: value.samples,
      closingPickAccuracyPct: percentage(value.correct, value.samples),
    }))
    .sort((a, b) => b.samples - a.samples || b.closingPickAccuracyPct - a.closingPickAccuracyPct);
}

function groupByFixture(rows: MarketSnapshot[]) {
  const grouped = new Map<number, MarketSnapshot[]>();
  for (const row of rows) {
    const fixture = grouped.get(row.fixtureId) ?? [];
    fixture.push(row);
    grouped.set(row.fixtureId, fixture);
  }
  return grouped;
}

function averageProbabilities(rows: MarketSnapshot[]): ThreeWayProbabilities {
  const total = rows.reduce(
    (acc, row) => {
      acc.home += row.impliedHomeProb;
      acc.draw += row.impliedDrawProb;
      acc.away += row.impliedAwayProb;
      return acc;
    },
    { home: 0, draw: 0, away: 0 },
  );
  const n = Math.max(1, rows.length);
  return {
    home: round2(total.home / n),
    draw: round2(total.draw / n),
    away: round2(total.away / n),
  };
}

function snapshotProbabilities(row: MarketSnapshot): ThreeWayProbabilities {
  return {
    home: row.impliedHomeProb,
    draw: row.impliedDrawProb,
    away: row.impliedAwayProb,
  };
}

function findOddsEvent(homeTeam: string, awayTeam: string, oddsEvents: RawOddsEvent[]) {
  const normHome = normalizeName(homeTeam);
  const normAway = normalizeName(awayTeam);
  return oddsEvents.find((event) => {
    const eventHome = normalizeName(event.home_team);
    const eventAway = normalizeName(event.away_team);
    return namesMatch(normHome, eventHome) && namesMatch(normAway, eventAway);
  });
}

function namesMatch(a: string, b: string) {
  if (!a || !b) return false;
  const left = stripClubSuffix(a);
  const right = stripClubSuffix(b);
  if (left === right) return true;

  // Prefer missing a fixture over attaching another club's odds to it. This
  // deliberately avoids broad prefix matching such as Manchester City vs
  // Manchester United.
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length > right.length ? left : right;
  if (shorter.length < 7) return false;
  return longer.includes(shorter) && shorter.length / longer.length >= 0.65;
}

function stripClubSuffix(value: string) {
  return value.replace(/(?:footballclub|clubdefutbol|calcio|afc|fc|cf)$/g, "");
}

function selectBookmakers(bookmakers: RawOddsEvent["bookmakers"]) {
  const selected: RawOddsEvent["bookmakers"] = [];
  const used = new Set<string>();

  for (const preferredKey of PREFERRED_BOOKMAKERS) {
    const bookmaker = bookmakers.find((b) => b.key.toLowerCase() === preferredKey);
    if (!bookmaker || used.has(bookmaker.key)) continue;
    selected.push(bookmaker);
    used.add(bookmaker.key);
    if (selected.length >= MAX_BOOKMAKERS) return selected;
  }

  for (const bookmaker of bookmakers) {
    if (used.has(bookmaker.key)) continue;
    selected.push(bookmaker);
    used.add(bookmaker.key);
    if (selected.length >= MAX_BOOKMAKERS) break;
  }

  return selected;
}

function extractThreeWayPrices(
  homeTeam: string,
  awayTeam: string,
  event: RawOddsEvent,
  bookmaker: RawOddsEvent["bookmakers"][number],
) {
  const h2h = bookmaker.markets.find((market) => market.key === "h2h");
  if (!h2h) return null;

  const normHome = normalizeName(homeTeam);
  const normAway = normalizeName(awayTeam);
  const home = h2h.outcomes.find(
    (outcome) =>
      normalizeName(outcome.name) === normHome || outcome.name === event.home_team,
  )?.price;
  const away = h2h.outcomes.find(
    (outcome) =>
      normalizeName(outcome.name) === normAway || outcome.name === event.away_team,
  )?.price;
  const draw = h2h.outcomes.find(
    (outcome) => outcome.name.toLowerCase() === "draw",
  )?.price;

  if (![home, draw, away].every((v) => Number.isFinite(v) && Number(v) > 1)) {
    return null;
  }
  return { home: Number(home), draw: Number(draw), away: Number(away) };
}

function getCaptureBucket(date: Date) {
  const bucketMs = BUCKET_MINUTES * 60_000;
  return new Date(Math.floor(date.getTime() / bucketMs) * bucketMs).toISOString();
}

function normalizeName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "").trim();
}

function asMarketSide(value: unknown): MarketSide | null {
  return value === "home" || value === "draw" || value === "away" ? value : null;
}

function toPct(value: number) {
  if (!Number.isFinite(value)) return 0;
  return value <= 1 ? value * 100 : value;
}

function percentage(numerator: number, denominator: number) {
  if (!denominator) return null;
  return Math.round((numerator / denominator) * 10_000) / 100;
}

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

function clampInt(value: number, min: number, max: number) {
  const safe = Number.isFinite(value) ? Math.floor(value) : min;
  return Math.max(min, Math.min(max, safe));
}

function emptyReport() {
  return {
    policy: MARKET_INTELLIGENCE_POLICY,
    capture: {
      bucketMinutes: BUCKET_MINUTES,
      maxBookmakersPerFixture: MAX_BOOKMAKERS,
      preferredBookmakers: PREFERRED_BOOKMAKERS,
      externalApiCallsAdded: 0,
    },
    samples: {
      snapshotRowsLoaded: 0,
      fixturesObserved: 0,
      settledFixtures: 0,
      fixturesWithMovementHistory: 0,
      bookmakersObserved: 0,
    },
    metrics: {
      modelAccuracyPct: null,
      closingMarketAccuracyPct: null,
      movementLeaderAccuracyPct: null,
      winnerBackedByMarketPct: null,
      modelMarketAgreementPct: null,
      whenModelAndMarketDisagree: {
        samples: 0,
        modelAccuracyPct: null,
        marketAccuracyPct: null,
      },
      largeMovementSignals: {
        thresholdProbabilityPoints: 2.5,
        samples: 0,
        movementLeaderAccuracyPct: null,
      },
    },
    bookmakerPerformance: [],
    recentSettled: [],
  };
}
