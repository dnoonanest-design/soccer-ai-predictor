import { Link, useLocation, useSearch } from "wouter";
import { createContext, useContext, useState } from "react";
import { useGetDashboardSummary, getGetDashboardSummaryQueryKey } from "@workspace/api-client-react";
import { format } from "date-fns";
import { Activity, Trophy, ServerCrash, BarChart2, LineChart, TabletSmartphone, Settings, CalendarDays, MoreHorizontal, Radio } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export type OddsFormat = "decimal" | "fractional";

const OddsFormatContext = createContext<OddsFormat>("decimal");

export function useOddsFormat() {
  return useContext(OddsFormatContext);
}

function getInitialOddsFormat(): OddsFormat {
  if (typeof window === "undefined") return "decimal";
  try {
    return window.localStorage.getItem("soccer-odds-format") === "fractional" ? "fractional" : "decimal";
  } catch {
    return "decimal";
  }
}

type NavItem = { href: string; label: string; icon: typeof Activity; description: string; match: (path: string, view: string | null) => boolean };

/** The app's main sections, in the order people use them. */
export const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Matches", icon: CalendarDays, description: "Today and the next 7 days", match: (p, v) => (p === "/" && v !== "live") || p.startsWith("/matches") || p.startsWith("/teams") },
  { href: "/?view=live", label: "Live", icon: Radio, description: "Matches in play now", match: (p, v) => p === "/" && v === "live" },
  { href: "/leagues", label: "Leagues", icon: Trophy, description: "Pick a competition", match: (p) => p === "/leagues" },
  { href: "/performance", label: "Accuracy", icon: LineChart, description: "How our predictions have done", match: (p) => p === "/performance" },
];

const MORE_ITEMS = [
  { href: "/backtest", label: "Backtest", icon: BarChart2, description: "Test the model on past matches" },
  { href: "/ipad", label: "iPad desk", icon: TabletSmartphone, description: "Big-screen live view" },
];

function OddsSettings({ value, onChange }: { value: OddsFormat; onChange: (v: OddsFormat) => void }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" aria-label="Settings" className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground" data-testid="button-settings">
          <Settings className="h-4 w-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-60">
        <div className="text-sm font-semibold">Odds format</div>
        <p className="mt-1 text-xs text-muted-foreground">How bookmaker prices are shown.</p>
        <div className="mt-3 grid grid-cols-2 gap-2" role="radiogroup" aria-label="Odds format">
          {(["decimal", "fractional"] as const).map((f) => (
            <button
              key={f}
              type="button"
              role="radio"
              aria-checked={value === f}
              onClick={() => onChange(f)}
              className={`rounded-md border px-3 py-2 text-sm capitalize ${value === f ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:text-foreground"}`}
            >
              {f}
              <span className="block font-mono text-[10px] text-muted-foreground">{f === "decimal" ? "2.50" : "6/4"}</span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function MoreMenu({ location, trigger }: { location: string; trigger: React.ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-1">
        {MORE_ITEMS.map((item) => (
          <Link key={item.href} href={item.href} className={`flex items-start gap-3 rounded-md px-3 py-2.5 hover:bg-muted ${location === item.href ? "text-primary" : ""}`}>
            <item.icon className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              <span className="block text-sm font-medium">{item.label}</span>
              <span className="block text-xs text-muted-foreground">{item.description}</span>
            </span>
          </Link>
        ))}
      </PopoverContent>
    </Popover>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const search = useSearch();
  const view = new URLSearchParams(search).get("view");
  const [oddsFormat, setOddsFormat] = useState<OddsFormat>(getInitialOddsFormat);
  const changeOddsFormat = (next: OddsFormat) => {
    setOddsFormat(next);
    try { window.localStorage.setItem("soccer-odds-format", next); } catch { /* private mode */ }
  };

  const { data: summary, isError } = useGetDashboardSummary({
    query: {
      refetchInterval: 15000,
      queryKey: getGetDashboardSummaryQueryKey(),
    },
  });
  const liveCount = summary?.live_count ?? 0;
  const moreActive = MORE_ITEMS.some((i) => i.href === location);

  return (
    <OddsFormatContext.Provider value={oddsFormat}>
    <div className="min-h-screen bg-background text-foreground flex flex-col font-sans dark selection:bg-primary/30">
      <header className="sticky top-0 z-50 w-full border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/70">
        <div className="mx-auto flex h-14 max-w-[1600px] items-center gap-6 px-4">
          <Link href="/" className="flex items-center gap-2 font-bold tracking-tight" data-testid="link-home">
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/15 text-primary"><Activity className="h-4 w-4" /></span>
            <span className="text-sm sm:text-base">Soccer AI Predictor</span>
          </Link>

          <nav aria-label="Main" className="hidden md:flex items-center gap-1 text-sm">
            {NAV_ITEMS.map((item) => {
              const active = item.match(location, view);
              return (
                <Link
                  key={item.label}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 transition-colors ${active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
                >
                  <item.icon className="h-4 w-4" />
                  {item.label}
                  {item.label === "Live" && liveCount > 0 && (
                    <span className="ml-0.5 rounded-full bg-destructive px-1.5 text-[10px] font-bold leading-4 text-destructive-foreground">{liveCount}</span>
                  )}
                </Link>
              );
            })}
            <MoreMenu
              location={location}
              trigger={
                <button type="button" className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 ${moreActive ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}>
                  <MoreHorizontal className="h-4 w-4" /> More
                </button>
              }
            />
          </nav>

          <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
            {isError ? (
              <span className="flex items-center gap-1 text-destructive"><ServerCrash className="h-3.5 w-3.5" />Connection problem</span>
            ) : summary?.last_updated ? (
              <span className="hidden sm:inline">Updated {format(new Date(summary.last_updated), "HH:mm")}</span>
            ) : null}
            <OddsSettings value={oddsFormat} onChange={changeOddsFormat} />
          </div>
        </div>
      </header>

      <main className="flex-1 w-full overflow-x-hidden p-4 pb-24 md:p-6 md:pb-6">
        {children}
      </main>

      {/* Phone navigation: the same sections as the top bar, within thumb reach. */}
      <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-50 grid grid-cols-5 border-t border-border bg-background/95 backdrop-blur md:hidden pb-[env(safe-area-inset-bottom)]">
        {NAV_ITEMS.map((item) => {
          const active = item.match(location, view);
          return (
            <Link key={item.label} href={item.href} aria-current={active ? "page" : undefined}
              className={`relative flex flex-col items-center gap-0.5 py-2 text-[10px] ${active ? "text-primary" : "text-muted-foreground"}`}>
              <item.icon className="h-5 w-5" />
              {item.label}
              {item.label === "Live" && liveCount > 0 && (
                <span className="absolute right-[22%] top-1 rounded-full bg-destructive px-1 text-[9px] font-bold leading-4 text-destructive-foreground">{liveCount}</span>
              )}
            </Link>
          );
        })}
        <MoreMenu
          location={location}
          trigger={
            <button type="button" className={`flex flex-col items-center gap-0.5 py-2 text-[10px] ${moreActive ? "text-primary" : "text-muted-foreground"}`}>
              <MoreHorizontal className="h-5 w-5" /> More
            </button>
          }
        />
      </nav>
    </div>
    </OddsFormatContext.Provider>
  );
}
