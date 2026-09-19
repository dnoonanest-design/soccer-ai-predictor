import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL must be set before running migrations");
}

const here = path.dirname(fileURLToPath(import.meta.url));
const dbDir = path.resolve(here, "..");
const migrationFiles = [
  "001_prediction_platform.sql",
  "002_market_intelligence.sql",
  "003_prediction_accuracy_audit.sql",
  "004_full_match_lifecycle_reliability.sql",
  "005_lifecycle_reliability_enrolment_guard.sql",
  "006_fast_daily_prediction_indexes.sql",
  "007_tamper_evident_prediction_audit.sql",
  "008_one_time_prediction_audit_seal.sql",
  "009_prediction_audit_v3_seal.sql",
  "010_archive_terminal_lifecycle_failures.sql",
  "011_learning_evidence_guards.sql",
  "012_player_intelligence.sql",
  "013_reject_late_prematch_audits.sql",
  "014_freeze_prematch_predictions.sql",
  "015_use_wall_clock_for_prematch_freeze.sql",
  "016_deactivate_unvalidated_ai_models.sql",
];

function checksum(sql) {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

const pool = new Pool({ connectionString: databaseUrl });
try {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename TEXT PRIMARY KEY,
    checksum TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  for (const file of migrationFiles) {
    const sql = await readFile(path.join(dbDir, file), "utf8");
    const digest = checksum(sql);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query(
        "SELECT checksum FROM schema_migrations WHERE filename = $1 FOR UPDATE",
        [file],
      );

      if ((existing.rowCount ?? 0) > 0) {
        const recorded = String(existing.rows[0].checksum);
        if (recorded !== digest) {
          throw new Error(`Migration checksum mismatch for ${file}; historical migrations must not be edited`);
        }
        await client.query("COMMIT");
        console.log(`Verified ${file}`);
        continue;
      }

      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)",
        [file, digest],
      );
      await client.query("COMMIT");
      console.log(`Applied ${file}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
} finally {
  await pool.end();
}
