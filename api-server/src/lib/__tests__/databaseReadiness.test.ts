import { describe, expect, it } from "vitest";
import {
  getDatabaseReadiness,
  REQUIRED_PLAYER_INTELLIGENCE_MIGRATION,
} from "../databaseReadinessService";

describe("database readiness", () => {
  it("requires the recorded player migration and all player tables", async () => {
    const result = await getDatabaseReadiness(async (_sql, values) => {
      expect(values).toEqual([REQUIRED_PLAYER_INTELLIGENCE_MIGRATION]);
      return {
        rows: [{
          migration_applied: true,
          player_profiles_present: true,
          player_match_stats_present: true,
          player_ai_signals_present: true,
        }],
      };
    });

    expect(result).toMatchObject({
      ready: true,
      connected: true,
      migrationApplied: true,
      playerTablesPresent: true,
    });
  });

  it("is degraded when the migration record or a required table is missing", async () => {
    const result = await getDatabaseReadiness(async () => ({
      rows: [{
        migration_applied: false,
        player_profiles_present: true,
        player_match_stats_present: false,
        player_ai_signals_present: true,
      }],
    }));

    expect(result.ready).toBe(false);
    expect(result.connected).toBe(true);
    expect(result.migrationApplied).toBe(false);
    expect(result.playerTablesPresent).toBe(false);
  });

  it("fails closed without exposing database error details", async () => {
    const result = await getDatabaseReadiness(async () => {
      throw new Error("postgresql://secret@host/database");
    });

    expect(result).toEqual({
      ready: false,
      connected: false,
      requiredMigration: REQUIRED_PLAYER_INTELLIGENCE_MIGRATION,
      migrationApplied: false,
      playerTablesPresent: false,
    });
  });
});
