import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useGetMatches, getGetMatchesQueryKey } from "@workspace/api-client-react";
import type { Match } from "@workspace/api-client-react";
import { Activity, Maximize2, Minimize2, PanelsTopLeft, Star, TimerReset, Zap } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

type Density = "comfort" | "compact";

type Momentum = {
  home_momentum_pct?: number | null;
  away_momentum_pct?: number | null;
  next_goal_home?: number | null;
  next_goal_away?: number | null;
  momentum_label?: string | null;
  pressure_alert?: string | null;
  data_quality?: string | null;
};

function clampPct(value: unknown, fallback: number) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, n));
}

function normalizeSplit(homeValue: unknown, awayValue: unknown, fallbackHome = 50) {
  const homeRaw = clampPct(homeValue, fallbackHome);
  const awayRaw = clampPct(awayValue, 100 - homeRaw);
  const total = homeRaw + awayRaw;
  if (!Number.isFinite(total) || total <= 0) return { home: 50, away: 50 };
  const home = Math.max(0, Math.min(100, (homeRaw / total) * 100));
  return { home, away: 100 - home };
}

function safeStorageGet(key: string, fallback: string) {
  try {
    return typeof window !== "undefined" ? window.localStorage.getItem(key) ?? fallback : fallback;
  } catch {
    return fallback;
  }
}

function safeStorageSet(key: string, value: string) {
  try {
    if (typeof window !== "undefined") window.localStorage.setItem(key, value);
  } catch {
    // Ignore private-mode/iPad storage failures.
  }
}

function getMomentum(match: Match): Momentum {
  const enhanced = ((match as any).enhanced ?? {}) as any;
  return (enhanced.live_momentum ?? (match as any).live_momentum ?? {}) as Momentum;
}

function MomentumBar({ match }: { match: Match }) {
  const momentum = getMomentum(match);
  const { home: homeWidth, away: awayWidth } = normalizeSplit(momentum.home_momentum_pct, momentum.away_momentum_pct);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-[10px] font-mono text-muted-foreground">
        <span>{Math.round(homeWidth)}%</span>
        <span className="uppercase tracking-widest">Momentum</span>
        <span>{Math.round(awayWidth)}%</span>
      </div>
      <div className="h-3 rounded-full overflow-hidden bg-muted flex ipad-momentum-bar" aria-label="Live match momentum percentage">
        <div className="bg-primary transition-all duration-700" style={{ width: `${homeWidth}%` }} />
        <div className="bg-chart-2 transition-all duration-700" style={{ width: `${awayWidth}%` }} />
      </div>
      {(momentum.pressure_alert || momentum.momentum_label) && (
        <div className="text-[10px] font-mono text-muted-foreground truncate">
          {momentum.pressure_alert ?? momentum.momentum_label}
        </div>
      )}
    </div>
  );
}

function ScoreLine({ match }: { match: Match }) {
  const live = match.status === "live";
  return (
    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          {match.home_team.logo ? <img src={match.home_team.logo} alt="" className="w-7 h-7 object-contain" /> : null}
          <span className="font-bold truncate">{match.home_team.name}</span>
        </div>
      </div>
      <div className="text-center">
        <div className="font-mono text-3xl font-black leading-none">
          {match.score?.home ?? "-"} : {match.score?.away ?? "-"}
        </div>
        <div className={`text-[10px] font-mono mt-1 ${live ? "text-destructive" : "text-muted-foreground"}`}>
          {live ? `${match.minute ?? "LIVE"}'` : match.status_detail}
        </div>
      </div>
      <div className="min-w-0 text-right">
        <div className="flex items-center justify-end gap-2 min-w-0">
          <span className="font-bold truncate">{match.away_team.name}</span>
          {match.away_team.logo ? <img src={match.away_team.logo} alt="" className="w-7 h-7 object-contain" /> : null}
        </div>
      </div>
    </div>
  );
}

