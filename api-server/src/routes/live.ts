import { Router } from "express";
import { getAllMatches } from "../lib/soccerService";
import { liveFingerprint, livePredictionState } from "../lib/liveFeed";
import { logger } from "../lib/logger";

const router = Router();
const CHECK_MS = 5_000;
const HEARTBEAT_MS = 25_000;
let open = 0;

/** Server-Sent Events: one "live" event whenever a live score, minute, status or live prediction changes. */
router.get("/live/stream", (req, res) => {
  if (open >= 500) {
    res.status(503).json({ error: "Too many live connections; the app keeps polling instead" });
    return;
  }
  open++;
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
  res.write("retry: 10000\n\n");
  let last = "";
  let closed = false;
  const check = async () => {
    try {
      const live = (await getAllMatches(null, "live")).map((m) => ({ id: m.id, status: m.status, minute: m.minute ?? null, home: m.score?.home ?? null, away: m.score?.away ?? null }));
      const pred = livePredictionState();
      const fp = liveFingerprint(live, pred.version);
      if (!closed && fp !== last) {
        last = fp;
        res.write(`event: live\ndata: ${JSON.stringify({ at: Date.now(), live: live.length, ids: live.map((m) => m.id), prediction_at: pred.at || null })}\n\n`);
      }
    } catch (err) {
      logger.debug({ err }, "live stream check failed");
    }
  };
  void check();
  const timer = setInterval(check, CHECK_MS);
  const beat = setInterval(() => { if (!closed) res.write(": ping\n\n"); }, HEARTBEAT_MS);
  req.on("close", () => { closed = true; open--; clearInterval(timer); clearInterval(beat); });
});

export default router;
