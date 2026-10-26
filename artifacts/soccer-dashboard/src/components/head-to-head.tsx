import { useGetMatchH2H, getGetMatchH2HQueryKey, type H2HMatch } from "@workspace/api-client-react";
import { format } from "date-fns";
import { Swords } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

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

export function HeadToHead({ matchId, homeTeamName, awayTeamName }: {
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

