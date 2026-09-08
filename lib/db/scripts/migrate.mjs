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
];

const pool = new Pool({ connectionString: databaseUrl });
try {
  for (const file of migrationFiles) {
    const sql = await readFile(path.join(dbDir, file), "utf8");
    await pool.query(sql);
    console.log(`Applied ${file}`);
  }
} finally {
  await pool.end();
}
