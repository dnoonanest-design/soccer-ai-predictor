import { Router, type IRouter } from "express";

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

router.post("/push/subscribe", (req, res) => {
  const subscription = req.body as PushSubscriptionRecord | undefined;
  if (!subscription?.endpoint) {
    res.status(400).json({ error: "Push subscription endpoint is required" });
    return;
  }
  subscriptions.set(subscription.endpoint, { ...subscription, createdAt: new Date().toISOString() });
  res.json({ ok: true, saved: true, subscriptions: subscriptions.size });
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