function IpadMatchTile({ match, selected, density, onSelect }: {
  match: Match;
  selected: boolean;
  density: Density;
  onSelect: () => void;
}) {
  const momentum = getMomentum(match);
  const { home: homeNext, away: awayNext } = normalizeSplit(momentum.next_goal_home, momentum.next_goal_away);

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full text-left rounded-xl border transition-all ipad-card-tap ${selected ? "border-primary bg-primary/10" : "border-border/60 bg-card hover:bg-muted/40"}`}
      data-testid={`ipad-match-tile-${match.id}`}
    >
      <div className={density === "compact" ? "p-3 space-y-2" : "p-4 space-y-3"}>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            {match.status === "live" && <span className="w-2 h-2 rounded-full bg-destructive pulse-dot" />}
            <span className="text-[10px] font-mono text-muted-foreground truncate uppercase tracking-wider">{match.league_name}</span>
          </div>
          <span className="text-[10px] font-mono text-muted-foreground shrink-0">{match.minute ? `${match.minute}'` : match.status_detail}</span>
        </div>
        <ScoreLine match={match} />
        <MomentumBar match={match} />
        <div className="grid grid-cols-2 gap-2 text-[10px] font-mono text-muted-foreground">
          <div className="rounded-md bg-background/45 px-2 py-1">Next H: <span className="text-primary font-black">{Math.round(homeNext)}%</span></div>
          <div className="rounded-md bg-background/45 px-2 py-1 text-right">A: <span className="text-chart-2 font-black">{Math.round(awayNext)}%</span></div>
        </div>
      </div>
    </button>
  );
}

function SelectedMatchPanel({ match }: { match?: Match }) {
  if (!match) {
    return (
      <Card className="h-full min-h-[420px] flex items-center justify-center text-center text-muted-foreground border-dashed">
        <div className="space-y-3 px-8">
          <PanelsTopLeft className="w-10 h-10 mx-auto opacity-40" />
          <p className="font-mono text-sm">Tap a live match to open the iPad side panel.</p>
          <p className="text-xs">This layout is designed for landscape use while watching multiple games.</p>
        </div>
      </Card>
    );
  }

  const momentum = getMomentum(match);
  const enhanced = ((match as any).enhanced ?? {}) as any;

  return (
    <Card className="h-full border-primary/25 bg-card/95 overflow-hidden ipad-sticky-panel" data-testid="ipad-selected-match-panel">
      <div className="p-5 space-y-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest">Focus Match</div>
            <h2 className="text-xl font-black tracking-tight">{match.home_team.name} v {match.away_team.name}</h2>
          </div>
          <Link href={`/matches/${match.id}`} className="ipad-action-button rounded-lg bg-primary text-primary-foreground px-4 py-2 text-sm font-bold">
            Open full detail
          </Link>
        </div>

        <ScoreLine match={match} />
        <MomentumBar match={match} />

        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-xl border border-border/60 bg-background/40 p-4">
            <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest">Next goal home</div>
            <div className="text-3xl font-mono font-black text-primary">{Math.round(normalizeSplit(momentum.next_goal_home, momentum.next_goal_away).home)}%</div>
          </div>
          <div className="rounded-xl border border-border/60 bg-background/40 p-4 text-right">
            <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest">Next goal away</div>
            <div className="text-3xl font-mono font-black text-chart-2">{Math.round(normalizeSplit(momentum.next_goal_home, momentum.next_goal_away).away)}%</div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="rounded-xl border border-border/60 bg-background/40 p-3">
            <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest">Prediction</div>
            <div className="font-mono mt-1">H {Math.round(Number(enhanced.home_win ?? match.odds?.home_win ?? 0))}% · D {Math.round(Number(enhanced.draw ?? match.odds?.draw ?? 0))}% · A {Math.round(Number(enhanced.away_win ?? match.odds?.away_win ?? 0))}%</div>
          </div>
          <div className="rounded-xl border border-border/60 bg-background/40 p-3">
            <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest">Feed</div>
            <div className="font-mono mt-1">{momentum.data_quality === "enhanced" ? "Enhanced live stats" : "Basic live stats"}</div>
          </div>
        </div>

        <div className="rounded-xl border border-yellow-400/20 bg-yellow-400/10 p-4 text-yellow-200">
          <div className="flex items-center gap-2 font-bold text-sm"><Zap className="w-4 h-4" /> iPad alert panel</div>
          <p className="text-xs mt-1 text-yellow-100/80">{momentum.pressure_alert ?? momentum.momentum_label ?? "No major pressure spike detected yet."}</p>
        </div>
      </div>
    </Card>
  );
}

