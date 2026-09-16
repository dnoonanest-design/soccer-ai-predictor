import pg from "pg";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: databaseUrl });
const client = await pool.connect();
const fixtureId = -2_146_000_001;

async function expectRejected(savepoint, statement, messageFragment) {
  await client.query(`SAVEPOINT ${savepoint}`);
  try {
    await client.query(statement);
  } catch (error) {
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    if (!String(error.message).includes(messageFragment)) throw error;
    return;
  }
  throw new Error(`Expected database boundary rejection: ${messageFragment}`);
}

try {
  await client.query("BEGIN");

  await client.query(`
    INSERT INTO match_predictions (
      fixture_id, home_team, away_team, league_id,
      home_win_prob, draw_prob, away_win_prob, is_live, kickoff_at, updated_at
    ) VALUES (
      ${fixtureId}, 'Boundary Home', 'Boundary Away', 39,
      45, 30, 25, FALSE, clock_timestamp() + INTERVAL '1 second', clock_timestamp()
    )
  `);
  await client.query(`
    UPDATE match_predictions SET home_win_prob = 46, draw_prob = 29
     WHERE fixture_id = ${fixtureId} AND is_live = FALSE
  `);
  await client.query("SELECT pg_sleep(1.1)");
  await expectRejected(
    "freeze_after_kickoff",
    `UPDATE match_predictions SET home_win_prob = 99
      WHERE fixture_id = ${fixtureId} AND is_live = FALSE`,
    "prematch prediction is frozen at kickoff",
  );

  await expectRejected(
    "reject_late_audit",
    `INSERT INTO prediction_audit_records (
      fixture_id, league_id, home_team, away_team, kickoff_at, phase,
      checkpoint, data_tier, model_version, engine_revision,
      home_win_prob, draw_prob, away_win_prob, pick_confidence,
      confidence_band, predicted_outcome, captured_at
    ) VALUES (
      ${fixtureId - 1}, 39, 'Late Home', 'Late Away',
      clock_timestamp() - INTERVAL '1 minute', 'prematch', 'acceptance_late',
      'stats', 'acceptance-v1', 'ci', 45, 30, 25, 45, '40-49%', 'home',
      clock_timestamp()
    )`,
    "prematch audit must be captured before kickoff",
  );

  const triggerResult = await client.query(`
    SELECT COUNT(*)::int AS count
      FROM pg_trigger
     WHERE tgname IN (
       'trg_reject_late_prematch_audit',
       'trg_freeze_started_prematch_prediction',
       'trg_reject_started_prematch_prediction_insert',
       'trg_protect_prediction_audit_record'
     ) AND NOT tgisinternal
  `);
  if (Number(triggerResult.rows[0]?.count) !== 4) {
    throw new Error("Prediction boundary trigger set is incomplete");
  }

  await client.query("ROLLBACK");
  console.log("Prediction boundary acceptance checks passed");
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  client.release();
  await pool.end();
}
