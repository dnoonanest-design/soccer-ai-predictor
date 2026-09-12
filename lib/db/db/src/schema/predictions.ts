import { pgTable, serial, integer, real, text, timestamp, boolean, unique, numeric, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const matchPredictions = pgTable(
  "match_predictions",
  {
    id:              serial("id").primaryKey(),
    fixtureId:       integer("fixture_id").notNull(),
    homeTeam:        text("home_team").notNull(),
    awayTeam:        text("away_team").notNull(),
    leagueId:        integer("league_id"),
    homeWinProb:     real("home_win_prob").notNull(),
    drawProb:        real("draw_prob").notNull(),
    awayWinProb:     real("away_win_prob").notNull(),
    isLive:          boolean("is_live").notNull().default(false),
    modelVersion:    text("model_version").notNull().default("v1"),
    kickoffAt:       timestamp("kickoff_at"),
    createdAt:       timestamp("created_at").notNull().defaultNow(),
    updatedAt:       timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [unique("uniq_fixture_live").on(t.fixtureId, t.isLive)],
);

export const matchOutcomes = pgTable("match_outcomes", {
  id:          serial("id").primaryKey(),
  fixtureId:   integer("fixture_id").notNull().unique(),
  outcome:     text("outcome").notNull(),        // "home" | "draw" | "away"
  scoreHome:   integer("score_home").notNull(),
  scoreAway:   integer("score_away").notNull(),
  recordedAt:  timestamp("recorded_at").notNull().defaultNow(),
});

export const insertPredictionSchema = createInsertSchema(matchPredictions).omit({ id: true, createdAt: true, updatedAt: true });
export const insertOutcomeSchema    = createInsertSchema(matchOutcomes).omit({ id: true, recordedAt: true });

export type InsertPrediction = z.infer<typeof insertPredictionSchema>;
export type Prediction       = typeof matchPredictions.$inferSelect;
export type InsertOutcome    = z.infer<typeof insertOutcomeSchema>;
export type Outcome          = typeof matchOutcomes.$inferSelect;


export const predictionSnapshots = pgTable("prediction_snapshots", {
  id:              serial("id").primaryKey(),
  fixtureId:       integer("fixture_id").notNull(),
  leagueId:        integer("league_id"),
  minute:          integer("minute"),
  status:          text("status").notNull(),
  homeWinProb:     real("home_win_prob").notNull(),
  drawProb:        real("draw_prob").notNull(),
  awayWinProb:     real("away_win_prob").notNull(),
  over25Prob:      real("over25_prob"),
  bttsProb:        real("btts_prob"),
  homeXg:          real("home_xg"),
  awayXg:          real("away_xg"),
  pressureHome:    real("pressure_home"),
  pressureAway:    real("pressure_away"),
  nextGoalHome:    real("next_goal_home"),
  nextGoalAway:    real("next_goal_away"),
  confidence:      real("confidence"),
  modelVersion:    text("model_version").notNull().default("v2-statistical"),
  reasonsJson:     text("reasons_json"),
  valueEdgesJson:  text("value_edges_json"),
  createdAt:       timestamp("created_at").notNull().defaultNow(),
});

export const betTracker = pgTable("bet_tracker", {
  id:             serial("id").primaryKey(),
  fixtureId:      integer("fixture_id").notNull(),
  homeTeam:       text("home_team").notNull(),
  awayTeam:       text("away_team").notNull(),
  market:         text("market").notNull(),
  selection:      text("selection").notNull(),
  decimalOdds:    real("decimal_odds").notNull(),
  stake:          numeric("stake", { precision: 12, scale: 2 }).notNull().default("1.00"),
  modelProb:      real("model_prob"),
  edgePct:        real("edge_pct"),
  status:         text("status").notNull().default("open"),
  profit:         numeric("profit", { precision: 12, scale: 2 }),
  notes:          text("notes"),
  placedAt:       timestamp("placed_at").notNull().defaultNow(),
  settledAt:      timestamp("settled_at"),
});

export const modelTrainingRuns = pgTable("model_training_runs", {
  id:             serial("id").primaryKey(),
  modelVersion:   text("model_version").notNull(),
  trainingRows:   integer("training_rows").notNull(),
  holdoutRows:    integer("holdout_rows").notNull(),
  pickAccuracy:   real("pick_accuracy"),
  brierScore:     real("brier_score"),
  roiPct:         real("roi_pct"),
  weightsJson:    text("weights_json").notNull(),
  notes:          text("notes"),
  createdAt:      timestamp("created_at").notNull().defaultNow(),
});

export const liveAlerts = pgTable("live_alerts", {
  id:             serial("id").primaryKey(),
  fixtureId:      integer("fixture_id").notNull(),
  alertType:      text("alert_type").notNull(),
  teamSide:       text("team_side"),
  minute:         integer("minute"),
  pressureScore:  real("pressure_score"),
  message:        text("message").notNull(),
  createdAt:      timestamp("created_at").notNull().defaultNow(),
});



export const deepMatchStats = pgTable(
  "deep_match_stats",
  {
    id: serial("id").primaryKey(),
    fixtureId: integer("fixture_id").notNull(),
    leagueId: integer("league_id"),
    status: text("status").notNull(),
    minute: integer("minute"),
    homeTeam: text("home_team").notNull(),
    awayTeam: text("away_team").notNull(),
    scoreHome: integer("score_home"),
    scoreAway: integer("score_away"),
    homeXg: real("home_xg"),
    awayXg: real("away_xg"),
    homeMomentum: real("home_momentum"),
    awayMomentum: real("away_momentum"),
    nextGoalHome: real("next_goal_home"),
    nextGoalAway: real("next_goal_away"),
    homeShots: integer("home_shots"),
    awayShots: integer("away_shots"),
    homeShotsOnTarget: integer("home_shots_on_target"),
    awayShotsOnTarget: integer("away_shots_on_target"),
    homeCorners: integer("home_corners"),
    awayCorners: integer("away_corners"),
    homeRedCards: integer("home_red_cards"),
    awayRedCards: integer("away_red_cards"),
    rawStatsJson: jsonb("raw_stats_json"),
    collectedAt: timestamp("collected_at").notNull().defaultNow(),
  },
  (t) => [unique("uniq_deep_stats_fixture_minute").on(t.fixtureId, t.minute, t.status)],
);

export const backgroundJobRuns = pgTable("background_job_runs", {
  id: serial("id").primaryKey(),
  jobName: text("job_name").notNull(),
  status: text("status").notNull(),
  checkedCount: integer("checked_count").notNull().default(0),
  changedCount: integer("changed_count").notNull().default(0),
  errorMessage: text("error_message"),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  finishedAt: timestamp("finished_at"),
});

export const calibrationParameters = pgTable("calibration_parameters", {
  id: serial("id").primaryKey(),
  modelVersion: text("model_version").notNull(),
  sampleSize: integer("sample_size").notNull(),
  factorsJson: jsonb("factors_json").notNull(),
  metricsJson: jsonb("metrics_json").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});


export const matchCircumstances = pgTable("match_circumstances", {
  id: serial("id").primaryKey(),
  fixtureId: integer("fixture_id").notNull().unique(),
  leagueId: integer("league_id"),
  homeTeam: text("home_team").notNull(),
  awayTeam: text("away_team").notNull(),
  status: text("status").notNull(),
  minute: integer("minute"),
  homeFormation: text("home_formation"),
  awayFormation: text("away_formation"),
  homeStartingXiCount: integer("home_starting_xi_count"),
  awayStartingXiCount: integer("away_starting_xi_count"),
  homeMissingPlayers: integer("home_missing_players"),
  awayMissingPlayers: integer("away_missing_players"),
  homeStartersOut: integer("home_starters_out"),
  awayStartersOut: integer("away_starters_out"),
  homeYellowCards: integer("home_yellow_cards"),
  awayYellowCards: integer("away_yellow_cards"),
  homeRedCards: integer("home_red_cards"),
  awayRedCards: integer("away_red_cards"),
  homeInMatchInjuries: integer("home_in_match_injuries"),
  awayInMatchInjuries: integer("away_in_match_injuries"),
  homeGoalContributionPlayers: integer("home_goal_contribution_players"),
  awayGoalContributionPlayers: integer("away_goal_contribution_players"),
  homeAvgPlayerRating: real("home_avg_player_rating"),
  awayAvgPlayerRating: real("away_avg_player_rating"),
  homeStarPlayerRating: real("home_star_player_rating"),
  awayStarPlayerRating: real("away_star_player_rating"),
  homeFormScore: real("home_form_score"),
  awayFormScore: real("away_form_score"),
  circumstanceScoreHome: real("circumstance_score_home"),
  circumstanceScoreAway: real("circumstance_score_away"),
  rawLineupsJson: jsonb("raw_lineups_json"),
  rawInjuriesJson: jsonb("raw_injuries_json"),
  rawPlayersJson: jsonb("raw_players_json"),
  rawEventsJson: jsonb("raw_events_json"),
  collectedAt: timestamp("collected_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const playerMatchFactors = pgTable("player_match_factors", {
  id: serial("id").primaryKey(),
  fixtureId: integer("fixture_id").notNull(),
  teamSide: text("team_side").notNull(),
  teamName: text("team_name").notNull(),
  playerId: integer("player_id"),
  playerName: text("player_name").notNull(),
  role: text("role"),
  position: text("position"),
  starter: boolean("starter"),
  captain: boolean("captain"),
  rating: real("rating"),
  minutes: integer("minutes"),
  goals: integer("goals"),
  assists: integer("assists"),
  shots: integer("shots"),
  keyPasses: integer("key_passes"),
  yellowCards: integer("yellow_cards"),
  redCards: integer("red_cards"),
  injuredDuringMatch: boolean("injured_during_match").notNull().default(false),
  missingBeforeMatch: boolean("missing_before_match").notNull().default(false),
  influenceScore: real("influence_score"),
  rawJson: jsonb("raw_json"),
  collectedAt: timestamp("collected_at").notNull().defaultNow(),
}, (t) => [unique("uniq_player_match_factor").on(t.fixtureId, t.teamSide, t.playerName)]);

export const factorLearningInsights = pgTable("factor_learning_insights", {
  id: serial("id").primaryKey(),
  factorName: text("factor_name").notNull(),
  factorGroup: text("factor_group").notNull(),
  leagueId: integer("league_id"),
  sampleSize: integer("sample_size").notNull(),
  winRateWhenPositive: real("win_rate_when_positive"),
  winRateWhenNegative: real("win_rate_when_negative"),
  avgGoalDiffImpact: real("avg_goal_diff_impact"),
  correlation: real("correlation"),
  learnedWeight: real("learned_weight"),
  confidence: real("confidence"),
  notes: text("notes"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});


export const similarMatchMemory = pgTable("similar_match_memory", {
  id: serial("id").primaryKey(),
  fixtureId: integer("fixture_id").notNull(),
  leagueId: integer("league_id"),
  homeTeam: text("home_team").notNull(),
  awayTeam: text("away_team").notNull(),
  matchSignature: text("match_signature").notNull(),
  featureVectorJson: jsonb("feature_vector_json").notNull(),
  predictedOutcome: text("predicted_outcome"),
  actualOutcome: text("actual_outcome"),
  predictedHomeProb: real("predicted_home_prob"),
  predictedDrawProb: real("predicted_draw_prob"),
  predictedAwayProb: real("predicted_away_prob"),
  scoreHome: integer("score_home"),
  scoreAway: integer("score_away"),
  similarityCluster: text("similarity_cluster"),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const aiModelRegistry = pgTable("ai_model_registry", {
  id: serial("id").primaryKey(),
  modelVersion: text("model_version").notNull(),
  modelType: text("model_type").notNull(),
  featureSetJson: jsonb("feature_set_json").notNull(),
  weightsJson: jsonb("weights_json").notNull(),
  metricsJson: jsonb("metrics_json").notNull(),
  trainingRows: integer("training_rows").notNull().default(0),
  active: boolean("active").notNull().default(false),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const aiLearningAudits = pgTable("ai_learning_audits", {
  id: serial("id").primaryKey(),
  auditType: text("audit_type").notNull(),
  sampleSize: integer("sample_size").notNull().default(0),
  beforeMetricsJson: jsonb("before_metrics_json"),
  afterMetricsJson: jsonb("after_metrics_json"),
  accepted: boolean("accepted").notNull().default(false),
  recommendationsJson: jsonb("recommendations_json"),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const selfImprovementQueue = pgTable("self_improvement_queue", {
  id: serial("id").primaryKey(),
  issueType: text("issue_type").notNull(),
  priority: integer("priority").notNull().default(5),
  description: text("description").notNull(),
  evidenceJson: jsonb("evidence_json"),
  status: text("status").notNull().default("open"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at"),
});


export const aiLearningMemory = pgTable("ai_learning_memory", {
  id: serial("id").primaryKey(),
  learningType: text("learning_type").notNull(),
  source: text("source").notNull(),
  fixtureId: integer("fixture_id"),
  leagueId: integer("league_id"),
  subject: text("subject"),
  summary: text("summary").notNull(),
  evidenceJson: jsonb("evidence_json"),
  learnedWeightsJson: jsonb("learned_weights_json"),
  confidence: real("confidence"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const aiBiweeklyUpdates = pgTable("ai_biweekly_updates", {
  id: serial("id").primaryKey(),
  periodStart: timestamp("period_start").notNull(),
  periodEnd: timestamp("period_end").notNull(),
  status: text("status").notNull().default("recorded"),
  sampleSize: integer("sample_size").notNull().default(0),
  summary: text("summary").notNull(),
  metricsJson: jsonb("metrics_json"),
  improvementsJson: jsonb("improvements_json"),
  appliedModelVersion: text("applied_model_version"),
  applied: boolean("applied").notNull().default(false),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type AiLearningMemory = typeof aiLearningMemory.$inferSelect;
export type AiBiweeklyUpdate = typeof aiBiweeklyUpdates.$inferSelect;

export const appUsers = pgTable("app_users", {
  id:             serial("id").primaryKey(),
  email:          text("email").notNull().unique(),
  displayName:    text("display_name"),
  plan:           text("plan").notNull().default("free"),
  createdAt:      timestamp("created_at").notNull().defaultNow(),
});

export const userWatchlist = pgTable(
  "user_watchlist",
  {
    id:          serial("id").primaryKey(),
    userId:      integer("user_id").notNull(),
    fixtureId:   integer("fixture_id").notNull(),
    alertRules:  text("alert_rules"),
    createdAt:   timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [unique("uniq_user_fixture_watch").on(t.userId, t.fixtureId)],
);

// ── Push subscriptions (persisted to DB so they survive server restarts) ──────
export const pushSubscriptions = pgTable("push_subscriptions", {
  id:        serial("id").primaryKey(),
  endpoint:  text("endpoint").notNull().unique(),
  keysJson:  text("keys_json"),           // JSON: { p256dh, auth }
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertPushSubscriptionSchema = createInsertSchema(pushSubscriptions).omit({ id: true, createdAt: true, updatedAt: true });
export type PushSubscription = typeof pushSubscriptions.$inferSelect;

export const insertPredictionSnapshotSchema = createInsertSchema(predictionSnapshots).omit({ id: true, createdAt: true });
export const insertBetTrackerSchema         = createInsertSchema(betTracker).omit({ id: true, placedAt: true, settledAt: true });
export const insertTrainingRunSchema        = createInsertSchema(modelTrainingRuns).omit({ id: true, createdAt: true });
export const insertLiveAlertSchema          = createInsertSchema(liveAlerts).omit({ id: true, createdAt: true });

export type PredictionSnapshot = typeof predictionSnapshots.$inferSelect;
export type InsertPredictionSnapshot = z.infer<typeof insertPredictionSnapshotSchema>;
export type BetTrackerEntry = typeof betTracker.$inferSelect;
export type InsertBetTrackerEntry = z.infer<typeof insertBetTrackerSchema>;
export type ModelTrainingRun = typeof modelTrainingRuns.$inferSelect;
export type LiveAlert = typeof liveAlerts.$inferSelect;


export const insertDeepMatchStatsSchema = createInsertSchema(deepMatchStats).omit({ id: true, collectedAt: true });
export type DeepMatchStats = typeof deepMatchStats.$inferSelect;
export type BackgroundJobRun = typeof backgroundJobRuns.$inferSelect;
export type CalibrationParameter = typeof calibrationParameters.$inferSelect;


export const insertMatchCircumstancesSchema = createInsertSchema(matchCircumstances).omit({ id: true, collectedAt: true, updatedAt: true });
export const insertPlayerMatchFactorsSchema = createInsertSchema(playerMatchFactors).omit({ id: true, collectedAt: true });
export const insertFactorLearningInsightsSchema = createInsertSchema(factorLearningInsights).omit({ id: true, createdAt: true });
export type MatchCircumstances = typeof matchCircumstances.$inferSelect;
export type PlayerMatchFactor = typeof playerMatchFactors.$inferSelect;
export type FactorLearningInsight = typeof factorLearningInsights.$inferSelect;


export type SimilarMatchMemory = typeof similarMatchMemory.$inferSelect;
export type AiModelRegistry = typeof aiModelRegistry.$inferSelect;
export type AiLearningAudit = typeof aiLearningAudits.$inferSelect;
export type SelfImprovementQueue = typeof selfImprovementQueue.$inferSelect;
