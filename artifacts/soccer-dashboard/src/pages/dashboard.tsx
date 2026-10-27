import {
  useGetMatches,
  getGetMatchesQueryKey,
  useGetXg,
  getGetXgQueryKey,
  Match,
  XGPrediction,
} from "@workspace/api-client-react";
import { useState, useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useLocation, useSearch } from "wouter";
import { format } from "date-fns";
import { Trophy, Activity, Zap, SlidersHorizontal, CalendarDays, ChevronDown } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { formatOdds, findModelEdges, findModelGaps, ModelEdge, ModelGap } from "@/lib/odds";
import { useOddsFormat } from "@/components/layout/Shell";

function Tip({ children, text }: { children: React.ReactNode; text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="top" className="max-w-[200px] text-center leading-snug font-sans font-normal normal-case tracking-normal">
        {text}
      </TooltipContent>
    </Tooltip>
  );
}

function LeagueLogo({ src, name, className }: { src?: string | null; name: string; className: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return <Trophy aria-label={`${name} logo unavailable`} className={`${className} text-muted-foreground`} />;
  return <img src={src} alt={name} className={className} loading="lazy" decoding="async" onError={() => setFailed(true)} />;
}

const OUTCOME_LABELS: Record<ModelEdge["outcome"], string> = {
  HOME: "HOME",
  DRAW: "DRAW",
  AWAY: "AWAY",
};

const OUTCOME_COLORS: Record<ModelEdge["outcome"], string> = {
  HOME: "text-primary",
  DRAW: "text-yellow-400",
  AWAY: "text-chart-2",
};

function ValueBadge({ bets }: { bets: ModelEdge[] }) {
  if (bets.length === 0) return null;
  const top = bets[0];
  return (
    <div
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-mono font-black uppercase tracking-widest bg-yellow-400/10 border border-yellow-400/30 text-yellow-400"
      data-testid="badge-value-bet"
      title={`Prematch model estimates ${OUTCOME_LABELS[top.outcome]} at ${top.modelProbability.toFixed(1)}%; market implies ${top.market.toFixed(1)}%. This is a probability gap, not expected profit.`}
    >
      <Zap className="w-2.5 h-2.5" />
      {OUTCOME_LABELS[top.outcome]} +{Math.round(top.delta)} pp
    </div>
  );
}

function ProbabilityBar({ home, draw, away }: { home?: number | null; draw?: number | null; away?: number | null }) {
  if (home == null || draw == null || away == null) return null;
  return (
    <div className="w-full flex h-1.5 rounded-full overflow-hidden bg-muted mt-2">
      <div className="bg-primary h-full transition-all duration-500 ease-in-out" style={{ width: `${home}%` }} />
      <div className="bg-muted-foreground h-full transition-all duration-500 ease-in-out" style={{ width: `${draw}%` }} />
      <div className="bg-chart-2 h-full transition-all duration-500 ease-in-out" style={{ width: `${away}%` }} />
    </div>
  );
}

function oddsUpdatedLabel(value?: string | null) {
  if (!value) return "update time unavailable";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "update time unavailable";
  return `updated ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

function MatchStatus({ status, detail, minute }: { status: string; detail: string; minute?: number | null }) {
  if (status === "live") {
    return (
      <div className="flex items-center gap-1.5 text-destructive font-mono font-bold text-xs">
        <div className="h-1.5 w-1.5 rounded-full bg-destructive pulse-dot" />
        {minute ? `${minute}'` : detail}
      </div>
    );
  }
  if (status === "finished") {
    return <div className="text-muted-foreground font-mono font-bold text-xs">{detail}</div>;
  }
  return <div className="text-primary/80 font-mono font-bold text-xs">{detail}</div>;
}

type ThreeWay = { home_win: number; draw: number; away_win: number };

/** One-line betting note for a card: who our prediction has winning, live as the match goes on. */
function predictionNote(match: Match, current: ThreeWay, kickoff?: ThreeWay) {
  const ranked = ([["home_win", `${match.home_team.name} to win`], ["draw", "Draw"], ["away_win", `${match.away_team.name} to win`]] as const)
    .map(([k, label]) => ({ k, label, p: current[k] })).sort((a, b) => b.p - a.p);
  const top = ranked[0];
  const close = top.p - ranked[1].p < 5;
  const change = match.status === "live" && kickoff ? current[top.k] - kickoff[top.k] : null;
  return {
    prefix: match.status === "live" ? `${match.minute != null ? `${match.minute}'` : "LIVE"} ·` : "",
    text: close ? `Too close to call · ${top.label} ${top.p.toFixed(0)}%` : `${top.label} ${top.p.toFixed(0)}%`,
    change: change != null && Math.abs(change) >= 1 ? change : null,
  };
}

