import { useEffect, useMemo, useState } from "react";
import { Download, Bell, X } from "lucide-react";
import { Button } from "@/components/ui/button";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

const isIos = () => /iphone|ipad|ipod/i.test(window.navigator.userAgent);
const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches || (window.navigator as any).standalone === true;

export function PwaInstallPrompt() {
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState(() => localStorage.getItem("pwa-install-dismissed") === "1");
  const [pushSupported, setPushSupported] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(false);

  useEffect(() => {
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setInstallEvent(event as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    setPushSupported("Notification" in window && "serviceWorker" in navigator && "PushManager" in window);
    setPushEnabled(typeof Notification !== "undefined" && Notification.permission === "granted");
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  const showInstall = useMemo(() => !dismissed && !isStandalone() && (installEvent || isIos()), [dismissed, installEvent]);

  async function install() {
    if (installEvent) {
      await installEvent.prompt();
      await installEvent.userChoice.catch(() => undefined);
      setInstallEvent(null);
    }
  }

  function urlBase64ToUint8Array(base64String: string) {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const rawData = window.atob(base64);
    return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
  }

  async function enablePush() {
    if (!pushSupported) return;
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      setPushEnabled(false);
      return;
    }
    setPushEnabled(true);

    try {
      const registration = await navigator.serviceWorker.ready;
      const config = await fetch("/api/push/config").then((res) => res.json()).catch(() => null);
      if (!config?.enabled || !config?.vapidPublicKey) return;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(config.vapidPublicKey),
      });
      await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(subscription),
      });
    } catch (error) {
      console.warn("Push subscription failed", error);
    }
  }

  if (!showInstall && (!pushSupported || pushEnabled)) return null;

  return (
    <div className="fixed left-3 right-3 bottom-[calc(env(safe-area-inset-bottom)+0.75rem)] z-50 mx-auto max-w-3xl rounded-xl border border-border/70 bg-card/95 p-3 shadow-2xl backdrop-blur supports-[backdrop-filter]:bg-card/80 md:left-auto md:right-5 md:max-w-md ipad-touch-target" data-testid="pwa-install-prompt">
      <div className="flex items-start gap-3">
        <div className="mt-1 rounded-lg bg-primary/15 p-2 text-primary"><Download className="h-4 w-4" /></div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-bold">Use as an iPad app</div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {isIos() ? "Open in Safari, tap Share, then Add to Home Screen for a full-screen app experience." : "Install the dashboard for a full-screen app experience and faster loading."}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {installEvent && <Button size="sm" onClick={install}>Install app</Button>}
            {pushSupported && !pushEnabled && <Button size="sm" variant="secondary" onClick={enablePush}><Bell className="mr-1 h-3 w-3" />Enable alerts</Button>}
          </div>
        </div>
        <button
          aria-label="Dismiss install prompt"
          className="rounded-md p-2 text-muted-foreground hover:bg-muted"
          onClick={() => { localStorage.setItem("pwa-install-dismissed", "1"); setDismissed(true); }}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
