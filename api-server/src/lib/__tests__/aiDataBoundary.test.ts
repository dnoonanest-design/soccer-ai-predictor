import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function source(relativePath: string) {
  return readFile(new URL(relativePath, import.meta.url), "utf8");
}

describe("AI temporal data boundary", () => {
  it.each([
    ["../adaptiveLearningEngine.ts", "adaptive learner"],
    ["../aiAwareLearningService.ts", "similar-match memory"],
  ])("keeps %s on strictly pre-kickoff snapshots", async (file) => {
    const code = await source(file);
    expect(code).toContain("ps.status = 'upcoming'");
    expect(code).toContain("ps.minute IS NULL");
    expect(code).toContain("mp.kickoff_at IS NOT NULL");
    expect(code).toContain("ps.created_at < mp.kickoff_at");
    expect(code).not.toContain("mp.kickoff_at IS NULL OR ps.created_at < mp.kickoff_at");
  });

  it("keeps similar-match memory diagnostic-only", async () => {
    const code = await source("../aiAwareLearningService.ts");
    expect(code).toContain("const accepted = false");
    expect(code).toContain("similarMatchWeight: 0");
  });

  it("connects only persisted adaptive calibration to pre-match inference", async () => {
    const code = await source("../enhancedStatsService.ts");
    expect(code).toContain("const learnedWeights = await getLearnedWeights()");
    expect(code).toContain("!isLive && learnedWeights.sampleSize >= 60");
    expect(code).toContain("globalOutcomePriors");
  });
});