function PickLine({ match, xg, kickoff }: { match: Match; xg: XGPrediction; kickoff?: ThreeWay }) {
  const n = predictionNote(match, xg, kickoff);
  return (
    <div className="flex items-baseline justify-between gap-2" data-testid={`card-prediction-note-${match.id}`}>
      <span className="min-w-0 truncate text-sm font-semibold">
        {n.prefix && <span className="mr-1 font-mono text-xs text-destructive">{n.prefix}</span>}
        {n.text}
      </span>
      {n.change != null && (
        <span className={`shrink-0 font-mono text-[10px] ${n.change > 0 ? "text-emerald-500" : "text-red-500"}`} title="Change since kick-off">
          {n.change > 0 ? "▲" : "▼"}{Math.abs(n.change).toFixed(0)}
        </span>
      )}
    </div>
  );
}

function TeamRow({ team, score, showScore, price, oddsFormat }: { team: Match["home_team"]; score?: number | null; showScore: boolean; price?: number | null; oddsFormat: ReturnType<typeof useOddsFormat> }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-2">
        {team.logo ? <img src={team.logo} alt="" className="h-5 w-5 shrink-0 object-contain" loading="lazy" decoding="async" /> : <span className="h-5 w-5 shrink-0 rounded-full bg-muted" />}
        <span className="truncate font-medium">{team.name}</span>
      </div>
      {showScore ? <span className="font-mono text-lg font-bold">{score ?? "-"}</span>
        : price ? <span className="font-mono text-[11px] text-muted-foreground" title="Bookmaker price">{formatOdds(price, oddsFormat)}</span> : null}
    </div>
  );
}

