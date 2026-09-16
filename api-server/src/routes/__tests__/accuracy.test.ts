import { describe, expect, it } from "vitest";
import { BALANCED_RECENT_LEDGER_SQL } from "../accuracy";

describe("performance ledger prediction boundary", () => {
  it("selects only the final genuine pre-kickoff prediction for each fixture", () => {
    expect(BALANCED_RECENT_LEDGER_SQL).toMatch(/phase = 'prematch'/);
    expect(BALANCED_RECENT_LEDGER_SQL).toMatch(/captured_at < kickoff_at/);
    expect(BALANCED_RECENT_LEDGER_SQL).toMatch(
      /PARTITION BY fixture_id[\s\S]*ORDER BY captured_at DESC, id DESC/,
    );
  });

  it("does not let a settled live checkpoint hide a pending pre-match record", () => {
    expect(BALANCED_RECENT_LEDGER_SQL).toMatch(
      /settled\.phase = 'prematch'[\s\S]*settled\.captured_at < settled\.kickoff_at/,
    );
  });
});
