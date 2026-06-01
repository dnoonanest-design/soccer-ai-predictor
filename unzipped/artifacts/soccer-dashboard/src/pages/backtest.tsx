import { useGetBacktest, getGetBacktestQueryKey } from "@workspace/api-client-react";
import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { BarChart2, TrendingUp, TrendingDown, Minus, RefreshCw } from "lucide-react";

function ProbBar({ home, draw, away }: { home: number; draw: number; away: number }) {
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
      <div className="h-full bg-primary transition-all duration-700" style={{ width: `${home}%` }} />
      <div className="h-full bg-muted-foreground/60 transition-all duration-700" style={{ width: `${draw}%` }} />
      <div className="h-full bg-chart-2 transition-all duration-700" style={{ width: `${away}%` }} />
    </div>
  );
}

function ScenarioIcon({ htHome, htAway }: { htHome: number; htAway: number }) {
  if (htHome > htAway) return <TrendingUp className="w-3.5 h-3.5 text-primary shrink-0" />;
  if (htAway > htHome) return <TrendingDown className="w-3.5 h-3.5 text-chart-2 shrink-0" />;
  return <Minus className="w-3.5 h-3.5 text-muted-foreground shrink-0" />;
}

const SEASON_OPTIONS = [2024, 2023, 2022, 2021, 2020];

