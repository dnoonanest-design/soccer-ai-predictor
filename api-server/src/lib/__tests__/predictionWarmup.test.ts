import { describe, expect, it } from "vitest";
import { PredictionWarmupError } from "../canonicalPredictionService";

describe("PredictionWarmupError", () => {
  it("exposes a safe structured learning-progress state", () => {
    const error = new PredictionWarmupError(123, 87, 250);

    expect(error).toMatchObject({
      name: "PredictionWarmupError",
      code: "PREDICTION_HISTORY_WARMUP",
      fixtureId: 123,
      currentSamples: 87,
      requiredSamples: 250,
    });
    expect(error.message).toBe("prediction history warm-up: 87/250 settled matches");
  });
});
