import {
  useGetMatch, getGetMatchQueryKey,
  useGetBacktest, getGetBacktestQueryKey,
  useGetMatchEvents, getGetMatchEventsQueryKey,
  useGetMatchStats, getGetMatchStatsQueryKey,
  useGetMatchPresentation, getGetMatchPresentationQueryKey,
  BacktestScenario, MatchEvent, TeamStats, PresentationPlayer, PresentationTeam,
} from "@workspace/api-client-react";
import { useParams, Link } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment } from "react";
import { ArrowLeft, Trophy, TrendingUp, TrendingDown, Minus, BarChart2, Clock, Swords, Activity, Users, Star } from "lucide-react";
import { format } from "date-fns";
import { Skeleton } from "@/components/ui/skeleton";
import { Card } from "@/components/ui/card";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { formatOdds } from "@/lib/odds";
import { useOddsFormat } from "@/components/layout/Shell";
import { computeXG, divergence } from "@/lib/xg";


/**
 * Poll while a match can still change; stop once it is finished or cancelled.
 * Reads the match already cached by the page so panels need no extra request.
 */
function useMatchPollInterval(matchId: number, intervalMs: number) {
  const queryClient = useQueryClient();
  return () => {
    const cached = queryClient.getQueryData(getGetMatchQueryKey(matchId)) as { status?: string } | undefined;
    return cached?.status === "finished" || cached?.status === "cancelled" ? false : intervalMs;
  };
}

type OddsSnapshot = {
  bookmakerKey: string;
  bookmakerName: string | null;
  homeOdds: number;
  drawOdds: number;
  awayOdds: number;
  observedAt: string;
};

