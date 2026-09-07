import { pgTable, serial, integer, real, text, timestamp, unique, index } from "drizzle-orm/pg-core";

/**
 * Bookmaker prices are stored in a separate market-intelligence dataset.
 * They are deliberately NOT prediction features. The core model can be
 * evaluated against the market without being trained from bookmaker prices.
 */
export const marketOddsSnapshots = pgTable(
  "market_odds_snapshots",
  {
    id: serial("id").primaryKey(),
    fixtureId: integer("fixture_id").notNull(),
    leagueId: integer("league_id"),
    homeTeam: text("home_team").notNull(),
    awayTeam: text("away_team").notNull(),
    kickoffAt: timestamp("kickoff_at"),
    matchStatus: text("match_status").notNull(),
    bookmakerKey: text("bookmaker_key").notNull(),
    bookmakerName: text("bookmaker_name"),
    homeOdds: real("home_odds").notNull(),
    drawOdds: real("draw_odds").notNull(),
    awayOdds: real("away_odds").notNull(),
    impliedHomeProb: real("implied_home_prob").notNull(),
    impliedDrawProb: real("implied_draw_prob").notNull(),
    impliedAwayProb: real("implied_away_prob").notNull(),
    captureBucket: text("capture_bucket").notNull(),
    observedAt: timestamp("observed_at").notNull().defaultNow(),
  },
  (t) => [
    unique("uniq_market_fixture_book_bucket").on(
      t.fixtureId,
      t.bookmakerKey,
      t.captureBucket,
    ),
    index("idx_market_odds_fixture_time").on(t.fixtureId, t.observedAt),
    index("idx_market_odds_bookmaker_time").on(t.bookmakerKey, t.observedAt),
  ],
);

export type MarketOddsSnapshot = typeof marketOddsSnapshots.$inferSelect;
