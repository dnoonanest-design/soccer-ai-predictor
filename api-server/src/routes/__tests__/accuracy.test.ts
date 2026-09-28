import { describe, expect, it } from "vitest";
import { auditIntegrityStatus, BALANCED_RECENT_LEDGER_SQL } from "../accuracy";

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
    expect(BALANCED_RECENT_LEDGER_SQL).toContain("voided_at IS NULL");
  });

  it("labels integrity per record even when another record failed globally", () => {
    const validIds = new Set([22]);
    expect(auditIntegrityStatus({ id: 22, signature_version: "hmac-sha256-v3", audit_signature: "ok" }, validIds)).toBe("verified");
    expect(auditIntegrityStatus({ id: 23, signature_version: "hmac-sha256-v3", audit_signature: "bad" }, validIds)).toBe("invalid");
    expect(auditIntegrityStatus({ id: 24, signature_version: null, audit_signature: null }, validIds)).toBe("legacy-unsigned");
  });
});
