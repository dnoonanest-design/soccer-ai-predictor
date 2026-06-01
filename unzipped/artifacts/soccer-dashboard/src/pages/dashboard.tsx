import {
  useGetMatches,
  getGetMatchesQueryKey,
  useGetBacktest,
  getGetBacktestQueryKey,
  useGetXg,
  getGetXgQueryKey,
  Match,
  BacktestScenario,
  XGPrediction,
} from "@workspace/api-client-react";
import { useState, useMemo } from "react";
import { Link } from "wouter";
import { format } from "date-fns";
import { Trophy, Activity, Zap, SlidersHorizontal } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { decimalToFractional, findValueBets, ValueBet } from "@/lib/odds";

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

const OUTCOME_LABELS: Record<ValueBet["outcome"], string> = {
  HOME: "HOME",
  DRAW: "DRAW",
  AWAY: "AWAY",
};

const OUTCOME_COLORS: Record<ValueBet["outcome"], string> = {
  HOME: "text-primary",
  DRAW: "text-yellow-400",
  AWAY: "text-chart-2",
};

function ValueBadge({ bets }: { bets: ValueBet[] }) {
  if (bets.length === 0) return null;
  const top = bets[0];
  return (
    <div
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-mono font-black uppercase tracking-widest bg-yellow-400/10 border border-yellow-400/30 text-yellow-400"
      data-testid="badge-value-bet"
      title={`History says ${OUTCOME_LABELS[top.outcome]} is ${top.history.toFixed(1)}% likely vs market's ${top.market.toFixed(1)}%`}
    >
      <Zap className="w-2.5 h-2.5" />
      {OUTCOME_LABELS[top.outcome]} +{Math.round(top.delta)}%
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

function MatchCard({ match, valueBets, xg }: { match: Match; valueBets: ValueBet[]; xg?: XGPrediction }) {
  const isLive = match.status === "live";
  const hasValue = valueBets.length > 0;

  return (
    <Link href={`/matches/${match.id}`} data-testid={`card-match-${match.id}`}>
      <Card
        className={`p-3 hover:bg-muted/50 transition-colors border-border/50 group cursor-pointer h-full flex flex-col justify-between ${
          hasValue ? "ring-1 ring-yellow-400/40 border-yellow-400/30" : ""
        }`}
      >
        <div>
          <div className="flex justify-between items-start mb-3">
            <div className="flex items-center gap-2 flex-wrap">
              <MatchStatus status={match.status} detail={match.status_detail} minute={match.minute} />
              {hasValue && <ValueBadge bets={valueBets} />}
            </div>
            {match.status === "upcoming" && (
              <div className="text-xs text-muted-foreground font-mono">
                {format(new Date(match.kickoff), "HH:mm")}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <div className="flex justify-between items-center">
              <div className="flex items-center gap-2 font-medium truncate">
                {match.home_team.logo && (
                  <img src={match.home_team.logo} alt={match.home_team.name} className="w-4 h-4 object-contain" />
                )}
                <span className="truncate">{match.home_team.name}</span>
                {match.odds?.home_odds && (
                  <Tip text={`Fractional odds for ${match.home_team.name} to win — for every £1 staked you profit ${decimalToFractional(match.odds.home_odds)}`}>
                    <span className="text-[10px] text-muted-foreground font-mono bg-muted px-1 rounded cursor-default">
                      {decimalToFractional(match.odds.home_odds)}
                    </span>
                  </Tip>
                )}
              </div>
              <div className={`font-mono text-lg font-bold ${(isLive || match.status === "finished") ? "text-foreground" : "text-transparent"}`}>
                {match.score?.home ?? "-"}
              </div>
            </div>

            <div className="flex justify-between items-center">
              <div className="flex items-center gap-2 font-medium truncate">
                {match.away_team.logo && (
                  <img src={match.away_team.logo} alt={match.away_team.name} className="w-4 h-4 object-contain" />
                )}
                <span className="truncate">{match.away_team.name}</span>
                {match.odds?.away_odds && (
                  <Tip text={`Fractional odds for ${match.away_team.name} to win — for every £1 staked you profit ${decimalToFractional(match.odds.away_odds)}`}>
                    <span className="text-[10px] text-muted-foreground font-mono bg-muted px-1 rounded cursor-default">
                      {decimalToFractional(match.odds.away_odds)}
                    </span>
                  </Tip>
                )}
              </div>
              <div className={`font-mono text-lg font-bold ${(isLive || match.status === "finished") ? "text-foreground" : "text-transparent"}`}>
                {match.score?.away ?? "-"}
              </div>
            </div>
          </div>
        </div>

        {match.odds && match.odds.home_win != null && (
          <div className="mt-4 pt-3 border-t border-border/50">
            {/* Value bet breakdown row */}
            {hasValue && (
              <div className="flex gap-3 text-[9px] font-mono mb-2">
                {valueBets.map((vb) => (
                  <span key={vb.outcome} className={`${OUTCOME_COLORS[vb.outcome]} flex items-center gap-0.5`}>
                    <Zap className="w-2 h-2" />
                    {OUTCOME_LABELS[vb.outcome]}: hist {vb.history.toFixed(0)}% vs mkt {vb.market.toFixed(0)}%
                  </span>
                ))}
              </div>
            )}
            <div className="flex justify-between text-[10px] font-mono text-muted-foreground mb-1">
              <Tip text="Market-implied home win probability from the bookmaker's odds">
                <span className="text-primary cursor-default">{match.odds.home_win.toFixed(1)}%</span>
              </Tip>
              <Tip text="Market-implied draw probability from the bookmaker's odds">
                <span className="cursor-default">{match.odds.draw?.toFixed(1)}%</span>
              </Tip>
              <Tip text="Market-implied away win probability from the bookmaker's odds">
                <span className="text-chart-2 cursor-default">{match.odds.away_win?.toFixed(1)}%</span>
              </Tip>
            </div>
            <ProbabilityBar home={match.odds.home_win} draw={match.odds.draw} away={match.odds.away_win} />

            {/* xG model row */}
            {xg && (
              <div className="mt-2 space-y-1">
                <div className="flex justify-between items-center text-[9px] font-mono text-muted-foreground/50">
                  <span className="uppercase tracking-widest">Model</span>
                  <span className="flex gap-3">
                    <Tip text={`xG model: ${xg.home_win.toFixed(1)}% home win probability based on season attack & defence averages using a Poisson distribution`}>
                      <span className="text-primary/70 cursor-default">{xg.home_win.toFixed(0)}%</span>
                    </Tip>
                    <Tip text={`xG model: ${xg.draw.toFixed(1)}% draw probability from the Poisson model`}>
                      <span className="cursor-default">{xg.draw.toFixed(0)}%</span>
                    </Tip>
                    <Tip text={`xG model: ${xg.away_win.toFixed(1)}% away win probability based on season attack & defence averages using a Poisson distribution`}>
                      <span className="text-chart-2/70 cursor-default">{xg.away_win.toFixed(0)}%</span>
                    </Tip>
                  </span>
                </div>
                <div className="w-full flex h-1 rounded-full overflow-hidden bg-muted/50">
                  <div className="bg-primary/50 h-full" style={{ width: `${xg.home_win}%` }} />
                  <div className="bg-muted-foreground/40 h-full" style={{ width: `${xg.draw}%` }} />
                  <div className="bg-chart-2/50 h-full" style={{ width: `${xg.away_win}%` }} />
                </div>
              </div>
            )}
          </div>
        )}
      </Card>
    </Link>
  );
}

const THRESHOLDS = [5, 10, 15, 20] as const;
type Threshold = (typeof THRESHOLDS)[number];

type Filter = "all" | "live" | "upcoming" | "finished" | "value";

export default function Dashboard() {
  const [filter, setFilter] = useState<Filter>("all");
  const [threshold, setThreshold] = useState<Threshold>(10);

  // For value tab we still need all live matches to scan — so never pass "value" as status
  const apiStatus = filter === "all" || filter === "value" ? undefined : filter;

  const { data: matches, isLoading } = useGetMatches(
    { status: apiStatus },
    { query: { refetchInterval: 15000, queryKey: getGetMatchesQueryKey({ status: apiStatus }) } }
  );

  // Fetch backtest scenarios — cached on backend, fast after first load
  const { data: backtest } = useGetBacktest(
    {},
    { query: { queryKey: getGetBacktestQueryKey({}) } }
  );

  // Bulk xG predictions — one call, 5-min cache
  const { data: xgData } = useGetXg({
    query: { refetchInterval: 30_000, queryKey: getGetXgQueryKey() },
  });

  const xgMap = useMemo<Map<number, XGPrediction>>(() => {
    if (!xgData?.predictions) return new Map();
    return new Map(xgData.predictions.map((p) => [p.match_id, p]));
  }, [xgData]);

  // Build a scenario lookup map: "htHome-htAway" → scenario
  const scenarioMap = useMemo<Map<string, BacktestScenario>>(() => {
    if (!backtest?.scenarios) return new Map();
    return new Map(backtest.scenarios.map((s) => [s.halftime_score, s]));
  }, [backtest]);

  // Compute value bets per match
  const valueBetMap = useMemo<Map<number, ValueBet[]>>(() => {
    if (!matches) return new Map();
    const map = new Map<number, ValueBet[]>();
    for (const match of matches) {
      const isSecondHalf =
        match.status === "live" &&
        ["2H", "ET", "BT", "HT"].includes(match.status_detail);
      const htHome = (match as Match & { score_ht?: { home: number | null; away: number | null } | null }).score_ht?.home;
      const htAway = (match as Match & { score_ht?: { home: number | null; away: number | null } | null }).score_ht?.away;
      if (!isSecondHalf || htHome == null || htAway == null || !match.odds) {
        map.set(match.id, []);
        continue;
      }
      const scenario = scenarioMap.get(`${htHome}-${htAway}`);
      if (!scenario) {
        map.set(match.id, []);
        continue;
      }
      map.set(match.id, findValueBets(match.odds, scenario, threshold));
    }
    return map;
  }, [matches, scenarioMap, threshold]);

  const totalValueBets = useMemo(() => {
    let count = 0;
    for (const bets of valueBetMap.values()) count += bets.length > 0 ? 1 : 0;
    return count;
  }, [valueBetMap]);

  // Sorted flat list for the Value tab — best delta first
  const valueSortedMatches = useMemo(() => {
    if (!matches) return [];
    return matches
      .filter((m) => (valueBetMap.get(m.id) ?? []).length > 0)
      .sort((a, b) => {
        const topA = (valueBetMap.get(a.id) ?? [])[0]?.delta ?? 0;
        const topB = (valueBetMap.get(b.id) ?? [])[0]?.delta ?? 0;
        return topB - topA;
      });
  }, [matches, valueBetMap]);

  const groupedMatches = useMemo(() => {
    if (!matches) return {};
    return matches.reduce(
      (acc, match) => {
        if (!acc[match.league_id]) {
          acc[match.league_id] = { name: match.league_name, logo: match.league_logo, country: match.country, matches: [] };
        }
        acc[match.league_id].matches.push(match);
        return acc;
      },
      {} as Record<number, { name: string; logo?: string | null; country: string; matches: Match[] }>
    );
  }, [matches]);

  return (
    <div className="space-y-6 max-w-[1600px] mx-auto">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 border-b border-border/50 pb-4">
        <div className="flex items-center gap-4">
          <h1 className="text-2xl font-bold tracking-tight">Match Center</h1>
          {totalValueBets > 0 && (
            <div
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-yellow-400/10 border border-yellow-400/30 text-yellow-400 text-xs font-mono font-bold"
              data-testid="badge-total-value-bets"
            >
              <Zap className="w-3 h-3" />
              {totalValueBets} value {totalValueBets === 1 ? "bet" : "bets"} flagged
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          {/* Threshold selector */}
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-xs text-muted-foreground font-mono">threshold:</span>
            <div className="flex bg-muted/50 p-0.5 rounded text-xs font-mono">
              {THRESHOLDS.map((t) => (
                <button
                  key={t}
                  onClick={() => setThreshold(t)}
                  data-testid={`button-threshold-${t}`}
                  className={`px-2 py-0.5 rounded transition-colors ${
                    threshold === t ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {t}%
                </button>
              ))}
            </div>
          </div>

          {/* Status filter */}
          <div className="flex bg-muted/50 p-1 rounded-md text-sm font-medium">
            {(["all", "live", "upcoming", "finished"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                data-testid={`button-filter-${f}`}
                className={`px-4 py-1.5 rounded-sm capitalize transition-colors ${
                  filter === f ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {f} {f === "live" && <Activity className="inline-block w-3 h-3 ml-1 text-destructive" />}
              </button>
            ))}
            <button
              onClick={() => setFilter("value")}
              data-testid="button-filter-value"
              className={`px-4 py-1.5 rounded-sm flex items-center gap-1.5 transition-colors ${
                filter === "value"
                  ? "bg-yellow-400/15 shadow-sm text-yellow-400"
                  : "text-muted-foreground hover:text-yellow-400"
              }`}
            >
              <Zap className="w-3 h-3" />
              Value
              {totalValueBets > 0 && (
                <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-yellow-400 text-black text-[9px] font-black">
                  {totalValueBets}
                </span>
              )}
            </button>
          </div>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-8">
          {[1, 2].map((i) => (
            <div key={i} className="space-y-4">
              <Skeleton className="h-8 w-64" />
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
                {[1, 2, 3, 4].map((j) => (
                  <Skeleton key={j} className="h-40 w-full" />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : filter === "value" ? (
        valueSortedMatches.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-muted-foreground border border-dashed border-yellow-400/20 rounded-lg">
            <Zap className="w-12 h-12 mb-4 opacity-20 text-yellow-400" />
            <p className="font-mono text-sm">No value bets found at ≥{threshold}% threshold.</p>
            <p className="text-xs mt-1">Try lowering the threshold or check back when more matches are in the 2nd half.</p>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs font-mono text-muted-foreground">
              {valueSortedMatches.length} {valueSortedMatches.length === 1 ? "match" : "matches"} · ranked by largest divergence · ≥{threshold}% threshold
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {valueSortedMatches.map((match, idx) => {
                const bets = valueBetMap.get(match.id) ?? [];
                const topDelta = bets[0]?.delta ?? 0;
                return (
                  <div key={match.id} className="relative">
                    {/* Rank badge */}
                    <div className="absolute -top-2 -left-2 z-10 flex items-center gap-1">
                      <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-yellow-400 text-black text-[9px] font-black shadow">
                        {idx + 1}
                      </span>
                      <span className="text-[9px] font-mono font-bold text-yellow-400">+{topDelta.toFixed(0)}%</span>
                    </div>
                    {/* League label */}
                    <div className="flex items-center gap-1.5 mb-1.5 pl-5">
                      {match.league_logo ? (
                        <img src={match.league_logo} alt={match.league_name} className="w-3.5 h-3.5 object-contain" />
                      ) : null}
                      <span className="text-[10px] text-muted-foreground font-mono uppercase tracking-wider truncate">
                        {match.league_name} · {match.country}
                      </span>
                    </div>
                    <MatchCard match={match} valueBets={bets} xg={xgMap.get(match.id)} />
                  </div>
                );
              })}
            </div>
          </div>
        )
      ) : !matches || matches.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-muted-foreground border border-dashed border-border rounded-lg">
          <Trophy className="w-12 h-12 mb-4 opacity-20" />
          <p>No {filter !== "all" ? filter : ""} matches found.</p>
        </div>
      ) : (
        <div className="space-y-8">
          {Object.entries(groupedMatches).map(([leagueId, group]) => (
            <div key={leagueId} className="space-y-4">
              <div className="flex items-center gap-3">
                {group.logo ? (
                  <img src={group.logo} alt={group.name} className="w-6 h-6 object-contain" />
                ) : (
                  <Trophy className="w-5 h-5 text-muted-foreground" />
                )}
                <h2 className="text-lg font-semibold tracking-tight">{group.name}</h2>
                <span className="text-xs text-muted-foreground uppercase tracking-wider">{group.country}</span>
                {(() => {
                  const leagueValueCount = group.matches.filter((m) => (valueBetMap.get(m.id) ?? []).length > 0).length;
                  return leagueValueCount > 0 ? (
                    <span className="text-[10px] font-mono text-yellow-400 flex items-center gap-0.5">
                      <Zap className="w-2.5 h-2.5" />{leagueValueCount}
                    </span>
                  ) : null;
                })()}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {group.matches.map((match) => (
                  <MatchCard
                    key={match.id}
                    match={match}
                    valueBets={valueBetMap.get(match.id) ?? []}
                    xg={xgMap.get(match.id)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
