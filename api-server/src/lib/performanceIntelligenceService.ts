import { pool } from "@workspace/db";
import { getTrackedCompetition } from "./leagueConfig";
import { verifyPredictionAuditIntegrity } from "./predictionAccuracyAuditService";
import { canonicalPrematchAuditCte } from "./canonicalPrematchAudit";

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

  // Every fixture-level breakdown below uses canonical_prematch: the latest
  // integrity-verified prediction captured before kickoff, one row per
  // fixture. In-play checkpoints are reported only in their own
  // inPlayByCheckpoint block and never mixed into pre-match accuracy.
  const canonical = `WITH ${canonicalPrematchAuditCte("$1")}`;
  const metricColumns = `COUNT(*)::int samples, AVG(correct::int) accuracy,
                  AVG(brier_score) brier_score, AVG(log_loss) log_loss, AVG(pick_confidence) average_confidence`;
  const [byLeague, byPick, byDataTier, byPhase, inPlayByCheckpoint, lineup, manchester, recentDays, warningRows, market] = await Promise.all([
    query(`${canonical}
           SELECT league_id, ${metricColumns}
             FROM canonical_prematch
            WHERE settled_at IS NOT NULL AND captured_at >= $2
            GROUP BY league_id ORDER BY samples DESC`),
    query(`${canonical}
           SELECT predicted_outcome AS group_name, ${metricColumns}
             FROM canonical_prematch
            WHERE settled_at IS NOT NULL AND captured_at >= $2
            GROUP BY predicted_outcome ORDER BY samples DESC`),
    query(`${canonical}
           SELECT data_tier AS group_name, ${metricColumns}
             FROM canonical_prematch
            WHERE settled_at IS NOT NULL AND captured_at >= $2
            GROUP BY data_tier ORDER BY samples DESC`),
    // Phase comparison: pre-match uses one row per fixture; in-play uses all
    // in-play checkpoints. The two rows are shown side by side, never summed.
    query(`${canonical}
           SELECT 'prematch' AS group_name, ${metricColumns}
             FROM canonical_prematch
            WHERE settled_at IS NOT NULL AND captured_at >= $2
           UNION ALL
           SELECT 'live' AS group_name, ${metricColumns}
             FROM prediction_audit_records
            WHERE phase = 'live' AND settled_at IS NOT NULL AND id = ANY($1::bigint[]) AND captured_at >= $2`),
    query(`SELECT checkpoint AS group_name, ${metricColumns}
             FROM prediction_audit_records
            WHERE phase = 'live' AND settled_at IS NOT NULL AND id = ANY($1::bigint[]) AND captured_at >= $2
            GROUP BY checkpoint ORDER BY checkpoint`),
    query(`${canonical}
           SELECT CASE WHEN COALESCE(mc.home_starting_xi_count,0) >= 11 AND COALESCE(mc.away_starting_xi_count,0) >= 11
                       THEN 'confirmed-lineups' ELSE 'lineups-not-confirmed' END AS group_name,
                  COUNT(*)::int samples, AVG(a.correct::int) accuracy, AVG(a.brier_score) brier_score,
                  AVG(a.log_loss) log_loss, AVG(a.pick_confidence) average_confidence
             FROM canonical_prematch a
             LEFT JOIN LATERAL (
               SELECT x.home_starting_xi_count, x.away_starting_xi_count
                 FROM prematch_circumstances x
                WHERE x.fixture_id = a.fixture_id
                  AND x.updated_at <= a.captured_at
                ORDER BY x.updated_at DESC
                LIMIT 1
             ) mc ON TRUE
            WHERE a.settled_at IS NOT NULL AND a.captured_at >= $2
            GROUP BY group_name ORDER BY samples DESC`),
    query(`${canonical}
           SELECT CASE WHEN EXISTS (
                         SELECT 1 FROM prediction_snapshots ps
                          WHERE ps.fixture_id = a.fixture_id
                            AND ps.created_at <= a.captured_at
                            AND COALESCE(ps.reasons_json,'') ILIKE '%Manchester Rule:%'
                       ) THEN 'manchester-rule-tagged' ELSE 'not-tagged' END AS group_name,
                  COUNT(*)::int samples, AVG(a.correct::int) accuracy, AVG(a.brier_score) brier_score,
                  AVG(a.log_loss) log_loss, AVG(a.pick_confidence) average_confidence
             FROM canonical_prematch a
            WHERE a.settled_at IS NOT NULL AND a.captured_at >= $2
            GROUP BY group_name ORDER BY samples DESC`),
    query(`${canonical}
           SELECT DATE(captured_at) AS day, ${metricColumns}
             FROM canonical_prematch
            WHERE settled_at IS NOT NULL AND captured_at >= $2
            GROUP BY DATE(captured_at) ORDER BY day`),
    pool.query(`SELECT verdict, missing_required_json, advisory_json, COUNT(*)::int samples
                  FROM lifecycle_reliability_fixtures
                 WHERE verdict IN ('warning','failed')
                   AND COALESCE(last_evaluated_at, updated_at) >= $1
                 GROUP BY verdict, missing_required_json, advisory_json
                 ORDER BY samples DESC`, [cutoff]),
    // Market benchmark on identical fixtures. "Closing" = each bookmaker's
    // last no-vig price observed before kickoff, averaged across bookmakers.
    // Compares the sealed served prediction with the closing market (served pre-match numbers include stored odds since 26 Oct 2026).
    query(`${canonical}, audited AS (
             SELECT fixture_id, kickoff_at, home_win_prob, draw_prob, away_win_prob,
                    actual_outcome, correct, brier_score
               FROM canonical_prematch
              WHERE settled_at IS NOT NULL AND captured_at >= $2
                AND actual_outcome IN ('home','draw','away')
           ), book_close AS (
             SELECT DISTINCT ON (m.fixture_id, m.bookmaker_key)
                    m.fixture_id, m.implied_home_prob h, m.implied_draw_prob d, m.implied_away_prob aw
               FROM market_odds_snapshots m
               JOIN audited x ON x.fixture_id = m.fixture_id
              WHERE m.observed_at < x.kickoff_at
              ORDER BY m.fixture_id, m.bookmaker_key, m.observed_at DESC
           ), book_open AS (
             SELECT DISTINCT ON (m.fixture_id, m.bookmaker_key)
                    m.fixture_id, m.implied_home_prob h, m.implied_draw_prob d, m.implied_away_prob aw
               FROM market_odds_snapshots m
               JOIN audited x ON x.fixture_id = m.fixture_id
              WHERE m.observed_at < x.kickoff_at
              ORDER BY m.fixture_id, m.bookmaker_key, m.observed_at ASC
           ), closing AS (
             SELECT fixture_id, AVG(h) h, AVG(d) d, AVG(aw) aw FROM book_close GROUP BY fixture_id
           ), opening AS (
             SELECT fixture_id, AVG(h) h, AVG(d) d, AVG(aw) aw FROM book_open GROUP BY fixture_id
           )
           SELECT COUNT(*)::int samples,
                  AVG((ABS(c.h-o.h)+ABS(c.d-o.d)+ABS(c.aw-o.aw))/3.0) avg_market_movement,
                  AVG((ABS(x.home_win_prob-c.h)+ABS(x.draw_prob-c.d)+ABS(x.away_win_prob-c.aw))/3.0) avg_model_market_gap,
                  AVG(x.correct::int) model_accuracy,
                  AVG(x.brier_score) model_brier,
                  AVG(POWER(c.h/100.0 - CASE WHEN x.actual_outcome='home' THEN 1 ELSE 0 END, 2)
                    + POWER(c.d/100.0 - CASE WHEN x.actual_outcome='draw' THEN 1 ELSE 0 END, 2)
                    + POWER(c.aw/100.0 - CASE WHEN x.actual_outcome='away' THEN 1 ELSE 0 END, 2)) market_brier,
                  AVG(CASE WHEN (CASE WHEN c.h >= c.d AND c.h >= c.aw THEN 'home'
                                      WHEN c.aw >= c.d THEN 'away' ELSE 'draw' END) = x.actual_outcome
                           THEN 1 ELSE 0 END) market_accuracy
             FROM audited x
             JOIN closing c ON c.fixture_id = x.fixture_id
             JOIN opening o ON o.fixture_id = x.fixture_id`),
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
  const lineupMetrics = metricRows(lineup.rows);
  const manchesterMetrics = metricRows(manchester.rows);
  const evidenceSummary = (
    rows: ReturnType<typeof metricRows>,
    treatmentName: string,
    baselineName: string,
    minimumSamples: number,
  ) => {
    const treatment = rows.find((row) => row.group_name === treatmentName);
    const baseline = rows.find((row) => row.group_name === baselineName);
    const enough = (treatment?.samples ?? 0) >= minimumSamples && (baseline?.samples ?? 0) >= minimumSamples;
    const brierDelta = treatment?.brierScore != null && baseline?.brierScore != null
      ? n(baseline.brierScore - treatment.brierScore)
      : null;
    return {
      status: !enough ? "collecting" : (brierDelta ?? 0) >= 0.002 ? "observed-improvement" : "no-proven-improvement",
      minimumSamples,
      treatmentSamples: treatment?.samples ?? 0,
      baselineSamples: baseline?.samples ?? 0,
      brierImprovement: brierDelta,
      adaptivePromotionAllowed: false,
      reason: "Diagnostic observation only; adaptive promotion requires chronological point-in-time replay and holdout improvement.",
    };
  };
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
    inPlayByCheckpoint: metricRows(inPlayByCheckpoint.rows),
    scope: {
      prematch: "byLeague, byCompetitionType, byPickSide, byDataQuality, byLineupState, manchesterRule, dailyTrend and marketBenchmark use one integrity-verified pre-kickoff prediction per fixture.",
      inPlay: "inPlayByCheckpoint and the 'live' row of byPhase contain in-play checkpoints only and are never mixed into pre-match figures.",
    },
    byLineupState: lineupMetrics,
    manchesterRule: manchesterMetrics,
    featureEvidence: {
      confirmedLineups: evidenceSummary(lineupMetrics, "confirmed-lineups", "lineups-not-confirmed", 100),
      manchesterRule: evidenceSummary(manchesterMetrics, "manchester-rule-tagged", "not-tagged", 100),
    },
    dailyTrend: metricRows(recentDays.rows).map((row) => ({ ...row, day: row.day })),
    lifecycleWarnings: Array.from(warnings.entries()).map(([reason, samples]) => ({ reason, samples })).sort((a,b) => b.samples-a.samples),
    marketBenchmark: {
      // Served pre-match predictions include stored odds since 26 Oct 2026; this
      // compares the served (sealed) prediction with the closing market.
      policy: "served-prediction-vs-closing-market",
      corePredictionUsesBookmakerOdds: true,
      samples: Number(marketRow.samples ?? 0),
      averageMarketMovementPctPoints: n(marketRow.avg_market_movement),
      averageModelMarketGapPctPoints: n(marketRow.avg_model_market_gap),
      closing: "each bookmaker's last no-vig price before kickoff, averaged across bookmakers",
      modelAccuracy: n(marketRow.model_accuracy),
      marketAccuracy: n(marketRow.market_accuracy),
      modelBrierScore: n(marketRow.model_brier),
      marketBrierScore: n(marketRow.market_brier),
      // Positive = the model beat the closing market on the same fixtures.
      brierEdgeVsMarket: marketRow.model_brier == null || marketRow.market_brier == null
        ? null
        : n(Number(marketRow.market_brier) - Number(marketRow.model_brier)),
    },
    learningSafety: {
      minimumPromotionSamples: 500,
      minimumResidualSamples: 100,
      principle: "Promote only after chronological holdout improvement; bookmaker prices are excluded from model training and model trials (they are blended into the served pre-match numbers afterwards).",
    },
  };
}
