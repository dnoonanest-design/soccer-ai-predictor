import {
  useGetMatch, getGetMatchQueryKey,
  useGetBacktest, getGetBacktestQueryKey,
  useGetMatchEvents, getGetMatchEventsQueryKey,
  useGetMatchH2H, getGetMatchH2HQueryKey,
  useGetMatchStats, getGetMatchStatsQueryKey,
  BacktestScenario, MatchEvent, H2HMatch, TeamStats,
} from "@workspace/api-client-react";
import { useParams, Link } from "wouter";
import { ArrowLeft, Trophy, TrendingUp, TrendingDown, Minus, BarChart2, Clock, Swords, Activity } from "lucide-react";
import { format } from "date-fns";
import { Skeleton } from "@/components/ui/skeleton";
import { Card } from "@/components/ui/card";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { decimalToFractional } from "@/lib/odds";
import { computeXG, divergence } from "@/lib/xg";

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
  const { data, isLoading } = useGetMatchStats(matchId, {
    query: { refetchInterval: 15000, queryKey: getGetMatchStatsQueryKey(matchId) },
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
  const { data, isLoading } = useGetMatchStats(matchId, {
    query: { refetchInterval: 15000, queryKey: getGetMatchStatsQueryKey(matchId) },
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
            {enhanced.value_edges && (
              <div className="grid grid-cols-3 gap-2 text-center">
                {[['Home', enhanced.value_edges.home], ['Draw', enhanced.value_edges.draw], ['Away', enhanced.value_edges.away]].map(([label, edge]: any) => edge && (
                  <div key={label} className={`rounded-lg p-2 ${edge.is_value ? 'bg-primary/15' : 'bg-muted/30'}`}>
                    <div className="text-[8px] uppercase text-muted-foreground">{label} value</div>
                    <div className="font-mono font-black">{edge.edge_pct > 0 ? '+' : ''}{edge.edge_pct}%</div>
                  </div>
                ))}
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

const RESULT_STYLES = {
  win:  { label: "W", cls: "bg-primary/15 text-primary border-primary/30" },
  draw: { label: "D", cls: "bg-muted text-muted-foreground border-border" },
  loss: { label: "L", cls: "bg-chart-2/15 text-chart-2 border-chart-2/30" },
};

function H2HRow({ match, refTeamId }: { match: H2HMatch; refTeamId: number }) {
  const r = RESULT_STYLES[match.result as keyof typeof RESULT_STYLES] ?? RESULT_STYLES.draw;
  const refIsHome = match.home_team_id === refTeamId;
  return (
    <div className="grid grid-cols-[28px_1fr_auto_1fr_28px] items-center gap-2 py-2 border-b border-border/30 last:border-0">
      {/* Result badge */}
      <span className={`text-[10px] font-mono font-black border rounded px-1 py-0.5 text-center ${r.cls}`}>
        {r.label}
      </span>

      {/* Home team */}
      <div className={`text-xs truncate text-right ${refIsHome ? "font-semibold text-foreground" : "text-muted-foreground"}`}>
        {match.home_team}
      </div>

      {/* Score */}
      <div className="font-mono font-black text-sm text-center tabular-nums whitespace-nowrap px-2">
        {match.home_score} – {match.away_score}
      </div>

      {/* Away team */}
      <div className={`text-xs truncate ${!refIsHome ? "font-semibold text-foreground" : "text-muted-foreground"}`}>
        {match.away_team}
      </div>

      {/* Date */}
      <div className="text-[9px] font-mono text-muted-foreground/60 text-right whitespace-nowrap">
        {format(new Date(match.date), "MMM yy")}
      </div>
    </div>
  );
}

function HeadToHead({ matchId, homeTeamName, awayTeamName }: {
  matchId: number;
  homeTeamName: string;
  awayTeamName: string;
}) {
  const { data, isLoading } = useGetMatchH2H(matchId, {
    query: { queryKey: getGetMatchH2HQueryKey(matchId) },
  });

  return (
    <Card className="border-border/50 overflow-hidden" data-testid="panel-h2h">
      <div className="p-5 space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Swords className="w-4 h-4 text-muted-foreground" />
            <span className="font-mono text-sm font-bold uppercase tracking-widest text-muted-foreground">
              Head to Head
            </span>
          </div>
          {data && (
            <span className="text-[10px] font-mono text-muted-foreground/60">
              last {data.matches.length} meetings
            </span>
          )}
        </div>

        {isLoading ? (
          <div className="space-y-2">
            {[1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-9 w-full" />)}
          </div>
        ) : !data || data.matches.length === 0 ? (
          <p className="text-xs text-muted-foreground font-mono py-4 text-center">
            No previous meetings found.
          </p>
        ) : (
          <>
            {/* Summary bar */}
            <div className="flex items-center gap-2">
              <div className="flex-1 h-2 rounded-full overflow-hidden bg-muted flex">
                {data.summary.wins > 0 && (
                  <div
                    className="bg-primary h-full transition-all"
                    style={{ width: `${(data.summary.wins / data.matches.length) * 100}%` }}
                  />
                )}
                {data.summary.draws > 0 && (
                  <div
                    className="bg-muted-foreground/50 h-full transition-all"
                    style={{ width: `${(data.summary.draws / data.matches.length) * 100}%` }}
                  />
                )}
                {data.summary.losses > 0 && (
                  <div
                    className="bg-chart-2 h-full transition-all"
                    style={{ width: `${(data.summary.losses / data.matches.length) * 100}%` }}
                  />
                )}
              </div>
            </div>

            {/* W/D/L counts + goals */}
            <div className="grid grid-cols-5 text-center gap-1">
              <div>
                <div className="text-lg font-mono font-black text-primary">{data.summary.wins}</div>
                <div className="text-[9px] font-mono text-muted-foreground uppercase">W</div>
              </div>
              <div>
                <div className="text-lg font-mono font-black text-muted-foreground">{data.summary.draws}</div>
                <div className="text-[9px] font-mono text-muted-foreground uppercase">D</div>
              </div>
              <div>
                <div className="text-lg font-mono font-black text-chart-2">{data.summary.losses}</div>
                <div className="text-[9px] font-mono text-muted-foreground uppercase">L</div>
              </div>
              <div>
                <div className="text-lg font-mono font-black text-foreground">{data.summary.goals_scored}</div>
                <div className="text-[9px] font-mono text-muted-foreground uppercase">GF</div>
              </div>
              <div>
                <div className="text-lg font-mono font-black text-foreground">{data.summary.goals_conceded}</div>
                <div className="text-[9px] font-mono text-muted-foreground uppercase">GA</div>
              </div>
            </div>

            {/* Label row */}
            <div className="grid grid-cols-[28px_1fr_auto_1fr_28px] gap-2 text-[9px] font-mono text-muted-foreground/50 uppercase tracking-wider px-0 pb-1 border-b border-border/30">
              <span />
              <span className="text-right">{homeTeamName}</span>
              <span className="text-center px-2">Score</span>
              <span>{awayTeamName}</span>
              <span />
            </div>

            {/* Match rows */}
            <div className="-my-2">
              {data.matches.map((m, i) => (
                <H2HRow key={i} match={m} refTeamId={data.ref_team_id} />
              ))}
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

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
  const { data, isLoading } = useGetMatchEvents(matchId, {
    query: {
      refetchInterval: 30000,
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

export default function MatchDetail() {
  const params = useParams();
  const matchId = Number(params.id);

  const { data: match, isLoading, isError } = useGetMatch(matchId, {
    query: {
      enabled: !isNaN(matchId),
      refetchInterval: 15000,
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
            <h2 className="text-xl sm:text-2xl font-bold">{match.home_team.name}</h2>
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
            <h2 className="text-xl sm:text-2xl font-bold">{match.away_team.name}</h2>
          </div>
        </div>
      </Card>

      {/* Stats panel — always visible */}
      <MatchStatsPanel
        matchId={match.id}
        homeTeamName={match.home_team.name}
        awayTeamName={match.away_team.name}
      />

      {/* Head-to-Head — always visible for any match */}
      <HeadToHead
        matchId={match.id}
        homeTeamName={match.home_team.name}
        awayTeamName={match.away_team.name}
      />

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
              <Tip text={`Fractional odds for a home win: for every £1 stake you profit ${decimalToFractional(match.odds.home_odds)} — these include the bookmaker's margin`} side="bottom">
                <div className="text-sm font-mono text-primary bg-primary/10 inline-block px-2 py-0.5 rounded cursor-default">
                  {decimalToFractional(match.odds.home_odds)}
                </div>
              </Tip>
            </Card>

            <Card className="p-4 border-border/50 border-t-4 border-t-muted-foreground bg-card/50" data-testid="card-draw">
              <div className="text-xs text-muted-foreground uppercase tracking-wider mb-2 font-mono">Draw</div>
              <Tip text="Bookmaker-implied probability of the match ending level after 90 minutes — calculated from the draw odds minus the overround">
                <div className="text-3xl font-mono font-bold mb-1 text-muted-foreground cursor-default">{match.odds.draw?.toFixed(1)}%</div>
              </Tip>
              <Tip text={`Fractional odds for a draw: for every £1 stake you profit ${decimalToFractional(match.odds.draw_odds)}`} side="bottom">
                <div className="text-sm font-mono bg-muted inline-block px-2 py-0.5 rounded cursor-default">
                  {decimalToFractional(match.odds.draw_odds)}
                </div>
              </Tip>
            </Card>

            <Card className="p-4 border-border/50 border-t-4 border-t-chart-2 bg-card/50" data-testid="card-away-win">
              <div className="text-xs text-muted-foreground uppercase tracking-wider mb-2 font-mono">Away Win</div>
              <Tip text="Bookmaker-implied probability that the away team wins — calculated by converting the odds and adjusting for the overround (bookmaker margin)">
                <div className="text-3xl font-mono font-bold mb-1 cursor-default">{match.odds.away_win?.toFixed(1)}%</div>
              </Tip>
              <Tip text={`Fractional odds for an away win: for every £1 stake you profit ${decimalToFractional(match.odds.away_odds)}`} side="bottom">
                <div className="text-sm font-mono text-chart-2 bg-chart-2/10 inline-block px-2 py-0.5 rounded cursor-default">
                  {decimalToFractional(match.odds.away_odds)}
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
