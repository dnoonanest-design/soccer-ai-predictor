import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { pushSubscriptions } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { pushRateLimit, isSafeUrl, safeString, requireAdminKey } from "../lib/security";
import { logger } from "../lib/logger";

const router: IRouter = Router();
const MAX_SUBSCRIPTIONS = 5000; // DB-backed so higher limit is fine

router.get("/push/config", (_req, res) => {
  res.json({
    enabled: Boolean(process.env.VAPID_PUBLIC_KEY),
    vapidPublicKey: process.env.VAPID_PUBLIC_KEY ?? null,
    note: "Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY before sending production push notifications.",
  });
});

router.post("/push/subscribe", pushRateLimit, async (req, res) => {
  const subscription = req.body as { endpoint?: unknown; keys?: Record<string, string> } | undefined;

  if (!subscription?.endpoint || !isSafeUrl(subscription.endpoint)) {
    res.status(400).json({ error: "A valid https push subscription endpoint is required" });
    return;
  }

  const endpoint = safeString(subscription.endpoint, 512);

  const rawKeys = subscription.keys ?? {};
  const sanitisedKeys: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawKeys)) {
    const safeKey = safeString(k, 32).replace(/[^a-zA-Z0-9_-]/g, "");
    const safeVal = safeString(v, 512).replace(/[^a-zA-Z0-9+/=_-]/g, "");
    if (safeKey && safeVal) sanitisedKeys[safeKey] = safeVal;
  }

  try {
    // Check capacity before inserting
    const countResult = await db.execute(
      sql`SELECT COUNT(*)::int AS n FROM push_subscriptions`
    ) as any;
    const count = Number((countResult.rows ?? countResult)[0]?.n ?? 0);

    // Check if this endpoint already exists (update is fine)
    const existing = await db.select({ id: pushSubscriptions.id })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.endpoint, endpoint))
      .limit(1);

    if (count >= MAX_SUBSCRIPTIONS && existing.length === 0) {
      res.status(503).json({ error: "Push subscription capacity reached. Please try again later." });
      return;
    }

    await db.insert(pushSubscriptions)
      .values({
        endpoint,
        keysJson: Object.keys(sanitisedKeys).length > 0 ? JSON.stringify(sanitisedKeys) : null,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: {
          keysJson: Object.keys(sanitisedKeys).length > 0 ? JSON.stringify(sanitisedKeys) : null,
          updatedAt: new Date(),
        },
      });

    res.json({ ok: true, saved: true });
  } catch (err) {
    logger.error({ err }, "push subscribe failed");
    res.status(500).json({ error: "Failed to save push subscription" });
  }
});

router.post("/push/test", requireAdminKey, (req, res) => {
  const message = safeString(req.body?.message ?? "Test notification", 256);
  res.json({ ok: true, queued: false, message });
});

export default router;