function MatchCard({ match, valueBets, modelGaps, xg, kickoffPrediction, showEdgeDetail = false }: { match: Match; valueBets: ModelEdge[]; modelGaps: ModelGap[]; xg?: XGPrediction; kickoffPrediction?: ThreeWay; showEdgeDetail?: boolean }) {
  const oddsFormat = useOddsFormat();
  const isLive = match.status === "live";
  const isFinished = match.status === "finished";
  const hasValue = valueBets.length > 0;
  const needsReview = modelGaps.length > 0;
  const odds = match.odds;
  const hasPrices = odds?.home_odds != null || odds?.draw_odds != null || odds?.away_odds != null;
  const showScore = isLive || isFinished;

  return (
    <Link href={`/matches/${match.id}`} data-testid={`card-match-${match.id}`} className="block h-full">
      <Card
        className={`group flex h-full cursor-pointer flex-col gap-3 border-border/50 p-4 transition-colors hover:border-primary/40 hover:bg-muted/40 ${
          isLive ? "border-l-2 border-l-destructive" : ""
        } ${hasValue ? "ring-1 ring-yellow-400/40" : needsReview ? "ring-1 ring-amber-400/30" : ""}`}
      >
        <div className="flex items-center justify-between gap-2">
          {match.status === "upcoming"
            ? <span className="font-mono text-xs text-primary/90">{format(new Date(match.kickoff), "EEE d MMM · HH:mm")}</span>
            : <MatchStatus status={match.status} detail={match.status_detail} minute={match.minute} />}
          <div className="flex items-center gap-1.5">
            {hasValue && <ValueBadge bets={valueBets} />}
            {needsReview && (
              <span
                className="inline-flex items-center rounded border border-amber-400/30 bg-amber-400/10 px-1.5 py-0.5 text-[9px] font-mono font-bold uppercase tracking-wider text-amber-300"
                data-testid="badge-model-gap-review"
                title={`Largest model/market probability gap is ${modelGaps[0].delta.toFixed(1)} percentage points. Hidden from model edges pending review.`}
              >
                Review
              </span>
            )}
          </div>
        </div>

        <div className="space-y-1.5">
          <TeamRow team={match.home_team} score={match.score?.home} showScore={showScore} price={odds?.home_odds} oddsFormat={oddsFormat} />
          <TeamRow team={match.away_team} score={match.score?.away} showScore={showScore} price={odds?.away_odds} oddsFormat={oddsFormat} />
        </div>

        <div className="mt-auto space-y-1.5 border-t border-border/40 pt-3">
          {xg ? (
            <>
              {(isLive || match.status === "upcoming") && <PickLine match={match} xg={xg} kickoff={kickoffPrediction} />}
              <ProbabilityBar home={xg.home_win} draw={xg.draw} away={xg.away_win} />
              <div className="flex justify-between font-mono text-[10px] text-muted-foreground">
                <span><span className="text-primary">{xg.home_win.toFixed(0)}%</span> home</span>
                <span>draw {xg.draw.toFixed(0)}%</span>
                <span>away <span className="text-chart-2">{xg.away_win.toFixed(0)}%</span></span>
              </div>
            </>
          ) : (
            <div className="text-xs text-amber-300">{isLive ? "Live prediction not available yet" : isFinished ? "No prediction recorded" : "Prediction being prepared"}</div>
          )}
          {showEdgeDetail && hasValue && (
            <div className="flex flex-wrap gap-x-3 gap-y-1 pt-1 font-mono text-[10px]">
              {valueBets.map((vb) => (
                <span key={vb.outcome} className={`${OUTCOME_COLORS[vb.outcome]} flex items-center gap-0.5`}>
                  <Zap className="h-2.5 w-2.5" />
                  {OUTCOME_LABELS[vb.outcome]}: model {vb.modelProbability.toFixed(0)}% vs market {vb.market.toFixed(0)}%
                </span>
              ))}
            </div>
          )}
          <div className="flex items-center justify-between gap-2 font-mono text-[10px] text-muted-foreground" data-testid={`fixture-bookmaker-odds-${match.id}`}>
            {hasPrices ? (
              <>
                <span title={`Home · draw · away. ${odds.bookmaker || odds.bookmaker_key || "Bookmaker"}, ${isLive ? "live" : "pre-match"}. Bookmaker prices are a 30% input to our prediction.`}>
                  Odds {formatOdds(odds.home_odds, oddsFormat)} · {formatOdds(odds.draw_odds, oddsFormat)} · {formatOdds(odds.away_odds, oddsFormat)}
                </span>
                <span className="truncate" title={odds.last_updated ?? undefined}>{odds.bookmaker || odds.bookmaker_key || "Bookmaker"}</span>
              </>
            ) : (
              <span title="Odds are unavailable or incomplete, so this fixture is excluded from model edge calculations.">No bookmaker odds yet</span>
            )}
          </div>
        </div>
      </Card>
    </Link>
  );
}

const THRESHOLDS = [5, 10, 15, 20] as const;
type Threshold = (typeof THRESHOLDS)[number];

type Filter = "all" | "live" | "upcoming" | "finished" | "value";
const FILTER_TO_VIEW: Record<Filter, string> = { all: "", live: "live", upcoming: "upcoming", finished: "results", value: "edges" };
const VIEW_TO_FILTER: Record<string, Filter> = { live: "live", upcoming: "upcoming", results: "finished", edges: "value" };

const COMPETITION_IMPORTANCE: Record<number, { rank: number; label: string }> = {
  2: { rank: 100, label: "Elite European" },
  3: { rank: 90, label: "Major European" },
  848: { rank: 80, label: "European" },
  45: { rank: 70, label: "Domestic Cup" }, 48: { rank: 70, label: "Domestic Cup" },
  66: { rank: 70, label: "Domestic Cup" }, 81: { rank: 70, label: "Domestic Cup" },
  90: { rank: 70, label: "Domestic Cup" }, 96: { rank: 70, label: "Domestic Cup" },
  137: { rank: 70, label: "Domestic Cup" }, 143: { rank: 70, label: "Domestic Cup" },
  39: { rank: 60, label: "Top Division" }, 61: { rank: 60, label: "Top Division" },
  78: { rank: 60, label: "Top Division" }, 88: { rank: 60, label: "Top Division" },
  94: { rank: 60, label: "Top Division" }, 135: { rank: 60, label: "Top Division" },
  140: { rank: 60, label: "Top Division" },
};

function competitionImportance(leagueId: number) {
  return COMPETITION_IMPORTANCE[leagueId] ?? { rank: 40, label: "Second Division" };
}

