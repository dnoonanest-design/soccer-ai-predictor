import { pool } from "@workspace/db";

function round4(value: number | null) {
  return value == null || !Number.isFinite(value) ? null : Math.round(value * 10_000) / 10_000;
}

function validDateKey(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function parseTierMetadata(dataTier: unknown) {
  const value = String(dataTier ?? "");
  const quality = value.match(/(?:^|;)quality=([0-9.]+)/)?.[1];
  const reliability = value.match(/(?:^|;)reliability=([^;]+)/)?.[1] ?? null;
  const mode = value.match(/(?:^|;)mode=([^;]+)/)?.[1] ?? null;
  const homeSource = value.match(/(?:^|;)home_source=([^;]+)/)?.[1] ?? null;
  const awaySource = value.match(/(?:^|;)away_source=([^;]+)/)?.[1] ?? null;
  return {
    quality: quality == null ? null : Number(quality),
    reliability,
    mode,
    homeSource,
    awaySource,
  };
}

function groupMetrics(rows: any[], keyFn: (row: any) => string) {
  const groups = new Map<string, any[]>();
  for (const row of rows) {
    const key = keyFn(row);
    const bucket = groups.get(key) ?? [];
    bucket.push(row);
    groups.set(key, bucket);
  }
  return Array.from(groups.entries())
    .map(([key, bucket]) => {
      const settled = bucket.filter((row) => row.settled_at != null);
      const correct = settled.filter((row) => row.correct === true).length;
      const brierValues = settled.map((row) => Number(row.brier_score)).filter(Number.isFinite);
      const logValues = settled.map((row) => Number(row.log_loss)).filter(Number.isFinite);
      const confidenceValues = settled.map((row) => Number(row.pick_confidence)).filter(Number.isFinite);
      const qualityValues = settled
        .map((row) => parseTierMetadata(row.data_tier).quality)
        .filter((value): value is number => value != null && Number.isFinite(value));
      return {
        key,
        samples: settled.length,
        accuracy: settled.length ? round4(correct / settled.length) : null,
        brierScore: brierValues.length ? round4(brierValues.reduce((a, b) => a + b, 0) / brierValues.length) : null,
        logLoss: logValues.length ? round4(logValues.reduce((a, b) => a + b, 0) / logValues.length) : null,
        averagePickConfidence: confidenceValues.length ? round4(confidenceValues.reduce((a, b) => a + b, 0) / confidenceValues.length) : null,
        averageDataQuality: qualityValues.length ? round4(qualityValues.reduce((a, b) => a + b, 0) / qualityValues.length) : null,
      };
    })
    .sort((a, b) => b.samples - a.samples);
}

export async function getDailyPredictionScorecard(dateKey?: string) {
  const date = dateKey ?? new Date().toISOString().slice(0, 10);
  if (!validDateKey(date)) throw new Error("Date must be YYYY-MM-DD");
  const start = new Date(`${date}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 24 * 60 * 60_000);

  // One pre-match prediction per fixture: use the latest captured checkpoint so
  // a match is not counted four times merely because 24h/6h/90m/15m were saved.
  const result = await pool.query(
    `WITH latest AS (
       SELECT DISTINCT ON (fixture_id)
         fixture_id, league_id, home_team, away_team, kickoff_at,
         checkpoint, data_tier, model_version, engine_revision,
         home_win_prob, draw_prob, away_win_prob, predicted_outcome,
         pick_confidence, confidence_band, actual_outcome, correct,
         brier_score, log_loss, score_home, score_away, settled_at, captured_at
       FROM prediction_audit_records
       WHERE phase = 'prematch'
         AND kickoff_at >= $1 AND kickoff_at < $2
       ORDER BY fixture_id, captured_at DESC
     )
     SELECT * FROM latest ORDER BY kickoff_at, fixture_id`,
    [start, end],
  );

  const rows = result.rows;
  const settled = rows.filter((row) => row.settled_at != null);
  const correct = settled.filter((row) => row.correct === true).length;
  const brier = settled.map((row) => Number(row.brier_score)).filter(Number.isFinite);
  const logLoss = settled.map((row) => Number(row.log_loss)).filter(Number.isFinite);
  const confidence = settled.map((row) => Number(row.pick_confidence)).filter(Number.isFinite);
  const qualities = settled
    .map((row) => parseTierMetadata(row.data_tier).quality)
    .filter((value): value is number => value != null && Number.isFinite(value));

  const modeBreakdown = groupMetrics(settled, (row) => parseTierMetadata(row.data_tier).mode ?? "legacy/unknown");
  const sourceBreakdown = groupMetrics(settled, (row) => {
    const meta = parseTierMetadata(row.data_tier);
    return `${meta.homeSource ?? "unknown"}/${meta.awaySource ?? "unknown"}`;
  });

  return {
    date,
    generatedAt: new Date().toISOString(),
    fixtures: rows.length,
    settled: settled.length,
    pending: rows.length - settled.length,
    metrics: {
      correctPicks: correct,
      accuracy: settled.length ? round4(correct / settled.length) : null,
      brierScore: brier.length ? round4(brier.reduce((a, b) => a + b, 0) / brier.length) : null,
      logLoss: logLoss.length ? round4(logLoss.reduce((a, b) => a + b, 0) / logLoss.length) : null,
      averagePickConfidence: confidence.length ? round4(confidence.reduce((a, b) => a + b, 0) / confidence.length) : null,
      averageDataQuality: qualities.length ? round4(qualities.reduce((a, b) => a + b, 0) / qualities.length) : null,
    },
    byLeague: groupMetrics(settled, (row) => String(row.league_id ?? "unknown")),
    byCheckpoint: groupMetrics(settled, (row) => String(row.checkpoint ?? "unknown")),
    byConfidenceBand: groupMetrics(settled, (row) => String(row.confidence_band ?? "unknown")),
    byPredictionMode: modeBreakdown,
    byDataSource: sourceBreakdown,
    learningGuard: {
      minimumSettledSamplesForAutomaticCalibration: 250,
      canPromoteFromThisDayAlone: false,
      note: "Daily results are evidence for the learner, not permission to rewrite the model from a small sample.",
    },
    recent: rows.map((row) => ({
      fixtureId: Number(row.fixture_id),
      leagueId: row.league_id == null ? null : Number(row.league_id),
      homeTeam: String(row.home_team),
      awayTeam: String(row.away_team),
      kickoff: row.kickoff_at ? new Date(row.kickoff_at).toISOString() : null,
      checkpoint: row.checkpoint,
      predictedOutcome: row.predicted_outcome,
      actualOutcome: row.actual_outcome,
      correct: row.correct,
      pickConfidence: row.pick_confidence == null ? null : Number(row.pick_confidence),
      confidenceBand: row.confidence_band,
      dataTier: row.data_tier,
      dataQuality: parseTierMetadata(row.data_tier),
      brierScore: row.brier_score == null ? null : Number(row.brier_score),
      logLoss: row.log_loss == null ? null : Number(row.log_loss),
      scoreHome: row.score_home == null ? null : Number(row.score_home),
      scoreAway: row.score_away == null ? null : Number(row.score_away),
    })),
  };
}
