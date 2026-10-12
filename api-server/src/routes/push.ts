import { Router, type IRouter } from "express";
import { isSafeUrl } from "../lib/security";

type PushSubscriptionRecord = {
  endpoint: string;
  keys?: Record<string, string>;
  createdAt: string;
};

const router: IRouter = Router();
const subscriptions = new Map<string, PushSubscriptionRecord>();

router.get("/push/config", (_req, res) => {
  res.json({
    enabled: Boolean(process.env.VAPID_PUBLIC_KEY),
    vapidPublicKey: process.env.VAPID_PUBLIC_KEY ?? null,
    note: "Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY before sending production push notifications.",
  });
});

// Subscriptions are held in memory until web-push delivery is built, so cap
// the store and accept only well-formed browser push endpoints.
const MAX_SUBSCRIPTIONS = 2000;
const MAX_ENDPOINT_LENGTH = 1024;
const MAX_KEY_LENGTH = 256;

router.post("/push/subscribe", (req, res) => {
  const body = req.body as Partial<PushSubscriptionRecord> | undefined;
  const endpoint = typeof body?.endpoint === "string" ? body.endpoint : "";
  if (!endpoint || endpoint.length > MAX_ENDPOINT_LENGTH || !isSafeUrl(endpoint)) {
    res.status(400).json({ error: "A valid https push subscription endpoint is required" });
    return;
  }
  const keys: Record<string, string> = {};
  for (const name of ["p256dh", "auth"]) {
    const value = body?.keys?.[name];
    if (typeof value === "string" && value.length <= MAX_KEY_LENGTH) keys[name] = value;
  }
  if (!subscriptions.has(endpoint) && subscriptions.size >= MAX_SUBSCRIPTIONS) {
    // Drop the oldest subscription (Map keeps insertion order).
    const oldest = subscriptions.keys().next().value;
    if (oldest !== undefined) subscriptions.delete(oldest);
  }
  subscriptions.delete(endpoint);
  subscriptions.set(endpoint, { endpoint, keys, createdAt: new Date().toISOString() });
  res.json({ ok: true, saved: true });
});

router.post("/push/test", (req, res) => {
  // This endpoint intentionally does not send notifications until the web-push package and VAPID keys are configured.
  res.json({
    ok: true,
    queued: false,
    message: req.body?.message ?? "Test notification accepted. Configure web-push to deliver it.",
    subscriptions: subscriptions.size,
  });
});

export default router;