function dublinDateKey(kickoff: string | Date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Dublin", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(kickoff));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function dateHeading(key: string) {
  const today = dublinDateKey(new Date());
  const tomorrow = dublinDateKey(new Date(Date.now() + 24 * 60 * 60_000));
  const longDate = new Intl.DateTimeFormat("en-IE", {
    timeZone: "Europe/Dublin", weekday: "long", day: "numeric", month: "long",
  }).format(new Date(`${key}T12:00:00Z`));
  if (key === today) return `Today · ${longDate}`;
  if (key === tomorrow) return `Tomorrow · ${longDate}`;
  return longDate;
}

function shortDateHeading(key: string) {
  const today = dublinDateKey(new Date());
  const tomorrow = dublinDateKey(new Date(Date.now() + 24 * 60 * 60_000));
  if (key === today) return "Today";
  if (key === tomorrow) return "Tomorrow";
  return new Intl.DateTimeFormat("en-IE", { timeZone: "Europe/Dublin", weekday: "short", day: "numeric", month: "short" }).format(new Date(`${key}T12:00:00Z`));
}

function competitionTheme(name: string, country: string) {
  const key = `${name} ${country}`.toLowerCase();
  if (key.includes("champions league")) return { accent: "border-violet-500/70", glow: "from-violet-500/15", badge: "bg-violet-500/15 text-violet-300 border-violet-500/30" };
  if (key.includes("europa league")) return { accent: "border-orange-500/70", glow: "from-orange-500/15", badge: "bg-orange-500/15 text-orange-300 border-orange-500/30" };
  if (key.includes("conference league")) return { accent: "border-emerald-500/70", glow: "from-emerald-500/15", badge: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" };
  if (key.includes("cup")) return { accent: "border-amber-400/70", glow: "from-amber-400/10", badge: "bg-amber-400/15 text-amber-300 border-amber-400/30" };
  if (key.includes("england")) return { accent: "border-sky-500/70", glow: "from-sky-500/15", badge: "bg-sky-500/15 text-sky-300 border-sky-500/30" };
  if (key.includes("spain")) return { accent: "border-rose-500/70", glow: "from-rose-500/15", badge: "bg-rose-500/15 text-rose-300 border-rose-500/30" };
  if (key.includes("italy")) return { accent: "border-cyan-500/70", glow: "from-cyan-500/15", badge: "bg-cyan-500/15 text-cyan-300 border-cyan-500/30" };
  if (key.includes("germany")) return { accent: "border-red-500/70", glow: "from-red-500/15", badge: "bg-red-500/15 text-red-300 border-red-500/30" };
  return { accent: "border-primary/60", glow: "from-primary/10", badge: "bg-primary/10 text-primary border-primary/25" };
}

export default function Dashboard() {
  const [threshold, setThreshold] = useState<Threshold>(10);
  const [selectedFixtureDate, setSelectedFixtureDate] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [location, navigate] = useLocation();
  const search = useSearch();
  // The view lives in the address (?view=live) so the Live tab, links and the back button all agree.
  const filter: Filter = useMemo(() => VIEW_TO_FILTER[new URLSearchParams(search).get("view") ?? ""] ?? "all", [search]);
  const setFilter = (next: Filter) => {
    const params = new URLSearchParams(search);
    if (next === "all") params.delete("view"); else params.set("view", FILTER_TO_VIEW[next]);
    const q = params.toString();
    navigate(q ? `/?${q}` : "/");
  };
  const selectedLeagueId = useMemo(() => {
    const rawLeagueId = new URLSearchParams(search).get("league_id");
    if (!rawLeagueId || !/^[0-9]+$/.test(rawLeagueId)) return null;
    const leagueId = Number(rawLeagueId);
    return Number.isSafeInteger(leagueId) && leagueId > 0 ? leagueId : null;
  }, [search, location]);

  // Model edges are evaluated only for upcoming fixtures; never pass "value" as status
  const apiStatus = filter === "all" || filter === "value" ? undefined : filter;
  const scopeLabel: Record<Filter, string> = {
    all: "TODAY + NEXT 7 DAYS",
    live: "LIVE NOW",
    upcoming: "NEXT 8 DAYS",
    finished: "TODAY'S RESULTS",
    value: "UPCOMING MODEL EDGES",
  };

  const { data: matches, isLoading, isError, refetch } = useGetMatches(
    // The generated client serializes null as "league_id=null", which the API
    // would parse as an invalid league. Omit the parameter when showing all.
    { status: apiStatus, league_id: selectedLeagueId ?? undefined },
    { query: {
      refetchInterval: 15000,
      staleTime: 10_000,
      gcTime: 10 * 60_000,
      placeholderData: keepPreviousData,
      queryKey: getGetMatchesQueryKey({ status: apiStatus, league_id: selectedLeagueId }),
    } }
  );

  // keepPreviousData may temporarily retain the previous league's matches while
  // the filtered query loads, so apply the selection locally as well.
  const visibleMatches = useMemo(
    () => selectedLeagueId == null
      ? matches
      : (matches ?? []).filter((match) => match.league_id === selectedLeagueId),
    [matches, selectedLeagueId],
  );

  // Bulk xG predictions — one call, 5-min cache
  const { data: xgData } = useGetXg({
    query: { refetchInterval: 30_000, staleTime: 30_000, gcTime: 10 * 60_000, queryKey: getGetXgQueryKey() },
  });

  const { data: storedData } = useQuery({
    queryKey: ["stored-predictions", 8],
    queryFn: async () => {
      const response = await fetch("/api/predictions/upcoming?days=8");
      if (!response.ok) throw new Error("Stored predictions unavailable");
      return response.json() as Promise<{ fixtures: Array<{ fixture_id: number; prediction: { home_win: number; draw: number; away_win: number; home_xg?: number | null; away_xg?: number | null } }> }>;
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
    gcTime: 10 * 60_000,
    placeholderData: keepPreviousData,
  });

  const xgMap = useMemo<Map<number, XGPrediction>>(() => {
    const map = new Map<number, XGPrediction>();
    for (const prediction of xgData?.predictions ?? []) map.set(prediction.match_id, prediction);
    const liveMatchIds = new Set((visibleMatches ?? []).filter((match) => match.status === "live").map((match) => match.id));
    for (const fixture of storedData?.fixtures ?? []) {
      // Saved forecasts are frozen prematch; never replace a live forecast.
      if (liveMatchIds.has(fixture.fixture_id)) continue;
      map.set(fixture.fixture_id, {
        match_id: fixture.fixture_id,
        home_xg: fixture.prediction.home_xg ?? 0,
        away_xg: fixture.prediction.away_xg ?? 0,
        home_win: fixture.prediction.home_win,
        draw: fixture.prediction.draw,
        away_win: fixture.prediction.away_win,
      });
    }
    return map;
  }, [xgData, storedData, visibleMatches]);

  // Sealed pre-match numbers, kept for live matches too so cards can show the change since kick-off.
  const kickoffMap = useMemo(() => {
    const map = new Map<number, ThreeWay>();
    for (const f of storedData?.fixtures ?? []) map.set(f.fixture_id, { home_win: f.prediction.home_win, draw: f.prediction.draw, away_win: f.prediction.away_win });
    return map;
  }, [storedData]);

  // Value is judged only against step 9 (odds-free); the original formula and
  // the quick xG model are too far from the market for their gaps to mean value.
  const { data: valueSignals } = useQuery({
    queryKey: ["value-signals"],
    queryFn: async () => {
      const response = await fetch("/api/model/value-signals");
      if (!response.ok) throw new Error("Value signals unavailable");
      return response.json() as Promise<{ fixtures: Array<{ fixture_id: number; model_probabilities: { home: number; draw: number; away: number } }> }>;
    },
    refetchInterval: 2 * 60_000,
    staleTime: 60_000,
    gcTime: 10 * 60_000,
    placeholderData: keepPreviousData,
  });
  const valueModelMap = useMemo(() => {
    const map = new Map<number, { home_win: number; draw: number; away_win: number }>();
    for (const f of valueSignals?.fixtures ?? []) {
      map.set(f.fixture_id, { home_win: f.model_probabilities.home, draw: f.model_probabilities.draw, away_win: f.model_probabilities.away });
    }
    return map;
  }, [valueSignals]);

  // A halftime-only backtest cannot price a live match state.
  const valueBetMap = useMemo<Map<number, ModelEdge[]>>(() => {
    if (!visibleMatches) return new Map();
    const map = new Map<number, ModelEdge[]>();
    for (const match of visibleMatches) {
      const prediction = valueModelMap.get(match.id);
      if (match.status !== "upcoming" || !match.odds || !prediction) {
        map.set(match.id, []);
        continue;
      }
      map.set(match.id, findModelEdges(match.odds, prediction, threshold));
    }
    return map;
  }, [visibleMatches, valueModelMap, threshold]);

  const modelGapMap = useMemo<Map<number, ModelGap[]>>(() => {
    const map = new Map<number, ModelGap[]>();
    for (const match of visibleMatches ?? []) {
      const prediction = valueModelMap.get(match.id);
      if (match.status !== "upcoming" || !match.odds || !prediction) continue;
      map.set(match.id, findModelGaps(match.odds, prediction));
    }
    return map;
  }, [visibleMatches, valueModelMap]);

  const totalValueBets = useMemo(() => {
    let count = 0;
    for (const bets of valueBetMap.values()) count += bets.length > 0 ? 1 : 0;
    return count;
  }, [valueBetMap]);

  // Sorted flat list for the Value tab — best delta first
  const valueSortedMatches = useMemo(() => {
    if (!visibleMatches) return [];
    return visibleMatches
      .filter((m) => (valueBetMap.get(m.id) ?? []).length > 0)
      .sort((a, b) => {
        const topA = (valueBetMap.get(a.id) ?? [])[0]?.delta ?? 0;
        const topB = (valueBetMap.get(b.id) ?? [])[0]?.delta ?? 0;
        return topB - topA;
      });
  }, [visibleMatches, valueBetMap]);

  const groupedMatches = useMemo(() => {
    if (!visibleMatches) return [];
    const dates = new Map<string, Map<number, { name: string; logo?: string | null; country: string; matches: Match[] }>>();
    for (const match of visibleMatches) {
      const date = dublinDateKey(match.kickoff);
      if (!dates.has(date)) dates.set(date, new Map());
      const competitions = dates.get(date)!;
      if (!competitions.has(match.league_id)) {
        competitions.set(match.league_id, { name: match.league_name, logo: match.league_logo, country: match.country, matches: [] });
      }
      competitions.get(match.league_id)!.matches.push(match);
    }
    return [...dates.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, competitions]) => ({
      date,
      fixtureCount: [...competitions.values()].reduce((total, group) => total + group.matches.length, 0),
      competitions: [...competitions.entries()]
        .sort(([idA, groupA], [idB, groupB]) => competitionImportance(idB).rank - competitionImportance(idA).rank || groupA.name.localeCompare(groupB.name))
        .map(([leagueId, group]) => ({
          leagueId, ...group,
          matches: [...group.matches].sort((a, b) => {
            const statusRank = (status: string) => status === "live" ? 0 : status === "upcoming" ? 1 : status === "finished" ? 2 : 3;
            return statusRank(a.status) - statusRank(b.status) || new Date(a.kickoff).getTime() - new Date(b.kickoff).getTime();
          }),
        })),
    }));
  }, [visibleMatches]);

  const activeFixtureDate =
    groupedMatches.find((dateGroup) => dateGroup.date === selectedFixtureDate) ??
    groupedMatches[0] ??
    null;

  const liveTotal = (matches ?? []).filter((m) => m.status === "live").length;
  const VIEWS: Array<{ key: Filter; label: string; hint: string }> = [
    { key: "all", label: "All", hint: "Today and the next 7 days" },
    { key: "live", label: "Live", hint: "Matches in play now" },
    { key: "upcoming", label: "Upcoming", hint: "Not started yet, next 8 days" },
    { key: "finished", label: "Results", hint: "Today's finished matches" },
    { key: "value", label: "Model edges", hint: "Where our model and the bookmakers disagree" },
  ];
  const activeView = VIEWS.find((v) => v.key === filter)!;
  const toggleCollapsed = (leagueId: number) => setCollapsed((prev) => {
    const next = new Set(prev);
    if (next.has(leagueId)) next.delete(leagueId); else next.add(leagueId);
    return next;
  });

  return (
    <div className="mx-auto max-w-[1600px] space-y-5">
      <header className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-bold tracking-tight">Matches</h1>
          {selectedLeagueId != null && (
            <button
              type="button"
              onClick={() => navigate(filter === "all" ? "/" : `/?view=${FILTER_TO_VIEW[filter]}`)}
              data-testid="button-clear-league-filter"
              aria-label="Clear league filter"
              className="rounded-full border border-border/60 bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
              title="Show matches from all leagues"
            >
              {visibleMatches?.[0]?.league_name ?? `League ${selectedLeagueId}`} ×
            </button>
          )}
        </div>
        <p className="text-sm text-muted-foreground">Our win, draw and lose predictions. Tap a match for the full analysis, live updates, stats and odds.</p>
      </header>

      {/* Views */}
      <div className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0">
        <div role="tablist" aria-label="Show" className="inline-flex gap-1 rounded-lg bg-muted/50 p-1">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              role="tab"
              aria-selected={filter === v.key}
              onClick={() => setFilter(v.key)}
              data-testid={`button-filter-${v.key}`}
              title={v.hint}
              className={`flex items-center gap-1.5 whitespace-nowrap rounded-md px-3.5 py-1.5 text-sm font-medium transition-colors ${
                filter === v.key
                  ? v.key === "value" ? "bg-yellow-400/15 text-yellow-400 shadow-sm" : "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {v.key === "live" && <span className="h-1.5 w-1.5 rounded-full bg-destructive pulse-dot" />}
              {v.key === "value" && <Zap className="h-3 w-3" />}
              {v.label}
              {v.key === "live" && liveTotal > 0 && filter !== "live" && <span className="font-mono text-[10px] text-destructive">{liveTotal}</span>}
              {v.key === "value" && totalValueBets > 0 && (
                <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-yellow-400 px-1 text-[9px] font-black text-black" data-testid="badge-total-value-bets">{totalValueBets}</span>
              )}
            </button>
          ))}
        </div>
      </div>

      {filter === "value" && (
        <div className="flex flex-col gap-3 rounded-lg border border-yellow-400/20 bg-yellow-400/5 p-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            Upcoming matches where the step 9 model's chance is higher than the bookmakers' by at least the gap you choose.
            A gap is a difference in probability, not expected profit.
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <SlidersHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">Minimum gap</span>
            <div className="flex rounded bg-muted/50 p-0.5 font-mono text-xs">
              {THRESHOLDS.map((t) => (
                <button key={t} onClick={() => setThreshold(t)} data-testid={`button-threshold-${t}`}
                  className={`rounded px-2 py-0.5 transition-colors ${threshold === t ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
                  {t} pts
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {!isLoading && filter !== "value" && groupedMatches.length > 1 && (
        <nav aria-label="Choose a date" data-testid="fixture-date-navigation" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 md:mx-0 md:px-0">
          {groupedMatches.map((dateGroup) => {
            const active = activeFixtureDate?.date === dateGroup.date;
            return (
              <button
                key={dateGroup.date}
                type="button"
                data-testid={`button-fixture-date-${dateGroup.date}`}
                onClick={() => setSelectedFixtureDate(dateGroup.date)}
                aria-pressed={active}
                className={`shrink-0 rounded-lg border px-3 py-1.5 text-left transition-colors ${active ? "border-primary/50 bg-primary/10" : "border-border/60 hover:border-primary/40"}`}
              >
                <span className="block text-xs font-semibold">{shortDateHeading(dateGroup.date)}</span>
                <span className="block font-mono text-[10px] text-muted-foreground">{dateGroup.fixtureCount} match{dateGroup.fixtureCount === 1 ? "" : "es"}</span>
              </button>
            );
          })}
        </nav>
      )}

      {isLoading ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 8 }, (_, j) => <Skeleton key={j} className="h-48 w-full" />)}
        </div>
      ) : isError && !matches ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-destructive/30 py-24 text-center text-muted-foreground">
          <Trophy className="h-10 w-10 opacity-30" />
          <p>Match data couldn’t be loaded. Predictions stay frozen after kickoff.</p>
          <button onClick={() => void refetch()} className="rounded-md border border-border px-3 py-1.5 text-sm text-foreground hover:bg-muted">Try again</button>
        </div>
      ) : filter === "value" ? (
        valueSortedMatches.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-yellow-400/20 py-24 text-center text-muted-foreground">
            <Zap className="mb-4 h-12 w-12 text-yellow-400 opacity-20" />
            <p className="text-sm">No upcoming step 9 edges at ≥{threshold} points (odds 6.0 or shorter, gap up to 12 points).</p>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              {valueSortedMatches.length} upcoming {valueSortedMatches.length === 1 ? "match" : "matches"}, biggest gap first
            </p>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {valueSortedMatches.map((match, idx) => (
                <div key={match.id} className="space-y-1.5">
                  <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-yellow-400 text-[10px] font-black text-black">{idx + 1}</span>
                    <LeagueLogo src={match.league_logo} name={match.league_name} className="h-3.5 w-3.5 object-contain" />
                    <span className="truncate">{match.league_name} · {match.country}</span>
                  </div>
                  <MatchCard match={match} valueBets={valueBetMap.get(match.id) ?? []} modelGaps={modelGapMap.get(match.id) ?? []} xg={xgMap.get(match.id)} kickoffPrediction={kickoffMap.get(match.id)} showEdgeDetail />
                </div>
              ))}
            </div>
          </div>
        )
      ) : !visibleMatches || visibleMatches.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-24 text-center text-muted-foreground">
          <Trophy className="mb-4 h-12 w-12 opacity-20" />
          <p>{filter === "live" ? "No matches in play right now." : filter === "finished" ? "No results yet today." : "No matches found."}</p>
          {filter !== "all" && <button onClick={() => setFilter("all")} className="mt-3 text-sm text-primary hover:underline">Show all matches</button>}
        </div>
      ) : (
        groupedMatches.filter((dateGroup) => dateGroup.date === activeFixtureDate?.date).map((dateGroup) => (
          <section key={dateGroup.date} className="space-y-4" data-testid={`fixture-date-${dateGroup.date}`}>
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-lg font-semibold tracking-tight">{dateHeading(dateGroup.date)}</h2>
              <span className="text-xs text-muted-foreground">{dateGroup.fixtureCount} match{dateGroup.fixtureCount === 1 ? "" : "es"} · {dateGroup.competitions.length} competition{dateGroup.competitions.length === 1 ? "" : "s"}</span>
            </div>

            {dateGroup.competitions.length > 1 && (
              <nav aria-label="Jump to competition" className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 md:mx-0 md:flex-wrap md:px-0">
                {dateGroup.competitions.map((group) => (
                  <a key={group.leagueId} href={`#competition-${group.leagueId}`}
                    onClick={(e) => { e.preventDefault(); setCollapsed((prev) => { const n = new Set(prev); n.delete(group.leagueId); return n; }); document.getElementById(`competition-${group.leagueId}`)?.scrollIntoView({ behavior: "smooth", block: "start" }); }}
                    className="flex shrink-0 items-center gap-1.5 rounded-full border border-border/60 bg-card/50 px-2.5 py-1 text-xs text-muted-foreground hover:border-primary/40 hover:text-foreground">
                    <LeagueLogo src={group.logo} name={group.name} className="h-3.5 w-3.5 object-contain" />
                    {group.name}
                    <span className="font-mono text-[10px]">{group.matches.length}</span>
                  </a>
                ))}
              </nav>
            )}

            {dateGroup.competitions.map((group) => {
              const theme = competitionTheme(group.name, group.country);
              const importance = competitionImportance(group.leagueId);
              const isCollapsed = collapsed.has(group.leagueId);
              const liveHere = group.matches.filter((m) => m.status === "live").length;
              const leagueValueCount = group.matches.filter((m) => (valueBetMap.get(m.id) ?? []).length > 0).length;
              return (
                <section key={`${dateGroup.date}-${group.leagueId}`} id={`competition-${group.leagueId}`} className={`scroll-mt-20 rounded-xl border border-border/50 border-l-4 ${theme.accent} bg-card/30`}>
                  <button type="button" onClick={() => toggleCollapsed(group.leagueId)} aria-expanded={!isCollapsed}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left">
                    <LeagueLogo src={group.logo} name={group.name} className="h-7 w-7 shrink-0 object-contain" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-semibold">{group.name}</div>
                      <div className="truncate text-xs text-muted-foreground">{group.country} · {importance.label}</div>
                    </div>
                    {liveHere > 0 && <span className="rounded-full bg-destructive/15 px-2 py-0.5 text-[10px] font-semibold text-destructive">{liveHere} live</span>}
                    {leagueValueCount > 0 && <span className="flex items-center gap-0.5 text-[10px] text-yellow-400"><Zap className="h-2.5 w-2.5" />{leagueValueCount}</span>}
                    <span className="text-xs text-muted-foreground">{group.matches.length}</span>
                    <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${isCollapsed ? "-rotate-90" : ""}`} />
                  </button>
                  {!isCollapsed && (
                    <div className="grid grid-cols-1 gap-3 px-4 pb-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                      {group.matches.map((match) => (
                        <MatchCard
                          key={match.id}
                          match={match}
                          valueBets={valueBetMap.get(match.id) ?? []}
                          modelGaps={modelGapMap.get(match.id) ?? []}
                          xg={xgMap.get(match.id)}
                          kickoffPrediction={kickoffMap.get(match.id)}
                        />
                      ))}
                    </div>
                  )}
                </section>
              );
            })}
          </section>
        ))
      )}
    </div>
  );
}