export default function Backtest() {
  const [season, setSeason] = useState<number>(2024);

  const { data, isLoading, isError, isFetching } = useGetBacktest(
    { season },
    { query: { queryKey: getGetBacktestQueryKey({ season }) } }
  );

  return (
    <div className="space-y-6 max-w-[1400px] mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 border-b border-border/50 pb-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <BarChart2 className="w-6 h-6 text-primary" />
            Halftime Backtest
          </h1>
          <p className="text-sm text-muted-foreground mt-1 font-mono">
            Historical outcome rates from half-time score across top European leagues
          </p>
        </div>
        <div className="flex items-center gap-3">
          {isFetching && <RefreshCw className="w-3.5 h-3.5 text-muted-foreground animate-spin" />}
          <div className="flex bg-muted/50 p-1 rounded-md text-sm font-mono">
            {SEASON_OPTIONS.map((s) => (
              <button
                key={s}
                onClick={() => setSeason(s)}
                data-testid={`button-season-${s}`}
                className={`px-3 py-1 rounded-sm transition-colors ${season === s ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              >
                {s}/{String(s + 1).slice(2)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[1,2,3,4].map(i => <Skeleton key={i} className="h-24" />)}
          </div>
          <Skeleton className="h-96 w-full" />
        </div>
      ) : isError || !data ? (
        <div className="flex flex-col items-center justify-center py-24 text-muted-foreground border border-dashed border-border rounded-lg">
          <BarChart2 className="w-12 h-12 mb-4 opacity-20" />
          <p>Failed to load backtest data. Check your API keys.</p>
        </div>
      ) : (
        <>
          {/* Summary Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Card className="p-4 border-border/50 bg-card/50" data-testid="stat-total-matches">
              <div className="text-xs text-muted-foreground font-mono uppercase tracking-wider mb-1">Matches Analyzed</div>
              <div className="text-3xl font-mono font-bold">{data.total_matches.toLocaleString()}</div>
              <div className="text-xs text-muted-foreground mt-1 font-mono">{data.season}/{String(data.season + 1).slice(2)} season</div>
            </Card>
            <Card className="p-4 border-border/50 bg-card/50" data-testid="stat-comeback-rate">
              <div className="text-xs text-muted-foreground font-mono uppercase tracking-wider mb-1">Comeback Rate</div>
              <div className="text-3xl font-mono font-bold text-chart-2">{data.summary.comeback_rate}%</div>
              <div className="text-xs text-muted-foreground mt-1 font-mono">HT leader didn't win</div>
            </Card>
            <Card className="p-4 border-border/50 bg-card/50" data-testid="stat-home-lead-win">
              <div className="text-xs text-muted-foreground font-mono uppercase tracking-wider mb-1">HT Home Lead Win</div>
              <div className="text-3xl font-mono font-bold text-primary">{data.summary.home_leading_ht_win_pct}%</div>
              <div className="text-xs text-muted-foreground mt-1 font-mono">of the time</div>
            </Card>
            <Card className="p-4 border-border/50 bg-card/50" data-testid="stat-away-lead-win">
              <div className="text-xs text-muted-foreground font-mono uppercase tracking-wider mb-1">HT Away Lead Win</div>
              <div className="text-3xl font-mono font-bold text-chart-2">{data.summary.away_leading_ht_win_pct}%</div>
              <div className="text-xs text-muted-foreground mt-1 font-mono">of the time</div>
            </Card>
          </div>

          {/* 0-0 at Half Time highlight */}
          <Card className="p-5 border-border/50 border-l-4 border-l-muted-foreground">
            <div className="flex items-center justify-between mb-3">
              <div className="font-mono text-sm font-bold text-muted-foreground uppercase tracking-widest">0–0 at Half Time</div>
              <div className="text-xs text-muted-foreground font-mono">
                Most common: {data.summary.most_common_ht_score}
              </div>
            </div>
            <div className="flex justify-between text-xs font-mono mb-2">
              <span className="text-primary font-bold">Home Win {data.summary.draw_ht_home_win_pct}%</span>
              <span className="text-muted-foreground">Draw {data.summary.draw_ht_draw_pct}%</span>
              <span className="text-chart-2 font-bold">Away Win {data.summary.draw_ht_away_win_pct}%</span>
            </div>
            <ProbBar
              home={data.summary.draw_ht_home_win_pct}
              draw={data.summary.draw_ht_draw_pct}
              away={data.summary.draw_ht_away_win_pct}
            />
          </Card>

          {/* Leagues coverage */}
          <div className="flex flex-wrap gap-2">
            {data.leagues.map((l) => (
              <span key={l.id} className="text-xs font-mono bg-muted/60 border border-border/50 px-2 py-1 rounded text-muted-foreground">
                {l.name} ({l.country})
              </span>
            ))}
          </div>

          {/* Scenario Table */}
          <Card className="border-border/50 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm font-mono">
                <thead>
                  <tr className="border-b border-border bg-muted/30">
                    <th className="text-left px-4 py-3 text-xs text-muted-foreground uppercase tracking-wider font-semibold w-8"></th>
                    <th className="text-left px-4 py-3 text-xs text-muted-foreground uppercase tracking-wider font-semibold">HT Score</th>
                    <th className="text-right px-4 py-3 text-xs text-muted-foreground uppercase tracking-wider font-semibold">Matches</th>
                    <th className="text-right px-4 py-3 text-xs text-primary uppercase tracking-wider font-semibold">Home Win</th>
                    <th className="text-right px-4 py-3 text-xs text-muted-foreground uppercase tracking-wider font-semibold">Draw</th>
                    <th className="text-right px-4 py-3 text-xs text-chart-2 uppercase tracking-wider font-semibold">Away Win</th>
                    <th className="px-4 py-3 min-w-[180px]"></th>
                  </tr>
                </thead>
                <tbody>
                  {data.scenarios.map((s, i) => (
                    <tr
                      key={s.halftime_score}
                      data-testid={`row-scenario-${s.halftime_score}`}
                      className={`border-b border-border/40 hover:bg-muted/20 transition-colors ${i === 0 ? "bg-muted/10" : ""}`}
                    >
                      <td className="px-4 py-3">
                        <ScenarioIcon htHome={s.home_goals_ht} htAway={s.away_goals_ht} />
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-base font-bold text-foreground">
                          {s.home_goals_ht} – {s.away_goals_ht}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right text-muted-foreground">
                        {s.match_count.toLocaleString()}
                      </td>
                      <td className="px-4 py-3 text-right font-bold text-primary">
                        {s.home_win_pct}%
                        <div className="text-[10px] text-muted-foreground font-normal">({s.home_win_count})</div>
                      </td>
                      <td className="px-4 py-3 text-right text-muted-foreground">
                        {s.draw_pct}%
                        <div className="text-[10px] text-muted-foreground/60 font-normal">({s.draw_count})</div>
                      </td>
                      <td className="px-4 py-3 text-right font-bold text-chart-2">
                        {s.away_win_pct}%
                        <div className="text-[10px] text-muted-foreground font-normal">({s.away_win_count})</div>
                      </td>
                      <td className="px-4 py-3">
                        <ProbBar home={s.home_win_pct} draw={s.draw_pct} away={s.away_win_pct} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <div className="text-xs text-muted-foreground font-mono text-right">
            Generated: {new Date(data.generated_at).toLocaleTimeString()} — {data.total_matches.toLocaleString()} matches across {data.leagues.length} leagues
          </div>
        </>
      )}
    </div>
  );
}
