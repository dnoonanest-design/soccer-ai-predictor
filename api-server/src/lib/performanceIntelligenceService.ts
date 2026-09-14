import { pool } from "@workspace/db";
import { getTrackedCompetition } from "./leagueConfig";
import { verifyPredictionAuditIntegrity } from "./predictionAccuracyAuditService";

function n(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 10_000) / 10_000 : null;
}

function metricRows(rows: any[]) {
  return rows.map((row) => ({
    ...row,
    samples: Number(row.samples ?? 0),
    accuracy: n(row.accuracy),
    brierScore: n(row.brier_score),
    logLoss: n(row.log_loss),
    averageConfidence: n(row.average_confidence),
  }));
}

function competitionGroup(leagueId: number | null) {
  if (leagueId == null) return { name: "Unknown", kind: "unknown", tier: null, strengthBand: "unknown" };
  const c = getTrackedCompetition(leagueId);
  if (!c) return { name: `Competition ${leagueId}`, kind: "unknown", tier: null, strengthBand: "unknown" };
  const strengthBand = c.kind === "uefa" || c.tier === 1 ? "strong" : c.tier === 2 ? "second-tier" : "cup";
  return { name: c.name, country: c.country, kind: c.kind, tier: c.tier ?? null, strengthBand };
}

export async function getPerformanceIntelligenceReport(daysInput = 14) {
  const days = Math.max(7, Math.min(14, Math.floor(Number(daysInput) || 14)));
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60_000);
  const integrity = await verifyPredictionAuditIntegrity();
  const ids = integrity.validIds;
  const empty = ids.length === 0;

  const query = async (sql: string, extra: unknown[] = []) => {
    if (empty) return { rows: [] as any[] };
    return pool.query(sql, [ids, cutoff, ...extra]);
  };

  const [byLeague, byPick, byDataTier, byPhase, lineup, manchester, recentDays, warningRows, market] = await Promise.all([
    query(`SELECT league_id, COUNT(*)::int samples, AVG(correct::int) accuracy,
                  AVG(brier_score) brier_score, AVG(log_loss) log_loss, AVG(pick_confidence) average_confidence
             FROM prediction_audit_records
            WHERE settled_at IS NOT NULL AND id = ANY($1::bigint[]) AND captured_at >= $2
            GROUP BY league_id ORDER BY samples DESC`),
    query(`SELECT predicted_outcome AS group_name, COUNT(*)::int samples, AVG(correct::int) accuracy,
                  AVG(brier_score) brier_score, AVG(log_loss) log_loss, AVG(pick_confidence) average_confidence
             FROM prediction_audit_records
            WHERE settled_at IS NOT NULL AND id = ANY($1::bigint[]) AND captured_at >= $2
            GROUP BY predicted_outcome ORDER BY samples DESC`),
    query(`SELECT data_tier AS group_name, COUNT(*)::int samples, AVG(correct::int) accuracy,
                  AVG(brier_score) brier_score, AVG(log_loss) log_loss, AVG(pick_confidence) average_confidence
             FROM prediction_audit_records
            WHERE settled_at IS NOT NULL AND id = ANY($1::bigint[]) AND captured_at >= $2
            GROUP BY data_tier ORDER BY samples DESC`),
    query(`SELECT phase AS group_name, COUNT(*)::int samples, AVG(correct::int) accuracy,
                  AVG(brier_score) brier_score, AVG(log_loss) log_loss, AVG(pick_confidence) average_confidence
             FROM prediction_audit_records
            WHERE settled_at IS NOT NULL AND id = ANY($1::bigint[]) AND captured_at >= $2
            GROUP BY phase ORDER BY phase`),
    query(`SELECT CASE WHEN COALESCE(mc.home_starting_xi_count,0) >= 11 AND COALESCE(mc.away_starting_xi_count,0) >= 11
                       THEN 'confirmed-lineups' ELSE 'lineups-not-confirmed' END AS group_name,
                  COUNT(*)::int samples, AVG(a.correct::int) accuracy, AVG(a.brier_score) brier_score,
                  AVG(a.log_loss) log_loss, AVG(a.pick_confidence) average_confidence
             FROM prediction_audit_records a
             LEFT JOIN match_circumstances mc ON mc.fixture_id = a.fixture_id
            WHERE a.settled_at IS NOT NULL AND a.id = ANY($1::bigint[]) AND a.captured_at >= $2
            GROUP BY group_name ORDER BY samples DESC`),
    query(`SELECT CASE WHEN EXISTS (
                         SELECT 1 FROM prediction_snapshots ps
                          WHERE ps.fixture_id = a.fixture_id
                            AND ps.created_at <= COALESCE(a.kickoff_at, a.captured_at)
                            AND COALESCE(ps.reasons_json,'') ILIKE '%Manchester Rule:%'
                       ) THEN 'manchester-rule-tagged' ELSE 'not-tagged' END AS group_name,
                  COUNT(*)::int samples, AVG(a.correct::int) accuracy, AVG(a.brier_score) brier_score,
                  AVG(a.log_loss) log_loss, AVG(a.pick_confidence) average_confidence
             FROM prediction_audit_records a
            WHERE a.settled_at IS NOT NULL AND a.id = ANY($1::bigint[]) AND a.captured_at >= $2
            GROUP BY group_name ORDER BY samples DESC`),
    query(`SELECT DATE(captured_at) AS day, COUNT(*)::int samples, AVG(correct::int) accuracy,
                  AVG(brier_score) brier_score, AVG(log_loss) log_loss, AVG(pick_confidence) average_confidence
             FROM prediction_audit_records
            WHERE settled_at IS NOT NULL AND id = ANY($1::bigint[]) AND captured_at >= $2
            GROUP BY DATE(captured_at) ORDER BY day`),
    pool.query(`SELECT verdict, missing_required_json, advisory_json, COUNT(*)::int samples
                  FROM lifecycle_reliability_fixtures
                 WHERE verdict IN ('warning','failed')
                   AND COALESCE(last_evaluated_at, updated_at) >= $1
                 GROUP BY verdict, missing_required_json, advisory_json
                 ORDER BY samples DESC`, [cutoff]),
    query(`WITH audited AS (
             SELECT DISTINCT ON (fixture_id) fixture_id, home_win_prob, draw_prob, away_win_prob, captured_at
               FROM prediction_audit_records
              WHERE phase='prematch' AND settled_at IS NOT NULL AND id = ANY($1::bigint[]) AND captured_at >= $2
              ORDER BY fixture_id, captured_at DESC
           ), market_edges AS (
             SELECT m.fixture_id,
                    (ARRAY_AGG(m.implied_home_prob ORDER BY m.observed_at ASC))[1] first_home,
                    (ARRAY_AGG(m.implied_draw_prob ORDER BY m.observed_at ASC))[1] first_draw,
                    (ARRAY_AGG(m.implied_away_prob ORDER BY m.observed_at ASC))[1] first_away,
                    (ARRAY_AGG(m.implied_home_prob ORDER BY m.observed_at DESC))[1] last_home,
                    (ARRAY_AGG(m.implied_draw_prob ORDER BY m.observed_at DESC))[1] last_draw,
                    (ARRAY_AGG(m.implied_away_prob ORDER BY m.observed_at DESC))[1] last_away
               FROM market_odds_snapshots m JOIN audited a ON a.fixture_id=m.fixture_id
              GROUP BY m.fixture_id
           )
           SELECT COUNT(*)::int samples,
                  AVG((ABS(last_home-first_home)+ABS(last_draw-first_draw)+ABS(last_away-first_away))/3.0) avg_market_movement,
                  AVG((ABS(a.home_win_prob-last_home)+ABS(a.draw_prob-last_draw)+ABS(a.away_win_prob-last_away))/3.0) avg_model_market_gap
             FROM audited a JOIN market_edges m ON m.fixture_id=a.fixture_id`),
  ]);

  const leagueRows = metricRows(byLeague.rows).map((row) => {
    const leagueId = row.league_id == null ? null : Number(row.league_id);
    return { ...row, leagueId, ...competitionGroup(leagueId) };
  });

  const byCompetitionType = new Map<string, { samples: number; weightedAccuracy: number; weightedBrier: number; weightedLogLoss: number }>();
  for (const row of leagueRows) {
    const key = `${row.kind}:${row.strengthBand}`;
    const current = byCompetitionType.get(key) ?? { samples: 0, weightedAccuracy: 0, weightedBrier: 0, weightedLogLoss: 0 };
    current.samples += row.samples;
    current.weightedAccuracy += (row.accuracy ?? 0) * row.samples;
    current.weightedBrier += (row.brierScore ?? 0) * row.samples;
    current.weightedLogLoss += (row.logLoss ?? 0) * row.samples;
    byCompetitionType.set(key, current);
  }

  const warnings = new Map<string, number>();
  for (const row of warningRows.rows) {
    const missing = Array.isArray(row.missing_required_json) ? row.missing_required_json : [];
    if (missing.length === 0) warnings.set(`${row.verdict}:advisory`, (warnings.get(`${row.verdict}:advisory`) ?? 0) + Number(row.samples ?? 0));
    for (const reason of missing) {
      const key = `${row.verdict}:${String(reason)}`;
      warnings.set(key, (warnings.get(key) ?? 0) + Number(row.samples ?? 0));
    }
  }

  const marketRow = market.rows[0] ?? {};
  return {
    generatedAt: new Date().toISOString(),
    windowDays: days,
    cutoff: cutoff.toISOString(),
    integrity: { status: integrity.status, verified: integrity.verified, invalid: integrity.invalid },
    byLeague: leagueRows,
    byCompetitionType: Array.from(byCompetitionType.entries()).map(([group, value]) => ({
      group,
      samples: value.samples,
      accuracy: value.samples ? n(value.weightedAccuracy / value.samples) : null,
      brierScore: value.samples ? n(value.weightedBrier / value.samples) : null,
      logLoss: value.samples ? n(value.weightedLogLoss / value.samples) : null,
    })),
    byPickSide: metricRows(byPick.rows),
    byDataQuality: metricRows(byDataTier.rows),
    byPhase: metricRows(byPhase.rows),
    byLineupState: metricRows(lineup.rows),
    manchesterRule: metricRows(manchester.rows),
    dailyTrend: metricRows(recentDays.rows).map((row) => ({ ...row, day: row.day })),
    lifecycleWarnings: Array.from(warnings.entries()).map(([reason, samples]) => ({ reason, samples })).sort((a,b) => b.samples-a.samples),
    marketBenchmark: {
      policy: "external-evaluation-only",
      corePredictionUsesBookmakerOdds: false,
      samples: Number(marketRow.samples ?? 0),
      averageMarketMovementPctPoints: n(marketRow.avg_market_movement),
      averageModelMarketGapPctPoints: n(marketRow.avg_model_market_gap),
    },
    learningSafety: {
      minimumPromotionSamples: 250,
      minimumResidualSamples: 100,
      principle: "Promote only after chronological holdout improvement; bookmaker prices are excluded from training.",
    },
  };
}