export default function IpadLive() {
  const [onlyLive, setOnlyLive] = useState(true);
  const [density, setDensity] = useState<Density>(() => safeStorageGet("ipad-density", "comfort") as Density);
  const [focusMode, setFocusMode] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const matchParams = useMemo(() => ({ status: onlyLive ? "live" : undefined }), [onlyLive]);

  const { data: matches, isLoading } = useGetMatches(matchParams, {
    query: {
      refetchInterval: onlyLive ? 12000 : 30000,
      staleTime: onlyLive ? 8000 : 20000,
      refetchIntervalInBackground: false,
      queryKey: getGetMatchesQueryKey(matchParams),
    },
  });

  const sortedMatches = useMemo(() => {
    const list = [...(matches ?? [])];
    return list.sort((a, b) => {
      const aLive = a.status === "live" ? 1 : 0;
      const bLive = b.status === "live" ? 1 : 0;
      if (aLive !== bLive) return bLive - aLive;
      return Number(b.minute ?? 0) - Number(a.minute ?? 0);
    });
  }, [matches]);

  const selected = sortedMatches.find((m) => m.id === selectedId) ?? sortedMatches[0];

  const saveDensity = (next: Density) => {
    setDensity(next);
    safeStorageSet("ipad-density", next);
  };

  return (
    <div className={`max-w-[1800px] mx-auto space-y-5 ${focusMode ? "ipad-focus-mode" : ""}`} data-testid="ipad-live-page">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-border/50 pb-4">
        <div>
          <div className="flex items-center gap-2 text-primary font-mono text-xs uppercase tracking-widest"><Activity className="w-4 h-4" /> iPad Match Desk</div>
          <h1 className="text-3xl font-black tracking-tight mt-1">Live split-screen dashboard</h1>
          <p className="text-sm text-muted-foreground mt-1">Designed for iPad landscape: tap matches on the left, monitor the selected match on the right.</p>
        </div>
        <div className="flex flex-wrap gap-2 ipad-toolbar">
          <button className={`ipad-action-button ${onlyLive ? "is-active" : ""}`} onClick={() => setOnlyLive(!onlyLive)}>
            <Activity className="w-4 h-4" /> {onlyLive ? "Live only" : "All matches"}
          </button>
          <button className="ipad-action-button" onClick={() => saveDensity(density === "comfort" ? "compact" : "comfort")}>
            <TimerReset className="w-4 h-4" /> {density === "comfort" ? "Compact" : "Comfort"}
          </button>
          <button className={`ipad-action-button ${focusMode ? "is-active" : ""}`} onClick={() => setFocusMode(!focusMode)}>
            {focusMode ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />} Focus
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.25fr)_minmax(420px,0.75fr)] gap-5 ipad-split-view">
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <Card className="p-4"><div className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest">Shown</div><div className="text-2xl font-mono font-black">{sortedMatches.length}</div></Card>
            <Card className="p-4"><div className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest">Live</div><div className="text-2xl font-mono font-black text-destructive">{sortedMatches.filter(m => m.status === "live").length}</div></Card>
            <Card className="p-4"><div className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest">Refresh</div><div className="text-2xl font-mono font-black">{onlyLive ? "12s" : "30s"}</div></Card>
          </div>

          {isLoading ? (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-48 rounded-xl" />)}
            </div>
          ) : sortedMatches.length === 0 ? (
            <Card className="min-h-[340px] flex items-center justify-center text-muted-foreground border-dashed">
              <div className="text-center space-y-2"><Star className="w-9 h-9 mx-auto opacity-40" /><p>No matches available for this filter.</p></div>
            </Card>
          ) : (
            <div className={`grid grid-cols-1 lg:grid-cols-2 gap-3 touch-scroll ipad-match-grid ${density === "compact" ? "is-compact" : ""}`}>
              {sortedMatches.map((match) => (
                <IpadMatchTile key={match.id} match={match} selected={selected?.id === match.id} density={density} onSelect={() => setSelectedId(match.id)} />
              ))}
            </div>
          )}
        </div>

        <SelectedMatchPanel match={selected} />
      </div>
    </div>
  );
}