function FixtureOddsMovement({ fixtureId, kickoff, status }: { fixtureId: number; kickoff: string; status: string }) {
  const oddsFormat = useOddsFormat();
  const cutoff = Date.parse(kickoff) - 60_000;
  const { data, isLoading, isError } = useQuery<{ snapshots: OddsSnapshot[] }>({
    queryKey: ["market-intelligence-fixture", fixtureId],
    queryFn: async () => {
      const response = await fetch(`/api/market-intelligence/fixture/${fixtureId}`, {
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error("Odds movement unavailable");
      return response.json() as Promise<{ snapshots: OddsSnapshot[] }>;
    },
    refetchInterval: () => status === "upcoming" && Date.now() < cutoff ? 60_000 : false,
    staleTime: 30_000,
  });

  const byBookmaker = new Map<string, OddsSnapshot[]>();
  const windowStart = Date.parse(kickoff) - 72 * 60 * 60_000;
  for (const snapshot of data?.snapshots ?? []) {
    const observedAt = Date.parse(snapshot.observedAt);
    if (observedAt < windowStart || observedAt > cutoff) continue;
    const list = byBookmaker.get(snapshot.bookmakerKey) ?? [];
    list.push(snapshot);
    byBookmaker.set(snapshot.bookmakerKey, list);
  }
  const bookmakerPriority = ["pinnacle", "betfair_ex_eu", "betfair", "bet365", "unibet_eu", "williamhill"];
  const selectedBookmakerKey = bookmakerPriority.find((key) => byBookmaker.has(key))
    ?? byBookmaker.keys().next().value;
  const selectedSnapshots = selectedBookmakerKey ? byBookmaker.get(selectedBookmakerKey) : undefined;
  const marketRows = selectedSnapshots?.length ? (() => {
    selectedSnapshots.sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
    return [{ first: selectedSnapshots[0], latest: selectedSnapshots[selectedSnapshots.length - 1], count: selectedSnapshots.length, snapshots: selectedSnapshots }];
  })() : [];
  const lastObservedAt = marketRows.reduce<string | null>((latest, row) =>
    !latest || Date.parse(row.latest.observedAt) > Date.parse(latest) ? row.latest.observedAt : latest,
  null);
  const tracking = status === "upcoming" && Date.now() < cutoff;

  return <Card className="overflow-hidden border-border/50" data-testid="fixture-odds-movement">
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border/50 px-4 py-3">
      <div><h2 className="font-mono text-xs font-bold uppercase tracking-widest">Bookmaker odds movement</h2><p className="mt-1 text-[10px] text-muted-foreground">Stored market snapshots from 72 hours before kickoff until one minute before. Odds are display and evaluation data only.</p></div>
      <span className={`rounded-full border px-2 py-1 font-mono text-[9px] font-bold uppercase ${tracking ? "border-primary/30 bg-primary/10 text-primary" : "border-border text-muted-foreground"}`}>{tracking ? "Tracking" : "Tracking closed"}</span>
    </div>
    {isLoading ? <div className="space-y-2 p-4"><Skeleton className="h-10 w-full"/><Skeleton className="h-10 w-full"/></div> : isError ? <p className="p-4 text-xs text-muted-foreground">Odds history is temporarily unavailable.</p> : marketRows.length === 0 ? <p className="p-4 text-xs text-muted-foreground">No bookmaker snapshots have been recorded for this match yet. Coverage depends on the bookmaker feed and league mapping.</p> : <>
      <div className="overflow-x-auto"><table className="w-full min-w-[620px] text-xs"><thead className="font-mono text-[9px] uppercase text-muted-foreground"><tr><th className="px-4 py-2 text-left">Bookmaker</th><th className="px-2 py-2 text-center">Home</th><th className="px-2 py-2 text-center">Draw</th><th className="px-2 py-2 text-center">Away</th><th className="px-4 py-2 text-right">Samples</th></tr></thead><tbody className="divide-y divide-border/40">
        {marketRows.map(({ first, latest, count, snapshots }) => <tr key={first.bookmakerKey}>
          <td className="px-4 py-2 font-medium"><details><summary className="cursor-pointer">{first.bookmakerName ?? first.bookmakerKey}<span className="ml-2 text-[9px] text-primary">history</span></summary><div className="absolute z-20 mt-2 max-h-64 w-[min(90vw,520px)] overflow-auto rounded-lg border border-border bg-card p-2 shadow-xl"><div className="grid grid-cols-[1fr_repeat(3,auto)] gap-x-3 gap-y-1 font-mono text-[9px]"><span className="text-muted-foreground">Observed</span><span>H</span><span>D</span><span>A</span>{snapshots.map((snapshot) => <Fragment key={`${snapshot.bookmakerKey}-${snapshot.observedAt}`}><span className="text-muted-foreground">{format(new Date(snapshot.observedAt), "d MMM HH:mm")}</span><span>{formatOdds(snapshot.homeOdds, oddsFormat)}</span><span>{formatOdds(snapshot.drawOdds, oddsFormat)}</span><span>{formatOdds(snapshot.awayOdds, oddsFormat)}</span></Fragment>)}</div></div></details></td>
          {(["homeOdds", "drawOdds", "awayOdds"] as const).map((key) => <td key={key} className="px-2 py-2 text-center font-mono"><span className="text-muted-foreground">{formatOdds(first[key], oddsFormat)}</span><span className="px-1 text-muted-foreground/50">→</span><span className="font-semibold">{formatOdds(latest[key], oddsFormat)}</span></td>)}
          <td className="px-4 py-2 text-right font-mono text-muted-foreground">{count}</td>
        </tr>)}
      </tbody></table></div>
      <div className="border-t border-border/50 px-4 py-2 text-[10px] text-muted-foreground">Last saved: {lastObservedAt ? format(new Date(lastObservedAt), "d MMM · HH:mm:ss") : "—"} · refreshes while tracking is open</div>
    </>}
  </Card>;
}

function Tip({ children, text, side = "top" }: {
  children: React.ReactNode;
  text: string;
  side?: "top" | "bottom" | "left" | "right";
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} className="max-w-[220px] text-center leading-snug font-sans font-normal normal-case tracking-normal">
        {text}
      </TooltipContent>
    </Tooltip>
  );
}

// ─── Stats Panel ──────────────────────────────────────────────────────────

function PlayerMetric({ label, player, suffix }: { label: string; player: PresentationPlayer | null; suffix: string }) {
  return (
    <div className="rounded-lg border border-border/50 bg-background/50 px-3 py-2.5 min-w-0">
      <div className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground">{label}</div>
      {player ? <div className="mt-1 flex items-center justify-between gap-2"><span className="text-xs font-semibold truncate">{player.name}</span><span className="text-[10px] font-mono text-primary whitespace-nowrap">{player.value ?? 0}{suffix}</span></div> : <div className="mt-1 text-xs text-muted-foreground">Unavailable</div>}
    </div>
  );
}

function TeamSquad({ team, side }: { team: PresentationTeam; side: "home" | "away" }) {
  const color = side === "home" ? "text-primary" : "text-chart-2";
  return (
    <div className="space-y-4 min-w-0">
      <div className="flex items-start justify-between gap-3 border-b border-border/50 pb-3">
        <div><h3 className="font-bold truncate">{team.team_name}</h3><p className="text-[10px] text-muted-foreground font-mono mt-1">Coach: {team.coach ?? "Not available"}</p></div>
        {team.formation && <span className={`rounded-full border border-current/20 bg-current/5 px-2 py-1 text-[10px] font-mono font-bold ${color}`}>{team.formation}</span>}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <PlayerMetric label="Star player" player={team.star_player} suffix=" rating" />
        <PlayerMetric label="Most goals" player={team.top_scorer} suffix=" goals" />
        <PlayerMetric label="Most assists" player={team.top_assister} suffix=" assists" />
        <PlayerMetric label="Most fouls" player={team.top_fouler} suffix=" fouls" />
      </div>
      <div className="rounded-lg border border-border/50 bg-background/40 p-3">
        <div className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground mb-2">Players in form · season rating</div>
        {team.in_form.length ? <div className="flex flex-wrap gap-2">{team.in_form.map((p) => <span key={p.id} className="inline-flex gap-1.5 rounded-full bg-muted px-2.5 py-1 text-[10px]"><span className="font-semibold">{p.name}</span><span className={color}>{p.value}</span></span>)}</div> : <p className="text-xs text-muted-foreground">No rated player data available.</p>}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <SquadList title="Starting XI" players={team.starting_xi} />
        <SquadList title="Substitutes" players={team.substitutes} />
      </div>
    </div>
  );
}

function SquadList({ title, players }: { title: string; players: PresentationPlayer[] }) {
  return <div><div className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground mb-2">{title}</div>{players.length ? <div className="space-y-1.5">{players.map((p) => <div key={p.id} className="flex items-center gap-2 text-xs"><span className="w-6 text-right font-mono text-muted-foreground">{p.number ?? "–"}</span><span className="truncate">{p.name}</span>{p.position && <span className="ml-auto text-[9px] font-mono text-muted-foreground">{p.position}</span>}</div>)}</div> : <p className="text-xs text-muted-foreground">Not announced</p>}</div>;
}

function LineupsAndPlayers({ matchId }: { matchId: number }) {
  const { data, isLoading, isError } = useGetMatchPresentation(matchId, {
    query: { refetchInterval: 5 * 60_000, queryKey: getGetMatchPresentationQueryKey(matchId) },
  });
  return <Card className="border-border/50 overflow-hidden"><div className="p-5 space-y-5">
    <div className="flex items-start justify-between gap-4"><div className="flex items-center gap-2"><Users className="w-4 h-4 text-primary"/><div><div className="font-mono text-sm font-bold uppercase tracking-widest text-muted-foreground">Lineups & Player Intelligence</div><p className="text-[10px] text-muted-foreground mt-1">Official lineups plus season-to-date player leaders</p></div></div>{data && <span className="text-[9px] font-mono text-muted-foreground">{data.season}/{String(data.season + 1).slice(2)}</span>}</div>
    {isLoading ? <div className="grid sm:grid-cols-2 gap-4"><Skeleton className="h-72"/><Skeleton className="h-72"/></div> : isError || !data ? <p className="py-8 text-center text-xs text-muted-foreground">Lineup and player data are temporarily unavailable.</p> : <><div className={`rounded-lg border px-3 py-2 text-[10px] font-mono ${data.lineups_announced ? "border-primary/25 bg-primary/5 text-primary" : "border-amber-400/25 bg-amber-400/5 text-amber-300"}`}><span className="inline-flex items-center gap-1.5"><Star className="w-3 h-3"/>{data.note}</span></div><div className="grid lg:grid-cols-2 gap-6 lg:divide-x lg:divide-border/50"><TeamSquad team={data.home} side="home"/><div className="lg:pl-6"><TeamSquad team={data.away} side="away"/></div></div><p className="text-[9px] text-muted-foreground/60 font-mono">Source: {data.source}. Player leaders are informational and are not derived from this fixture's result.</p></>}
  </div></Card>;
}

const FORM_STYLES: Record<string, string> = {
  W: "bg-primary text-primary-foreground",
  D: "bg-muted text-muted-foreground",
  L: "bg-chart-2/80 text-white",
};

const FORM_TIP: Record<string, string> = {
  W: "Win — this team won this match",
  D: "Draw — this match ended level",
  L: "Loss — this team lost this match",
};

function FormBubbles({ form, reverse }: { form: string; reverse?: boolean }) {
  const chars = form.split("").slice(-5);
  const items = reverse ? [...chars].reverse() : chars;
  return (
    <div className={`flex gap-1 ${reverse ? "flex-row-reverse" : ""}`}>
      {items.map((c, i) => (
        <Tip key={i} text={FORM_TIP[c] ?? c}>
          <span
            className={`w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-black cursor-default ${FORM_STYLES[c] ?? FORM_STYLES.D}`}
          >
            {c}
          </span>
        </Tip>
      ))}
    </div>
  );
}

function StatBar({ label, homeVal, awayVal, homeDisplay, awayDisplay, higherIsBetter = true, tooltip, homeTooltip, awayTooltip }: {
  label: string;
  homeVal: number;
  awayVal: number;
  homeDisplay: string;
  awayDisplay: string;
  higherIsBetter?: boolean;
  tooltip?: string;
  homeTooltip?: string;
  awayTooltip?: string;
}) {
  const total = homeVal + awayVal;
  const homePct = total > 0 ? (homeVal / total) * 100 : 50;
  const awayPct = 100 - homePct;
  const homeLeads = higherIsBetter ? homeVal > awayVal : homeVal < awayVal;
  const awayLeads = higherIsBetter ? awayVal > homeVal : awayVal < homeVal;

  const homeSpan = (
    <span className={`cursor-default ${homeLeads ? "text-primary font-bold" : "text-muted-foreground"}`}>{homeDisplay}</span>
  );
  const awaySpan = (
    <span className={`cursor-default ${awayLeads ? "text-chart-2 font-bold" : "text-muted-foreground"}`}>{awayDisplay}</span>
  );
  const labelSpan = (
    <span className="text-muted-foreground/60 uppercase tracking-wider text-[9px] cursor-default">{label}</span>
  );

  return (
    <div className="space-y-1">
      <div className="flex justify-between text-[10px] font-mono">
        {homeTooltip ? <Tip text={homeTooltip}>{homeSpan}</Tip> : homeSpan}
        {tooltip ? <Tip text={tooltip}>{labelSpan}</Tip> : labelSpan}
        {awayTooltip ? <Tip text={awayTooltip}>{awaySpan}</Tip> : awaySpan}
      </div>
      <div className="flex h-1.5 rounded-full overflow-hidden bg-muted">
        <div className="bg-primary h-full transition-all duration-700" style={{ width: `${homePct}%` }} />
        <div className="bg-chart-2 h-full transition-all duration-700" style={{ width: `${awayPct}%` }} />
      </div>
    </div>
  );
}

function parsePossession(s: string | null | undefined): number {
  if (!s) return 0;
  const n = Number(String(s).replace("%", "").trim());
  return Number.isFinite(n) ? n : 0;
}

function MatchStatsPanel({ matchId, homeTeamName, awayTeamName }: {
  matchId: number;
  homeTeamName: string;
  awayTeamName: string;
}) {
  const statsPollInterval = useMatchPollInterval(matchId, 15000);
  const { data, isLoading } = useGetMatchStats(matchId, {
    query: { refetchInterval: statsPollInterval, queryKey: getGetMatchStatsQueryKey(matchId) },
  });
  const liveHome = (data?.home ?? {}) as any;
  const liveAway = (data?.away ?? {}) as any;

  return (
    <Card className="border-border/50 overflow-hidden" data-testid="panel-stats">
      <div className="p-5 space-y-5">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-muted-foreground" />
            <span className="font-mono text-sm font-bold uppercase tracking-widest text-muted-foreground">
              Team Stats
            </span>
          </div>
          {data && (
            <div className="flex items-center gap-2">
              {data.has_live_stats && (
                <span className="text-[9px] font-mono text-destructive flex items-center gap-1">
                  <div className="w-1.5 h-1.5 rounded-full bg-destructive pulse-dot" />
                  LIVE
                </span>
              )}
              <span className="text-[10px] font-mono text-muted-foreground/60">{data.season}/{String(data.season + 1).slice(2)}</span>
            </div>
          )}
        </div>

        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-6 w-full" />)}
          </div>
        ) : !data ? (
          <p className="text-xs text-muted-foreground font-mono py-4 text-center">No stats available.</p>
        ) : (
          <>
            {/* Team headers + form */}
            <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-4">
              <div className="space-y-1.5">
                <div className="text-xs font-semibold text-foreground truncate">{homeTeamName}</div>
                <FormBubbles form={data.home.form} />
              </div>
              <div className="text-[9px] font-mono text-muted-foreground/50 uppercase tracking-widest text-center">Form</div>
              <div className="space-y-1.5 items-end flex flex-col">
                <div className="text-xs font-semibold text-foreground truncate">{awayTeamName}</div>
                <FormBubbles form={data.away.form} reverse />
              </div>
            </div>

            <div className="space-y-3 pt-1">
              {/* Live fixture stats — only when available */}
              {data.has_live_stats && data.home.possession && data.away.possession && (
                <StatBar
                  label="Possession"
                  tooltip="Ball possession % in this match — the share of time each team held the ball"
                  homeVal={parsePossession(data.home.possession)}
                  awayVal={parsePossession(data.away.possession)}
                  homeDisplay={data.home.possession}
                  awayDisplay={data.away.possession}
                  homeTooltip={`${homeTeamName}: ${data.home.possession} ball possession in this match`}
                  awayTooltip={`${awayTeamName}: ${data.away.possession} ball possession in this match`}
                />
              )}
              {data.has_live_stats && data.home.shots_total != null && data.away.shots_total != null && (
                <StatBar
                  label="Shots"
                  tooltip="Total shots attempted in this match, on or off target"
                  homeVal={data.home.shots_total}
                  awayVal={data.away.shots_total}
                  homeDisplay={String(data.home.shots_total)}
                  awayDisplay={String(data.away.shots_total)}
                  homeTooltip={`${homeTeamName}: ${data.home.shots_total} total shots in this match`}
                  awayTooltip={`${awayTeamName}: ${data.away.shots_total} total shots in this match`}
                />
              )}
              {data.has_live_stats && data.home.shots_on_target != null && data.away.shots_on_target != null && (
                <StatBar
                  label="On Target"
                  tooltip="Shots that required a save or resulted in a goal — a better indicator of attacking threat than total shots"
                  homeVal={data.home.shots_on_target}
                  awayVal={data.away.shots_on_target}
                  homeDisplay={String(data.home.shots_on_target)}
                  awayDisplay={String(data.away.shots_on_target)}
                  homeTooltip={`${homeTeamName}: ${data.home.shots_on_target} shots on target in this match`}
                  awayTooltip={`${awayTeamName}: ${data.away.shots_on_target} shots on target in this match`}
                />
              )}
              {data.has_live_stats && data.home.corners != null && data.away.corners != null && (
                <StatBar
                  label="Corners"
                  tooltip="Corner kicks awarded in this match — often signals sustained pressure in the final third"
                  homeVal={data.home.corners}
                  awayVal={data.away.corners}
                  homeDisplay={String(data.home.corners)}
                  awayDisplay={String(data.away.corners)}
                  homeTooltip={`${homeTeamName}: ${data.home.corners} corners in this match`}
                  awayTooltip={`${awayTeamName}: ${data.away.corners} corners in this match`}
                />
              )}
              {data.has_live_stats && liveHome.expected_goals_live != null && liveAway.expected_goals_live != null && (
                <StatBar
                  label="Live xG"
                  tooltip="API-Football expected goals for this match, when included in your subscription feed"
                  homeVal={liveHome.expected_goals_live}
                  awayVal={liveAway.expected_goals_live}
                  homeDisplay={liveHome.expected_goals_live.toFixed?.(2) ?? String(liveHome.expected_goals_live)}
                  awayDisplay={liveAway.expected_goals_live.toFixed?.(2) ?? String(liveAway.expected_goals_live)}
                  homeTooltip={`${homeTeamName}: ${liveHome.expected_goals_live} live xG`}
                  awayTooltip={`${awayTeamName}: ${liveAway.expected_goals_live} live xG`}
                />
              )}
              {data.has_live_stats && liveHome.shots_inside_box != null && liveAway.shots_inside_box != null && (
                <StatBar
                  label="Shots In Box"
                  tooltip="Shots taken from inside the penalty area — stronger goal threat than long-range shots"
                  homeVal={liveHome.shots_inside_box}
                  awayVal={liveAway.shots_inside_box}
                  homeDisplay={String(liveHome.shots_inside_box)}
                  awayDisplay={String(liveAway.shots_inside_box)}
                  homeTooltip={`${homeTeamName}: ${liveHome.shots_inside_box} shots inside the box`}
                  awayTooltip={`${awayTeamName}: ${liveAway.shots_inside_box} shots inside the box`}
                />
              )}
              {data.has_live_stats && liveHome.blocked_shots != null && liveAway.blocked_shots != null && (
                <StatBar
                  label="Blocked Shots"
                  tooltip="Blocked shots can signal attacking pressure even when shots are not officially on target"
                  homeVal={liveHome.blocked_shots}
                  awayVal={liveAway.blocked_shots}
                  homeDisplay={String(liveHome.blocked_shots)}
                  awayDisplay={String(liveAway.blocked_shots)}
                  homeTooltip={`${homeTeamName}: ${liveHome.blocked_shots} blocked shots`}
                  awayTooltip={`${awayTeamName}: ${liveAway.blocked_shots} blocked shots`}
                />
              )}
              {data.has_live_stats && liveHome.goalkeeper_saves != null && liveAway.goalkeeper_saves != null && (
                <StatBar
                  label="Keeper Saves"
                  tooltip="Goalkeeper saves — useful for judging whether pressure is turning into clear chances"
                  homeVal={liveHome.goalkeeper_saves}
                  awayVal={liveAway.goalkeeper_saves}
                  homeDisplay={String(liveHome.goalkeeper_saves)}
                  awayDisplay={String(liveAway.goalkeeper_saves)}
                  homeTooltip={`${homeTeamName}: ${liveHome.goalkeeper_saves} goalkeeper saves`}
                  awayTooltip={`${awayTeamName}: ${liveAway.goalkeeper_saves} goalkeeper saves`}
                />
              )}
              {data.has_live_stats && liveHome.yellow_cards != null && liveAway.yellow_cards != null && (
                <StatBar
                  label="Yellow Cards"
                  tooltip="Cards affect live risk, intensity and red-card probability"
                  homeVal={liveHome.yellow_cards}
                  awayVal={liveAway.yellow_cards}
                  homeDisplay={String(liveHome.yellow_cards)}
                  awayDisplay={String(liveAway.yellow_cards)}
                  homeTooltip={`${homeTeamName}: ${liveHome.yellow_cards} yellow cards`}
                  awayTooltip={`${awayTeamName}: ${liveAway.yellow_cards} yellow cards`}
                />
              )}
              {data.has_live_stats && liveHome.pass_accuracy && liveAway.pass_accuracy && (
                <StatBar
                  label="Pass Accuracy"
                  tooltip="Pass completion percentage — helps identify control and technical dominance"
                  homeVal={parsePossession(liveHome.pass_accuracy)}
                  awayVal={parsePossession(liveAway.pass_accuracy)}
                  homeDisplay={liveHome.pass_accuracy}
                  awayDisplay={liveAway.pass_accuracy}
                  homeTooltip={`${homeTeamName}: ${liveHome.pass_accuracy} pass accuracy`}
                  awayTooltip={`${awayTeamName}: ${liveAway.pass_accuracy} pass accuracy`}
                />
              )}
              {data.has_live_stats && liveHome.red_cards != null && liveAway.red_cards != null && (
                <StatBar
                  label="Red Cards"
                  tooltip="Red cards heavily change live win probability and goal expectation"
                  homeVal={liveHome.red_cards}
                  awayVal={liveAway.red_cards}
                  homeDisplay={String(liveHome.red_cards)}
                  awayDisplay={String(liveAway.red_cards)}
                  homeTooltip={`${homeTeamName}: ${liveHome.red_cards} red cards`}
                  awayTooltip={`${awayTeamName}: ${liveAway.red_cards} red cards`}
                  higherIsBetter={false}
                />
              )}
              {data.has_live_stats && liveHome.offsides != null && liveAway.offsides != null && (
                <StatBar
                  label="Offsides"
                  tooltip="Offsides can indicate attacking line pressure, but repeated offsides may also mean poor timing"
                  homeVal={liveHome.offsides}
                  awayVal={liveAway.offsides}
                  homeDisplay={String(liveHome.offsides)}
                  awayDisplay={String(liveAway.offsides)}
                  homeTooltip={`${homeTeamName}: ${liveHome.offsides} offsides`}
                  awayTooltip={`${awayTeamName}: ${liveAway.offsides} offsides`}
                />
              )}
              {data.has_live_stats && liveHome.shots_outside_box != null && liveAway.shots_outside_box != null && (
                <StatBar
                  label="Shots Outside Box"
                  tooltip="Long-range shots usually carry lower xG than shots inside the penalty area"
                  homeVal={liveHome.shots_outside_box}
                  awayVal={liveAway.shots_outside_box}
                  homeDisplay={String(liveHome.shots_outside_box)}
                  awayDisplay={String(liveAway.shots_outside_box)}
                  homeTooltip={`${homeTeamName}: ${liveHome.shots_outside_box} shots outside the box`}
                  awayTooltip={`${awayTeamName}: ${liveAway.shots_outside_box} shots outside the box`}
                />
              )}
              {data.has_live_stats && liveHome.total_passes != null && liveAway.total_passes != null && (
                <StatBar
                  label="Total Passes"
                  tooltip="Total passes can show control and territorial dominance when combined with pass accuracy"
                  homeVal={liveHome.total_passes}
                  awayVal={liveAway.total_passes}
                  homeDisplay={String(liveHome.total_passes)}
                  awayDisplay={String(liveAway.total_passes)}
                  homeTooltip={`${homeTeamName}: ${liveHome.total_passes} total passes`}
                  awayTooltip={`${awayTeamName}: ${liveAway.total_passes} total passes`}
                />
              )}

              {/* Divider if we have both live and season stats */}
              {data.has_live_stats && (
                <div className="border-t border-border/30 pt-2">
                  <div className="text-[9px] font-mono text-muted-foreground/50 uppercase tracking-widest text-center mb-2">Season Averages</div>
                </div>
              )}

              {/* Season stats — always shown */}
              <StatBar
                label="Goals / Game"
                tooltip="Average goals scored per match this season — higher means a more prolific attack"
                homeVal={data.home.goals_per_game}
                awayVal={data.away.goals_per_game}
                homeDisplay={data.home.goals_per_game.toFixed(1)}
                awayDisplay={data.away.goals_per_game.toFixed(1)}
                homeTooltip={`${homeTeamName} score ${data.home.goals_per_game.toFixed(1)} goals per match on average this season`}
                awayTooltip={`${awayTeamName} score ${data.away.goals_per_game.toFixed(1)} goals per match on average this season`}
              />
              <StatBar
                label="Conceded / Game"
                tooltip="Average goals conceded per match this season — lower means a tighter defence"
                homeVal={data.home.conceded_per_game}
                awayVal={data.away.conceded_per_game}
                homeDisplay={data.home.conceded_per_game.toFixed(1)}
                awayDisplay={data.away.conceded_per_game.toFixed(1)}
                higherIsBetter={false}
                homeTooltip={`${homeTeamName} concede ${data.home.conceded_per_game.toFixed(1)} goals per match on average this season`}
                awayTooltip={`${awayTeamName} concede ${data.away.conceded_per_game.toFixed(1)} goals per match on average this season`}
              />
              <StatBar
                label="Clean Sheets"
                tooltip="Matches this season where the team conceded zero goals — a sign of defensive solidity"
                homeVal={data.home.clean_sheets}
                awayVal={data.away.clean_sheets}
                homeDisplay={String(data.home.clean_sheets)}
                awayDisplay={String(data.away.clean_sheets)}
                homeTooltip={`${homeTeamName} have kept ${data.home.clean_sheets} clean sheet${data.home.clean_sheets !== 1 ? "s" : ""} this season`}
                awayTooltip={`${awayTeamName} have kept ${data.away.clean_sheets} clean sheet${data.away.clean_sheets !== 1 ? "s" : ""} this season`}
              />

              {/* W/D/L record */}
              {data.home.matches_played > 0 && (
                <div className="grid grid-cols-3 gap-2 pt-2 border-t border-border/30">
                  {(["wins","draws","losses"] as const).map((key) => {
                    const hv = data.home[key as keyof TeamStats] as number;
                    const av = data.away[key as keyof TeamStats] as number;
                    const label = key === "wins" ? "W" : key === "draws" ? "D" : "L";
                    const color = key === "wins" ? "text-primary" : key === "draws" ? "text-muted-foreground" : "text-chart-2";
                    const tipHome = key === "wins"
                      ? `${homeTeamName} have won ${hv} match${hv !== 1 ? "es" : ""} this season`
                      : key === "draws"
                      ? `${homeTeamName} have drawn ${hv} match${hv !== 1 ? "es" : ""} this season`
                      : `${homeTeamName} have lost ${hv} match${hv !== 1 ? "es" : ""} this season`;
                    const tipAway = key === "wins"
                      ? `${awayTeamName} have won ${av} match${av !== 1 ? "es" : ""} this season`
                      : key === "draws"
                      ? `${awayTeamName} have drawn ${av} match${av !== 1 ? "es" : ""} this season`
                      : `${awayTeamName} have lost ${av} match${av !== 1 ? "es" : ""} this season`;
                    return (
                      <div key={key} className="text-center">
                        <div className="flex justify-between font-mono font-black text-sm">
                          <Tip text={tipHome}><span className={`cursor-default ${color}`}>{hv}</span></Tip>
                          <span className="text-muted-foreground/40 text-[10px] self-center">{label}</span>
                          <Tip text={tipAway}><span className={`cursor-default ${color}`}>{av}</span></Tip>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

// ─── xG Panel ─────────────────────────────────────────────────────────────

function DivBadge({ value }: { value: number }) {
  const abs = Math.abs(value);
  if (abs < 2) return null;
  const positive = value > 0;
  return (
    <span
      className={`text-[9px] font-mono font-black px-1.5 py-0.5 rounded ${
        positive
          ? "bg-primary/20 text-primary"
          : "bg-chart-2/20 text-chart-2"
      }`}
      title={`Model vs market: ${positive ? "+" : ""}${value.toFixed(1)}%`}
    >
      {positive ? "+" : ""}{value.toFixed(1)}%
    </span>
  );
}

function XGPanel({
  matchId,
  homeTeamName,
  awayTeamName,
  marketHome,
  marketDraw,
  marketAway,
}: {
  matchId: number;
  homeTeamName: string;
  awayTeamName: string;
  marketHome?: number | null;
  marketDraw?: number | null;
  marketAway?: number | null;
}) {
  const statsPollInterval = useMatchPollInterval(matchId, 15000);
  const { data, isLoading } = useGetMatchStats(matchId, {
    query: { refetchInterval: statsPollInterval, queryKey: getGetMatchStatsQueryKey(matchId) },
  });

  if (isLoading) return null;
  if (!data || data.home.matches_played === 0 || data.away.matches_played === 0) return null;

  const xg = computeXG(
    data.home.goals_per_game,
    data.home.conceded_per_game,
    data.away.goals_per_game,
    data.away.conceded_per_game
  );

  const enhanced: any = (data as any).enhanced;
  const modelHome = enhanced?.home_win ?? xg.homeWin;
  const modelDraw = enhanced?.draw ?? xg.draw;
  const modelAway = enhanced?.away_win ?? xg.awayWin;
  const divHome = divergence(modelHome, marketHome);
  const divDraw = divergence(modelDraw, marketDraw);
  const divAway = divergence(modelAway, marketAway);

  const xgTotal = xg.homeXG + xg.awayXG;
  const homeXGPct = xgTotal > 0 ? (xg.homeXG / xgTotal) * 100 : 50;

  return (
    <Card className="border-border/50 overflow-hidden" data-testid="panel-xg">
      <div className="p-5 space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <BarChart2 className="w-4 h-4 text-muted-foreground" />
            <span className="font-mono text-sm font-bold uppercase tracking-widest text-muted-foreground">
              xG Model
            </span>
          </div>
          <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wider">
            Poisson · +10% home adv
          </span>
        </div>

        {/* xG numbers */}
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
          <div>
            <div className="text-[10px] font-mono text-muted-foreground/60 uppercase tracking-wider mb-1">
              {homeTeamName}
            </div>
            <Tip text={`${homeTeamName} xG: ${xg.homeXG.toFixed(2)} — Expected Goals, the number of goals this team's season scoring rate suggests they should score in this match. Above 1.5 signals a strong attacking threat.`}>
              <div className="text-3xl font-mono font-black text-primary leading-none cursor-default">
                {xg.homeXG.toFixed(2)}
              </div>
            </Tip>
            <div className="text-[9px] font-mono text-muted-foreground/50 mt-0.5">xG</div>
          </div>
          <div className="text-center font-mono text-muted-foreground/30 text-lg font-black">vs</div>
          <div className="text-right">
            <div className="text-[10px] font-mono text-muted-foreground/60 uppercase tracking-wider mb-1">
              {awayTeamName}
            </div>
            <Tip text={`${awayTeamName} xG: ${xg.awayXG.toFixed(2)} — Expected Goals, the number of goals this team's season scoring rate suggests they should score in this match. Above 1.5 signals a strong attacking threat.`}>
              <div className="text-3xl font-mono font-black text-chart-2 leading-none cursor-default">
                {xg.awayXG.toFixed(2)}
              </div>
            </Tip>
            <div className="text-[9px] font-mono text-muted-foreground/50 mt-0.5">xG</div>
          </div>
        </div>

        {/* xG split bar */}
        <div className="flex h-2 rounded-full overflow-hidden bg-muted">
          <div
            className="bg-primary h-full transition-all duration-700"
            style={{ width: `${homeXGPct}%` }}
          />
          <div
            className="bg-chart-2 h-full transition-all duration-700"
            style={{ width: `${100 - homeXGPct}%` }}
          />
        </div>

        {/* Model outcome probabilities */}
        <div className="space-y-2">
          <div className="text-[9px] font-mono text-muted-foreground/50 uppercase tracking-widest">
            Model Outcome Probabilities
          </div>
          <div className="grid grid-cols-3 gap-2">
            {(
              [
                { label: "Home Win", pct: modelHome, div: divHome, color: "text-primary", barColor: "bg-primary" },
                { label: "Draw",     pct: modelDraw, div: divDraw, color: "text-muted-foreground", barColor: "bg-muted-foreground" },
                { label: "Away Win", pct: modelAway, div: divAway, color: "text-chart-2", barColor: "bg-chart-2" },
              ] as const
            ).map(({ label, pct, div, color, barColor }) => (
              <div key={label} className="space-y-1.5">
                <div className="flex items-center justify-between gap-1">
                  <span className="text-[9px] font-mono text-muted-foreground/60 uppercase tracking-wider truncate">
                    {label}
                  </span>
                  {div != null && <DivBadge value={div} />}
                </div>
                <Tip
                  text={`${label}: Poisson model probability ${pct.toFixed(1)}%${div != null && Math.abs(div) >= 2 ? ` — model differs from market by ${div > 0 ? "+" : ""}${div.toFixed(1)}%` : ""}`}
                >
                  <div className={`text-xl font-mono font-black cursor-default ${color}`}>
                    {pct.toFixed(1)}%
                  </div>
                </Tip>
                <div className="h-1 rounded-full bg-muted overflow-hidden">
                  <div className={`${barColor} h-full transition-all duration-700`} style={{ width: `${pct}%` }} />
                </div>
                {div != null && Math.abs(div) >= 2 && (
                  <Tip text="Market-implied probability from the bookmaker's odds — compare with the model figure above">
                    <div className="text-[8px] font-mono text-muted-foreground/40 cursor-default">
                      mkt {(pct - div).toFixed(1)}%
                    </div>
                  </Tip>
                )}
              </div>
            ))}
          </div>
        </div>


        {enhanced && (
          <div className="space-y-3 pt-2 border-t border-border/30">
            <div className="flex items-center justify-between">
              <div className="text-[9px] font-mono text-muted-foreground/50 uppercase tracking-widest">Enhanced AI Markets</div>
              <div className="text-[10px] font-mono font-black text-primary">{enhanced.confidence} · {enhanced.confidence_score}%</div>
            </div>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-lg bg-muted/40 p-2"><div className="text-[8px] uppercase text-muted-foreground">Over 2.5</div><div className="font-mono font-black">{enhanced.over_25?.toFixed?.(1) ?? enhanced.over_25}%</div></div>
              <div className="rounded-lg bg-muted/40 p-2"><div className="text-[8px] uppercase text-muted-foreground">BTTS</div><div className="font-mono font-black">{enhanced.btts?.toFixed?.(1) ?? enhanced.btts}%</div></div>
              <div className="rounded-lg bg-muted/40 p-2"><div className="text-[8px] uppercase text-muted-foreground">Fair H</div><div className="font-mono font-black">{enhanced.fair_home_odds}</div></div>
            </div>
            {(enhanced.market_blend || enhanced.goal_market_blend) && enhanced.independent && (
              <div className="rounded-lg border border-primary/25 bg-primary/5 p-2 text-[10px] text-muted-foreground" data-testid="market-blend-note">
                <span className="font-semibold text-primary">Includes bookmaker odds</span>
                {enhanced.market_blend ? ` for the result (${enhanced.market_blend.bookmakers} book${enhanced.market_blend.bookmakers === 1 ? '' : 's'})` : ''}
                {enhanced.goal_market_blend ? `${enhanced.market_blend ? ' and' : ' for'} ${enhanced.goal_market_blend.markets.map((m: string) => m === 'over_25' ? 'over 2.5' : 'both teams to score').join(' and ')}` : ''}
                , the most accurate pre-match estimates in testing.
                {enhanced.market_blend ? ` Model alone: H ${Number(enhanced.independent.home).toFixed(1)}% · D ${Number(enhanced.independent.draw).toFixed(1)}% · A ${Number(enhanced.independent.away).toFixed(1)}%.` : ''}
                {enhanced.goal_market_blend && enhanced.independent.over_25 != null ? ` Model over 2.5: ${Number(enhanced.independent.over_25).toFixed(1)}%.` : ''}
                {enhanced.goal_market_blend && enhanced.independent.btts != null ? ` Model BTTS: ${Number(enhanced.independent.btts).toFixed(1)}%.` : ''}
                {' '}Value flags compare the odds-free model with the price.
              </div>
            )}
            {enhanced.market_informed && (
              <div className="rounded-lg border border-border/40 p-2 space-y-1" data-testid="market-informed">
                <div className="flex items-center justify-between">
                  <div className="text-[8px] uppercase tracking-widest text-muted-foreground">With bookmaker odds{enhanced.market_informed.phase === 'live' ? ' · live' : ''}</div>
                  <div className="text-[8px] font-mono text-muted-foreground/60">{enhanced.market_informed.bookmakers} book{enhanced.market_informed.bookmakers === 1 ? '' : 's'}</div>
                </div>
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div><div className="text-[8px] uppercase text-muted-foreground">Home</div><div className="font-mono font-black">{enhanced.market_informed.home.toFixed(1)}%</div></div>
                  <div><div className="text-[8px] uppercase text-muted-foreground">Draw</div><div className="font-mono font-black">{enhanced.market_informed.draw.toFixed(1)}%</div></div>
                  <div><div className="text-[8px] uppercase text-muted-foreground">Away</div><div className="font-mono font-black">{enhanced.market_informed.away.toFixed(1)}%</div></div>
                </div>
                <div className="text-[9px] text-muted-foreground/70">
                  {enhanced.market_informed.phase === 'live'
                    ? 'Live prices at the current score, updated within 2 minutes. On trial: scored against results before it is relied on.'
                    : 'Most accurate "who wins" estimate in testing. Value flags below still use the independent model.'}
                </div>
              </div>
            )}
            {enhanced.odds_movement?.points?.length >= 2 && (
              <div className="rounded-lg border border-border/40 p-2 space-y-1" data-testid="odds-movement">
                <div className="text-[8px] uppercase tracking-widest text-muted-foreground">Odds movement (bookmaker chance)</div>
                <div className="grid gap-1 text-center" style={{ gridTemplateColumns: `3rem repeat(${enhanced.odds_movement.points.length}, minmax(0, 1fr))` }}>
                  <div />
                  {enhanced.odds_movement.points.map((p: any) => (
                    <div key={p.label} className="text-[8px] uppercase text-muted-foreground">{p.label}</div>
                  ))}
                  {(['home', 'draw', 'away'] as const).map((side) => (
                    <Fragment key={side}>
                      <div className={`text-[9px] uppercase text-left ${enhanced.odds_movement.shortening === side ? 'text-primary font-bold' : enhanced.odds_movement.drifting === side ? 'text-amber-500' : 'text-muted-foreground'}`}>
                        {side}{enhanced.odds_movement.shortening === side ? ' ↑' : enhanced.odds_movement.drifting === side ? ' ↓' : ''}
                      </div>
                      {enhanced.odds_movement.points.map((p: any) => (
                        <div key={p.label} className="font-mono text-[11px]">{Number(p[side]).toFixed(1)}%</div>
                      ))}
                    </Fragment>
                  ))}
                </div>
              </div>
            )}
            {enhanced.value_edges && (
              <div className="text-[10px] text-muted-foreground" data-testid="value-experimental-note">
                Value flags are experimental and come from step 9 only (odds-free), never long shots over 6.0 or gaps over 12 points. Closing odds are still more accurate than any model, so a gap is more often model error than real value.
              </div>
            )}
            {enhanced.value_edges && (
              <div className="grid grid-cols-3 gap-2 text-center">
                {[['Home', enhanced.value_edges.home], ['Draw', enhanced.value_edges.draw], ['Away', enhanced.value_edges.away]].map(([label, edge]: any) => edge && (
                  <div key={label} className={`rounded-lg p-2 ${edge.is_value ? 'bg-primary/15' : 'bg-muted/30'}`}>
                    <div className="text-[8px] uppercase text-muted-foreground">{label} value</div>
                    <div className="font-mono font-black">{edge.edge_pct > 0 ? '+' : ''}{edge.edge_pct}%</div>
                    {edge.excluded && (
                      <div className="text-[8px] text-muted-foreground mt-0.5">{edge.excluded === 'long_shot' ? 'Long shot · not flagged' : 'Gap too large · not flagged'}</div>
                    )}
                    {edge.is_value && enhanced.odds_movement?.drifting === String(label).toLowerCase() && (
                      <div className="text-[8px] text-amber-500 mt-0.5" data-testid="value-drift-warning">Odds drifting · caution</div>
                    )}
                  </div>
                ))}
              </div>
            )}
            {enhanced.value_edges && enhanced.odds_movement?.drifting && (
              <div className="text-[9px] text-muted-foreground/70">
                Backing a side whose odds are drifting lost value against the closing price in testing.
              </div>
            )}
            {enhanced.correct_scores?.length > 0 && (
              <div className="flex gap-1 flex-wrap">
                {enhanced.correct_scores.slice(0, 4).map((s: any) => (
                  <span key={s.score} className="text-[10px] font-mono px-2 py-1 rounded-full bg-muted/50">{s.score} · {s.probability}%</span>
                ))}
              </div>
            )}
            {enhanced.live_momentum && (() => {
              const momentum = enhanced.live_momentum;
              const clampPct = (value: unknown, fallback: number) => {
                const n = Number(value);
                return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : fallback;
              };
              const homeRaw = clampPct(momentum.home_momentum_pct, 50);
              const awayRaw = clampPct(momentum.away_momentum_pct, 100 - homeRaw);
              const totalMomentum = homeRaw + awayRaw || 100;
              const homeMomentum = Math.max(0, Math.min(100, (homeRaw / totalMomentum) * 100));
              const awayMomentum = 100 - homeMomentum;
              const homePressure = clampPct(momentum.home_pressure, 0);
              const awayPressure = clampPct(momentum.away_pressure, 0);
              const nextHome = clampPct(momentum.next_goal_home, homeMomentum);
              const nextAway = clampPct(momentum.next_goal_away, 100 - nextHome);
              const label = momentum.momentum_label ?? (Math.abs(homeMomentum - awayMomentum) < 8 ? 'Balanced' : homeMomentum > awayMomentum ? `${homeTeamName} on top` : `${awayTeamName} on top`);
              return (
                <div className="rounded-lg bg-destructive/10 p-3 text-[10px] font-mono space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[9px] uppercase tracking-widest text-muted-foreground">Live Match Momentum</div>
                    <div className="font-black text-foreground">{label}</div>
                  </div>
                  <Tip text="Momentum is calculated from live xG, shots on target, shots inside the box, corners, dangerous attacks, possession, pass accuracy, recent events and card impact. It refreshes during live matches.">
                    <div className="space-y-1 cursor-default">
                      <div className="flex justify-between text-[10px] font-black">
                        <span>{homeTeamName} {homeMomentum.toFixed(0)}%</span>
                        <span>{awayMomentum.toFixed(0)}% {awayTeamName}</span>
                      </div>
                      <div className="h-4 rounded-full overflow-hidden bg-muted flex ring-1 ring-border/40">
                        <div className="h-full bg-primary transition-all duration-700" style={{ width: `${homeMomentum}%` }} />
                        <div className="h-full bg-chart-2 transition-all duration-700" style={{ width: `${awayMomentum}%` }} />
                      </div>
                    </div>
                  </Tip>
                  <div className="grid grid-cols-3 gap-2 text-center">
                    <div className="rounded-md bg-background/40 p-1.5"><div className="text-[8px] uppercase text-muted-foreground">Pressure</div><div className="font-black">{homePressure.toFixed(0)} / {awayPressure.toFixed(0)}</div></div>
                    <div className="rounded-md bg-background/40 p-1.5"><div className="text-[8px] uppercase text-muted-foreground">Next Goal</div><div className="font-black">H {nextHome.toFixed(0)}% / A {nextAway.toFixed(0)}%</div></div>
                    <div className="rounded-md bg-background/40 p-1.5"><div className="text-[8px] uppercase text-muted-foreground">Feed</div><div className="font-black">{momentum.data_quality === 'enhanced' ? 'Enhanced' : 'Basic'}</div></div>
                  </div>
                  {momentum.home_attacking_index != null && (
                    <div>Attack index: H {momentum.home_attacking_index}% / A {momentum.away_attacking_index}%</div>
                  )}
                  {momentum.pressure_alert && <div className="font-bold">{momentum.pressure_alert}</div>}
                </div>
              );
            })()}
            {enhanced.reasons?.length > 0 && (
              <ul className="space-y-1 text-[10px] font-mono text-muted-foreground">
                {enhanced.reasons.map((r: string, i: number) => <li key={i}>• {r}</li>)}
              </ul>
            )}
          </div>
        )}

        {/* Model vs market comparison bar — only when odds exist */}
        {marketHome != null && (
          <div className="space-y-1.5 pt-1 border-t border-border/30">
            <div className="flex justify-between text-[9px] font-mono text-muted-foreground/50 uppercase tracking-widest">
              <span>Model</span>
              <span>Market</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="flex h-3 rounded-full overflow-hidden bg-muted">
                <div className="bg-primary h-full" style={{ width: `${modelHome}%` }} />
                <div className="bg-muted-foreground h-full" style={{ width: `${modelDraw}%` }} />
                <div className="bg-chart-2 h-full" style={{ width: `${modelAway}%` }} />
              </div>
              <div className="flex h-3 rounded-full overflow-hidden bg-muted">
                <div className="bg-primary/70 h-full" style={{ width: `${marketHome ?? 0}%` }} />
                <div className="bg-muted-foreground/70 h-full" style={{ width: `${marketDraw ?? 0}%` }} />
                <div className="bg-chart-2/70 h-full" style={{ width: `${marketAway ?? 0}%` }} />
              </div>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

// ─── Head-to-Head ─────────────────────────────────────────────────────────

// ─── Event type helpers ────────────────────────────────────────────────────

function EventIcon({ type, detail }: { type: string; detail: string }) {
  if (type === "goal") {
    if (detail.toLowerCase().includes("own")) {
      return <span className="text-base leading-none" title="Own Goal">⚽️</span>;
    }
    if (detail.toLowerCase().includes("penalty")) {
      return <span className="text-base leading-none" title="Penalty">⚽️</span>;
    }
    return <span className="text-base leading-none" title="Goal">⚽️</span>;
  }
  if (type === "yellow_card") return <span className="text-base leading-none" title="Yellow Card">🟨</span>;
  if (type === "red_card") return <span className="text-base leading-none" title="Red Card">🟥</span>;
  if (type === "yellow_red_card") return <div className="flex -space-x-1 leading-none" title="2nd Yellow / Red"><span>🟨</span><span>🟥</span></div>;
  if (type === "substitution") return <span className="text-base leading-none" title="Substitution">🔄</span>;
  if (type === "var") return <span className="text-[11px] font-black font-mono bg-muted px-1 rounded text-muted-foreground" title="VAR">VAR</span>;
  return null;
}

function EventLabel({ event }: { event: MatchEvent }) {
  if (event.type === "substitution") {
    return (
      <div className="text-xs leading-snug">
        <span className="text-green-400 font-medium">{event.player}</span>
        {event.assist && <><br /><span className="text-muted-foreground line-through text-[10px]">{event.assist}</span></>}
      </div>
    );
  }
  if (event.type === "goal") {
    const isOwn = event.detail.toLowerCase().includes("own");
    return (
      <div className="text-xs leading-snug">
        <span className={`font-semibold ${isOwn ? "text-chart-2" : "text-foreground"}`}>{event.player}</span>
        {event.assist && <span className="text-muted-foreground text-[10px]"> ({event.assist})</span>}
        {isOwn && <span className="text-[10px] text-chart-2 ml-1">OG</span>}
        {event.detail.toLowerCase().includes("penalty") && <span className="text-[10px] text-yellow-400 ml-1">PEN</span>}
      </div>
    );
  }
  return (
    <div className="text-xs leading-snug">
      <span className="font-medium text-foreground">{event.player}</span>
    </div>
  );
}

function MinuteMarker({ minute, extra }: { minute: number; extra?: number | null }) {
  return (
    <div className="flex flex-col items-center">
      <div className="w-7 h-7 rounded-full bg-muted border border-border flex items-center justify-center">
        <span className="font-mono text-[9px] font-black text-muted-foreground leading-none">
          {minute}{extra ? `+${extra}` : ""}′
        </span>
      </div>
      <div className="w-px flex-1 bg-border/50 min-h-[8px]" />
    </div>
  );
}

function MatchTimeline({ matchId, homeTeamName, awayTeamName }: {
  matchId: number;
  homeTeamName: string;
  awayTeamName: string;
}) {
  const eventsPollInterval = useMatchPollInterval(matchId, 30000);
  const { data, isLoading } = useGetMatchEvents(matchId, {
    query: {
      refetchInterval: eventsPollInterval,
      queryKey: getGetMatchEventsQueryKey(matchId),
    },
  });

  const events = data?.events ?? [];

  // Split into halves based on minute: 1-45(+) = 1st, 46+ = 2nd/ET
  const firstHalf = events.filter((e) => e.minute <= 45);
  const secondHalf = events.filter((e) => e.minute > 45);

  const renderEvents = (evts: MatchEvent[]) => {
    if (evts.length === 0) return null;
    return evts.map((e, i) => {
      const isHome = e.team_side === "home";
      return (
        <div key={i} className="grid grid-cols-[1fr_40px_1fr] items-start gap-1">
          {/* Home side */}
          <div className={`flex items-start gap-1.5 ${isHome ? "justify-end" : ""}`}>
            {isHome && (
              <>
                <EventLabel event={e} />
                <div className="flex-shrink-0 mt-0.5"><EventIcon type={e.type} detail={e.detail} /></div>
              </>
            )}
          </div>

          {/* Minute in center */}
          <div className="flex justify-center">
            <MinuteMarker minute={e.minute} extra={e.extra_time} />
          </div>

          {/* Away side */}
          <div className={`flex items-start gap-1.5 ${!isHome ? "justify-start" : ""}`}>
            {!isHome && (
              <>
                <div className="flex-shrink-0 mt-0.5"><EventIcon type={e.type} detail={e.detail} /></div>
                <EventLabel event={e} />
              </>
            )}
          </div>
        </div>
      );
    });
  };

  return (
    <Card className="border-border/50 overflow-hidden" data-testid="panel-timeline">
      <div className="p-5 space-y-4">
        {/* Header */}
        <div className="flex items-center gap-2">
          <Clock className="w-4 h-4 text-muted-foreground" />
          <span className="font-mono text-sm font-bold uppercase tracking-widest text-muted-foreground">Timeline</span>
        </div>

        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => <Skeleton key={i} className="h-8 w-full" />)}
          </div>
        ) : events.length === 0 ? (
          <p className="text-xs text-muted-foreground font-mono py-4 text-center">
            No events recorded yet.
          </p>
        ) : (
          <div className="space-y-1">
            {/* Team headers */}
            <div className="grid grid-cols-[1fr_40px_1fr] mb-3">
              <div className="text-right text-[10px] font-mono font-bold text-muted-foreground uppercase tracking-wider pr-2">{homeTeamName}</div>
              <div />
              <div className="text-left text-[10px] font-mono font-bold text-muted-foreground uppercase tracking-wider pl-2">{awayTeamName}</div>
            </div>

            {/* 1st Half */}
            {firstHalf.length > 0 && (
              <>
                <div className="grid grid-cols-[1fr_40px_1fr] my-2">
                  <div className="border-t border-border/40 self-center" />
                  <div className="text-center text-[9px] font-mono text-muted-foreground/60 uppercase tracking-widest whitespace-nowrap">1ST</div>
                  <div className="border-t border-border/40 self-center" />
                </div>
                {renderEvents(firstHalf)}
              </>
            )}

            {/* 2nd Half / ET */}
            {secondHalf.length > 0 && (
              <>
                <div className="grid grid-cols-[1fr_40px_1fr] my-2">
                  <div className="border-t border-border/40 self-center" />
                  <div className="text-center text-[9px] font-mono text-muted-foreground/60 uppercase tracking-widest whitespace-nowrap">2ND</div>
                  <div className="border-t border-border/40 self-center" />
                </div>
                {renderEvents(secondHalf)}
              </>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

function DeltaBadge({ market, history }: { market: number; history: number }) {
  const delta = Math.round((market - history) * 10) / 10;
  if (Math.abs(delta) < 1) return <span className="text-[10px] font-mono text-muted-foreground/60">~flat</span>;
  const positive = delta > 0;
  return (
    <span className={`text-[10px] font-mono flex items-center gap-0.5 ${positive ? "text-primary" : "text-chart-2"}`}>
      {positive ? <TrendingUp className="w-2.5 h-2.5" /> : <TrendingDown className="w-2.5 h-2.5" />}
      {positive ? "+" : ""}{delta}%
    </span>
  );
}

function ProbBar({ home, draw, away, thin }: { home: number; draw: number; away: number; thin?: boolean }) {
  return (
    <div className={`flex w-full overflow-hidden rounded-full bg-muted ${thin ? "h-1.5" : "h-3"}`}>
      <div className="bg-primary h-full transition-all duration-700" style={{ width: `${home}%` }} />
      <div className="bg-muted-foreground/50 h-full transition-all duration-700" style={{ width: `${draw}%` }} />
      <div className="bg-chart-2 h-full transition-all duration-700" style={{ width: `${away}%` }} />
    </div>
  );
}

function HalftimeOverlay({
  htHome,
  htAway,
  marketHome,
  marketDraw,
  marketAway,
  homeTeam,
  awayTeam,
}: {
  htHome: number;
  htAway: number;
  marketHome: number | null | undefined;
  marketDraw: number | null | undefined;
  marketAway: number | null | undefined;
  homeTeam: string;
  awayTeam: string;
}) {
  const { data: backtest, isLoading } = useGetBacktest(
    {},
    { query: { queryKey: getGetBacktestQueryKey({}) } }
  );

  const key = `${htHome}-${htAway}`;
  const scenario: BacktestScenario | undefined = backtest?.scenarios.find(
    (s) => s.halftime_score === key
  );

  const leadIcon =
    htHome > htAway ? (
      <TrendingUp className="w-3.5 h-3.5 text-primary" />
    ) : htAway > htHome ? (
      <TrendingDown className="w-3.5 h-3.5 text-chart-2" />
    ) : (
      <Minus className="w-3.5 h-3.5 text-muted-foreground" />
    );

  return (
    <Card className="border-border/50 border-l-4 border-l-chart-3 overflow-hidden" data-testid="panel-ht-overlay">
      <div className="p-5 space-y-5">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <BarChart2 className="w-4 h-4 text-chart-3" />
            <span className="font-mono text-sm font-bold uppercase tracking-widest text-muted-foreground">
              HT Overlay
            </span>
          </div>
          <div className="flex items-center gap-1.5 font-mono text-sm font-black">
            {leadIcon}
            <span className="text-foreground">{htHome} – {htAway}</span>
            <span className="text-muted-foreground text-xs ml-1">at HT</span>
          </div>
        </div>

        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
          </div>
        ) : !scenario ? (
          <p className="text-xs text-muted-foreground font-mono">No historical data for this score yet.</p>
        ) : (
          <>
            {/* Column headers */}
            <div className="grid grid-cols-3 gap-2 text-[10px] font-mono text-muted-foreground uppercase tracking-wider text-center">
              <span className="text-primary">Home Win</span>
              <span>Draw</span>
              <span className="text-chart-2">Away Win</span>
            </div>

            {/* Market row */}
            <div className="space-y-1.5">
              <div className="text-[10px] font-mono text-muted-foreground/70 uppercase tracking-wider">Market (odds)</div>
              {marketHome != null && marketDraw != null && marketAway != null ? (
                <>
                  <div className="grid grid-cols-3 gap-2 text-center">
                    <span className="font-mono font-bold text-primary text-sm">{marketHome.toFixed(1)}%</span>
                    <span className="font-mono font-bold text-muted-foreground text-sm">{marketDraw.toFixed(1)}%</span>
                    <span className="font-mono font-bold text-chart-2 text-sm">{marketAway.toFixed(1)}%</span>
                  </div>
                  <ProbBar home={marketHome} draw={marketDraw} away={marketAway} thin />
                </>
              ) : (
                <p className="text-xs text-muted-foreground font-mono">No market odds available.</p>
              )}
            </div>

            {/* History row */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-mono text-muted-foreground/70 uppercase tracking-wider">
                  History ({scenario.match_count} matches, {backtest?.season}/{String((backtest?.season ?? 2024) + 1).slice(2)})
                </span>
              </div>
              <div className="grid grid-cols-3 gap-2 text-center">
                <span className="font-mono font-bold text-primary text-sm">{scenario.home_win_pct}%</span>
                <span className="font-mono font-bold text-muted-foreground text-sm">{scenario.draw_pct}%</span>
                <span className="font-mono font-bold text-chart-2 text-sm">{scenario.away_win_pct}%</span>
              </div>
              <ProbBar home={scenario.home_win_pct} draw={scenario.draw_pct} away={scenario.away_win_pct} thin />
            </div>

            {/* Delta row — only when market data exists */}
            {marketHome != null && marketDraw != null && marketAway != null && (
              <div className="pt-3 border-t border-border/40 space-y-1">
                <div className="text-[10px] font-mono text-muted-foreground/70 uppercase tracking-wider">Market vs History</div>
                <div className="grid grid-cols-3 gap-2 text-center">
                  <DeltaBadge market={marketHome} history={scenario.home_win_pct} />
                  <DeltaBadge market={marketDraw} history={scenario.draw_pct} />
                  <DeltaBadge market={marketAway} history={scenario.away_win_pct} />
                </div>
                <p className="text-[10px] text-muted-foreground/50 font-mono mt-2">
                  Positive = market prices this outcome higher than history suggests
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  );
}

type MatchExplanation = {
  servingModel: string;
  flags: Array<{ code: string; severity: "info" | "warning"; message: string }>;
  explanation: string;
  explanationSource: "claude" | "template";
};

/** Plan step 8: plain-English reading of the forecast plus data checks. Never changes a number. */
function ExplanationCard({ matchId, status }: { matchId: number; status: string }) {
  const enabled = status === "upcoming" || status === "live";
  const { data } = useQuery({
    queryKey: ["match-explanation", matchId],
    enabled,
    staleTime: 15 * 60_000,
    queryFn: async () => {
      const res = await fetch(`/api/matches/${matchId}/explanation`, { headers: { Accept: "application/json" } });
      if (!res.ok) return null;
      return (await res.json()) as MatchExplanation;
    },
  });
  if (!enabled || !data) return null;
  return (
    <Card className="p-4 border-border/60" data-testid="match-explanation">
      <div className="flex items-center justify-between gap-2 mb-2">
        <h2 className="font-bold text-sm">Why this prediction</h2>
        <span className="text-[10px] font-mono text-muted-foreground uppercase">
          {data.explanationSource === "claude" ? "Explained by Claude" : "Summary"} · model {data.servingModel}
        </span>
      </div>
      <p className="text-sm leading-relaxed">{data.explanation}</p>
      {data.flags.length > 0 && (
        <ul className="mt-3 space-y-1">
          {data.flags.map((flag) => (
            <li key={flag.code} className={`text-xs ${flag.severity === "warning" ? "text-amber-500" : "text-muted-foreground"}`}>
              {flag.message}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-[10px] text-muted-foreground">Explanations describe the model's numbers; they never change them.</p>
    </Card>
  );
}

type BettingAnalysisData = {
  phase: "pre-match" | "live" | "finished";
  minute: number | null;
  score: { home: number | null; away: number | null };
  teams: { home: string; away: string };
  current: { home: number; draw: number; away: number } | null;
  kickoff: { home: number; draw: number; away: number } | null;
  change: { home: number; draw: number; away: number } | null;
  pick: { outcome: "home" | "draw" | "away"; label: string; percent: number; strength: string } | null;
  timeline: Array<{ minute: number; home: number; draw: number; away: number }>;
  bookmakers: { home: number; draw: number; away: number; source: string; updated_at: string | null } | null;
  note: string;
};

/** Small line chart of home/draw/away chances through the match. */
function AnalysisTimeline({ points }: { points: BettingAnalysisData["timeline"] }) {
  if (points.length < 2) return null;
  const W = 320, H = 90, maxMin = Math.max(90, ...points.map((p) => p.minute));
  const x = (m: number) => (m / maxMin) * W;
  const y = (v: number) => H - (v / 100) * H;
  const line = (k: "home" | "draw" | "away") => points.map((p, i) => `${i ? "L" : "M"}${x(p.minute).toFixed(1)},${y(p[k]).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H + 12}`} className="w-full h-24" role="img" aria-label="Win, draw and lose chances through the match">
      {[25, 50, 75].map((v) => <line key={v} x1={0} x2={W} y1={y(v)} y2={y(v)} className="stroke-border" strokeWidth={0.5} strokeDasharray="2 3" />)}
      <line x1={x(45)} x2={x(45)} y1={0} y2={H} className="stroke-border" strokeWidth={0.5} />
      <path d={line("home")} fill="none" className="stroke-primary" strokeWidth={2} />
      <path d={line("draw")} fill="none" className="stroke-muted-foreground" strokeWidth={1.5} />
      <path d={line("away")} fill="none" className="stroke-chart-2" strokeWidth={2} />
      <text x={0} y={H + 10} className="fill-muted-foreground" fontSize={8}>KO</text>
      <text x={x(45) - 6} y={H + 10} className="fill-muted-foreground" fontSize={8}>HT</text>
      <text x={W - 14} y={H + 10} className="fill-muted-foreground" fontSize={8}>{maxMin}'</text>
    </svg>
  );
}

/** Who our prediction says wins, draws or loses — before and during the match. */
function BettingAnalysisCard({ matchId, status }: { matchId: number; status: string }) {
  const { data } = useQuery({
    queryKey: ["betting-analysis", matchId],
    refetchInterval: status === "live" ? 30_000 : status === "upcoming" ? 5 * 60_000 : false,
    queryFn: async () => {
      const res = await fetch(`/api/matches/${matchId}/betting-analysis`, { headers: { Accept: "application/json" } });
      if (!res.ok) return null;
      return (await res.json()) as BettingAnalysisData;
    },
  });
  if (!data) return null;
  const shown = data.current ?? data.kickoff;
  const rows: Array<["home" | "draw" | "away", string, string]> = [
    ["home", data.teams.home, "bg-primary"],
    ["draw", "Draw", "bg-muted-foreground"],
    ["away", data.teams.away, "bg-chart-2"],
  ];
  const heading = data.phase === "live" ? `Live${data.minute != null ? ` · ${data.minute}'` : ""}` : data.phase === "pre-match" ? "Before kick-off" : "Full time";
  return (
    <Card className="p-4 border-border/60" data-testid="betting-analysis">
      <div className="flex items-center justify-between gap-2 mb-2">
        <h2 className="font-bold text-sm">Betting analysis</h2>
        <span className={`text-[10px] font-mono uppercase ${data.phase === "live" ? "text-red-500" : "text-muted-foreground"}`}>{heading}</span>
      </div>
      <p className="text-sm font-semibold leading-snug" data-testid="betting-analysis-note">{data.note}</p>
      {shown && (
        <div className="mt-3 space-y-2">
          {rows.map(([k, label, color]) => {
            const change = data.change?.[k];
            return (
              <div key={k}>
                <div className="flex items-center justify-between text-xs">
                  <span className={data.pick?.outcome === k ? "font-bold" : "text-muted-foreground"}>{label}</span>
                  <span className="font-mono">
                    {shown[k].toFixed(1)}%
                    {change != null && Math.abs(change) >= 0.5 && (
                      <span className={`ml-2 text-[10px] ${change > 0 ? "text-emerald-500" : "text-red-500"}`}>{change > 0 ? "▲" : "▼"}{Math.abs(change).toFixed(1)}</span>
                    )}
                    {data.bookmakers && <span className="ml-2 text-[10px] text-muted-foreground">odds {data.bookmakers[k].toFixed(0)}%</span>}
                  </span>
                </div>
                <div className="h-1.5 rounded bg-muted overflow-hidden"><div className={`h-full ${color}`} style={{ width: `${Math.max(0, Math.min(100, shown[k]))}%` }} /></div>
              </div>
            );
          })}
        </div>
      )}
      {data.timeline.length >= 2 && (
        <div className="mt-3">
          <div className="text-[10px] uppercase text-muted-foreground mb-1">How it has moved{data.kickoff ? " since kick-off" : ""}</div>
          <AnalysisTimeline points={data.timeline} />
        </div>
      )}
      {data.phase === "live" && data.kickoff && (
        <p className="mt-2 text-[10px] text-muted-foreground">At kick-off: {data.teams.home} {data.kickoff.home.toFixed(0)}% · draw {data.kickoff.draw.toFixed(0)}% · {data.teams.away} {data.kickoff.away.toFixed(0)}%. ▲▼ show the change since then.</p>
      )}
      <p className="mt-2 text-[10px] text-muted-foreground">
        {data.bookmakers ? `"Odds" is what ${data.bookmakers.source} imply, shown for comparison. ` : ""}
        Percentages are estimates, not guarantees. Please bet responsibly.
      </p>
    </Card>
  );
}

export default function MatchDetail() {
  const oddsFormat = useOddsFormat();
  const params = useParams();
  const matchId = Number(params.id);

  const { data: match, isLoading, isError } = useGetMatch(matchId, {
    query: {
      enabled: !isNaN(matchId),
      refetchInterval: (query) => {
        const status = (query.state.data as { status?: string } | undefined)?.status;
        return status === "finished" || status === "cancelled" ? false : 15000;
      },
      queryKey: getGetMatchQueryKey(matchId),
    },
  });

  if (isNaN(matchId)) return <div>Invalid match ID</div>;

  if (isLoading) {
    return (
      <div className="max-w-4xl mx-auto space-y-6">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-64 w-full" />
        <div className="grid grid-cols-3 gap-4">
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
      </div>
    );
  }

  if (isError || !match) {
    return (
      <div className="max-w-4xl mx-auto py-12 text-center text-destructive">
        Error loading match details.
      </div>
    );
  }

  const isLive = match.status === "live";
  const isSecondHalf = isLive && ["2H", "ET", "BT", "HT"].includes(match.status_detail);
  const hasHtScore = match.score_ht?.home != null && match.score_ht?.away != null;
  const showOverlay = isSecondHalf && hasHtScore;

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <Link href="/" className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground transition-colors mb-2">
        <ArrowLeft className="w-4 h-4 mr-2" />
        Back to Dashboard
      </Link>

      <div className="flex items-center gap-3 text-sm text-muted-foreground uppercase tracking-wider mb-6 font-semibold">
        {match.league_logo ? (
          <img src={match.league_logo} alt="" className="w-5 h-5 object-contain" />
        ) : (
          <Trophy className="w-4 h-4" />
        )}
        <span>{match.country} / {match.league_name}</span>
      </div>

      <Card className="p-8 border-border/50 bg-card overflow-hidden relative">
        {isLive && <div className="absolute inset-0 bg-destructive/5 pointer-events-none" />}

        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-muted/50 border border-border text-xs font-mono font-bold tracking-widest mb-4">
            {isLive ? (
              <>
                <div className="w-2 h-2 rounded-full bg-destructive pulse-dot" />
                <span className="text-destructive">{match.minute ? `${match.minute}'` : match.status_detail}</span>
              </>
            ) : match.status === "upcoming" ? (
              <span className="text-primary">{format(new Date(match.kickoff), "MMM dd, HH:mm")}</span>
            ) : (
              <span className="text-muted-foreground">{match.status_detail}</span>
            )}
          </div>

          {/* HT score badge when in 2nd half */}
          {hasHtScore && isSecondHalf && (
            <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-muted/30 border border-border/50 text-[11px] font-mono text-muted-foreground ml-2">
              HT: {match.score_ht!.home} – {match.score_ht!.away}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="flex-1 flex flex-col items-center text-center">
            {match.home_team.logo ? (
              <img src={match.home_team.logo} alt="" className="w-20 h-20 sm:w-24 sm:h-24 object-contain mb-4" />
            ) : (
              <div className="w-24 h-24 rounded-full bg-muted mb-4" />
            )}
            <Link href={`/teams/${match.home_team.id}?name=${encodeURIComponent(match.home_team.name)}`} className="text-xl sm:text-2xl font-bold hover:text-primary">{match.home_team.name}<span className="sr-only"> recent results</span></Link>
          </div>

          <div className="flex-shrink-0 px-4 sm:px-8">
            <div className="text-5xl sm:text-7xl font-mono font-black tracking-tighter">
              {(isLive || match.status === "finished") ? (
                <>
                  <span className="text-foreground">{match.score?.home ?? 0}</span>
                  <span className="text-muted-foreground/30 mx-2">-</span>
                  <span className="text-foreground">{match.score?.away ?? 0}</span>
                </>
              ) : (
                <span className="text-muted-foreground/30">VS</span>
              )}
            </div>
          </div>

          <div className="flex-1 flex flex-col items-center text-center">
            {match.away_team.logo ? (
              <img src={match.away_team.logo} alt="" className="w-20 h-20 sm:w-24 sm:h-24 object-contain mb-4" />
            ) : (
              <div className="w-24 h-24 rounded-full bg-muted mb-4" />
            )}
            <Link href={`/teams/${match.away_team.id}?name=${encodeURIComponent(match.away_team.name)}`} className="text-xl sm:text-2xl font-bold hover:text-chart-2">{match.away_team.name}<span className="sr-only"> recent results</span></Link>
          </div>
        </div>
      </Card>

      <BettingAnalysisCard matchId={match.id} status={match.status} />

      <FixtureOddsMovement fixtureId={match.id} kickoff={match.kickoff} status={match.status} />

      <ExplanationCard matchId={match.id} status={match.status} />

      {/* Stats panel — always visible */}
      <MatchStatsPanel
        matchId={match.id}
        homeTeamName={match.home_team.name}
        awayTeamName={match.away_team.name}
      />

      <Link href={`/matches/${match.id}/squad`}>
        <Card className="border-primary/25 bg-primary/5 p-5 transition-colors hover:bg-primary/10" data-testid="link-lineups-player-page">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <Users className="h-5 w-5 text-primary" />
              <div>
                <div className="font-semibold">Team lineups & player stats</div>
                <div className="mt-1 text-xs text-muted-foreground">Starting XI, substitutes, star players and season leaders</div>
              </div>
            </div>
            <span className="font-mono text-xs text-primary">VIEW →</span>
          </div>
        </Card>
      </Link>

      {/* Head-to-head and each team's last 8 matches live on their own page */}
      <Link href={`/matches/${match.id}/form`}>
        <Card className="border-border/50 p-5 transition-colors hover:bg-muted/30" data-testid="link-form-page">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <Swords className="h-5 w-5 text-muted-foreground" />
              <div>
                <div className="font-semibold">Head to head & recent form</div>
                <div className="mt-1 text-xs text-muted-foreground">Previous meetings and each team's last 8 matches in all competitions</div>
              </div>
            </div>
            <span className="font-mono text-xs text-muted-foreground">VIEW →</span>
          </div>
        </Card>
      </Link>

      {/* Match timeline — shows for live and finished matches */}
      {(isLive || match.status === "finished") && (
        <MatchTimeline
          matchId={match.id}
          homeTeamName={match.home_team.name}
          awayTeamName={match.away_team.name}
        />
      )}

      {/* HT Overlay panel — shows only in 2nd half with known HT score */}
      {showOverlay && (
        <HalftimeOverlay
          htHome={match.score_ht!.home!}
          htAway={match.score_ht!.away!}
          marketHome={match.odds?.home_win}
          marketDraw={match.odds?.draw}
          marketAway={match.odds?.away_win}
          homeTeam={match.home_team.name}
          awayTeam={match.away_team.name}
        />
      )}

      {/* xG Model panel — pre-match and live */}
      <XGPanel
        matchId={match.id}
        homeTeamName={match.home_team.name}
        awayTeamName={match.away_team.name}
        marketHome={match.odds?.home_win}
        marketDraw={match.odds?.draw}
        marketAway={match.odds?.away_win}
      />

      {match.odds && (
        <div className="space-y-4">
          <h3 className="font-mono text-sm text-muted-foreground uppercase tracking-widest">
            {isLive ? "Live" : "Pre-Match"} Probabilities & Odds
          </h3>
          <div className="grid grid-cols-3 gap-4">
            <Card className="p-4 border-border/50 border-t-4 border-t-primary bg-card/50" data-testid="card-home-win">
              <div className="text-xs text-muted-foreground uppercase tracking-wider mb-2 font-mono">Home Win</div>
              <Tip text="Bookmaker-implied probability that the home team wins — calculated by converting the odds and adjusting for the overround (bookmaker margin)">
                <div className="text-3xl font-mono font-bold mb-1 cursor-default">{match.odds.home_win?.toFixed(1)}%</div>
              </Tip>
              <Tip text={oddsFormat === "fractional" ? "Fractional bookmaker odds; the fraction is profit per 1 unit staked." : "Decimal bookmaker odds; decimal prices include stake in total return."} side="bottom">
                <div className="text-sm font-mono text-primary bg-primary/10 inline-block px-2 py-0.5 rounded cursor-default">
                  {formatOdds(match.odds.home_odds, oddsFormat)}
                </div>
              </Tip>
            </Card>

            <Card className="p-4 border-border/50 border-t-4 border-t-muted-foreground bg-card/50" data-testid="card-draw">
              <div className="text-xs text-muted-foreground uppercase tracking-wider mb-2 font-mono">Draw</div>
              <Tip text="Bookmaker-implied probability of the match ending level after 90 minutes — calculated from the draw odds minus the overround">
                <div className="text-3xl font-mono font-bold mb-1 text-muted-foreground cursor-default">{match.odds.draw?.toFixed(1)}%</div>
              </Tip>
              <Tip text={oddsFormat === "fractional" ? "Fractional bookmaker odds; the fraction is profit per 1 unit staked." : "Decimal bookmaker odds; decimal prices include stake in total return."} side="bottom">
                <div className="text-sm font-mono bg-muted inline-block px-2 py-0.5 rounded cursor-default">
                  {formatOdds(match.odds.draw_odds, oddsFormat)}
                </div>
              </Tip>
            </Card>

            <Card className="p-4 border-border/50 border-t-4 border-t-chart-2 bg-card/50" data-testid="card-away-win">
              <div className="text-xs text-muted-foreground uppercase tracking-wider mb-2 font-mono">Away Win</div>
              <Tip text="Bookmaker-implied probability that the away team wins — calculated by converting the odds and adjusting for the overround (bookmaker margin)">
                <div className="text-3xl font-mono font-bold mb-1 cursor-default">{match.odds.away_win?.toFixed(1)}%</div>
              </Tip>
              <Tip text={oddsFormat === "fractional" ? "Fractional bookmaker odds; the fraction is profit per 1 unit staked." : "Decimal bookmaker odds; decimal prices include stake in total return."} side="bottom">
                <div className="text-sm font-mono text-chart-2 bg-chart-2/10 inline-block px-2 py-0.5 rounded cursor-default">
                  {formatOdds(match.odds.away_odds, oddsFormat)}
                </div>
              </Tip>
            </Card>
          </div>

          {match.odds.home_win != null && (
            <Card className="p-6 border-border/50">
              <div className="flex justify-between text-sm font-mono mb-2">
                <span className="text-primary font-bold">{match.home_team.name}</span>
                <span className="text-muted-foreground font-bold">DRAW</span>
                <span className="text-chart-2 font-bold">{match.away_team.name}</span>
              </div>
              <div className="w-full flex h-4 rounded-full overflow-hidden bg-muted">
                <div className="bg-primary h-full transition-all duration-1000" style={{ width: `${match.odds.home_win}%` }} />
                <div className="bg-muted-foreground h-full transition-all duration-1000" style={{ width: `${match.odds.draw}%` }} />
                <div className="bg-chart-2 h-full transition-all duration-1000" style={{ width: `${match.odds.away_win}%` }} />
              </div>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
