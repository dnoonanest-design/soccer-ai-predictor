import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { format } from "date-fns";
import { History } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { summariseResults, type TeamRecentResult, type TeamResultsResponse } from "@/lib/recentResults";

export { summariseResults };
export type { TeamRecentResult, TeamResultsResponse };

export const RESULT_STYLE: Record<TeamRecentResult["result"], string> = {
  W: "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
  D: "border-border bg-muted text-muted-foreground",
  L: "border-rose-500/30 bg-rose-500/10 text-rose-400",
};

/** Last 8 completed matches in all competitions (league, cups, Europe, internationals). */
export function useTeamRecentResults(teamId: number, teamName: string) {
  return useQuery<TeamResultsResponse>({
    queryKey: ["team-results", teamId],
    enabled: Number.isInteger(teamId) && teamId > 0,
    queryFn: async () => {
      const response = await fetch(`/api/teams/${teamId}/results?name=${encodeURIComponent(teamName)}`, {
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error("Recent results unavailable");
      return response.json() as Promise<TeamResultsResponse>;
    },
    staleTime: 10 * 60_000,
  });
}

function ResultBadge({ result, size = "md" }: { result: TeamRecentResult["result"]; size?: "sm" | "md" }) {
  const dims = size === "sm" ? "h-5 w-5 text-[9px]" : "h-8 w-8 text-xs";
  return (
    <span
      className={`flex shrink-0 items-center justify-center rounded-full border font-mono font-black ${dims} ${RESULT_STYLE[result]}`}
      aria-label={result === "W" ? "Win" : result === "D" ? "Draw" : "Loss"}
    >
      {result}
    </span>
  );
}

/** One team's recent results; `compact` is used side by side on the match page. */
export function TeamRecentResultsList({ data, compact = false }: { data: TeamResultsResponse; compact?: boolean }) {
  if (!data.matches.length) {
    return <p className="p-4 text-center text-sm text-muted-foreground">No completed results were returned for this team.</p>;
  }
  return (
    <div className="divide-y divide-border/50">
      {data.matches.map((match) => (
        <div key={match.fixture_id} className={`flex items-center gap-3 ${compact ? "px-3 py-2" : "px-4 py-3"}`}>
          <ResultBadge result={match.result} size={compact ? "sm" : "md"} />
          <div className="min-w-0 flex-1">
            <div className={`truncate font-semibold ${compact ? "text-xs" : "text-sm"}`}>
              <span className="text-muted-foreground">{match.venue === "home" ? "vs" : "at"}</span>{" "}
              {match.opponent}
            </div>
            <div className="mt-0.5 flex flex-wrap gap-x-1.5 text-[10px] text-muted-foreground">
              <span>{format(new Date(match.date), compact ? "d MMM" : "d MMM yyyy · HH:mm")}</span>
              <span>·</span>
              <span className="truncate">{match.competition}</span>
            </div>
          </div>
          <div className={`shrink-0 font-mono font-bold ${compact ? "text-sm" : "text-lg"}`}>
            {match.home_score}–{match.away_score}
          </div>
        </div>
      ))}
    </div>
  );
}

function TeamColumn({ teamId, teamName, accent }: { teamId: number; teamName: string; accent: string }) {
  const { data, isLoading, isError } = useTeamRecentResults(teamId, teamName);
  const s = data ? summariseResults(data.matches) : null;
  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-2 border-b border-border/50 px-3 py-2">
        <Link href={`/teams/${teamId}?name=${encodeURIComponent(teamName)}`} className={`truncate text-sm font-bold hover:underline ${accent}`}>
          {teamName}
        </Link>
        {data && data.matches.length > 0 && (
          <div className="flex shrink-0 gap-0.5" aria-label="Form, oldest to newest">
            {[...data.matches].reverse().map((m) => <ResultBadge key={m.fixture_id} result={m.result} size="sm" />)}
          </div>
        )}
      </div>
      {s && s.played > 0 && (
        <div className="flex gap-3 px-3 py-1.5 font-mono text-[10px] text-muted-foreground" data-testid="recent-summary">
          <span>W{s.w} D{s.d} L{s.l}</span>
          <span>Goals {s.gf}–{s.ga}</span>
          <span>{(s.gf / s.played).toFixed(1)} scored / game</span>
        </div>
      )}
      {isLoading ? (
        <div className="space-y-2 p-3">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-9 w-full" />)}</div>
      ) : isError || !data ? (
        <p className="p-4 text-center text-sm text-muted-foreground">Recent results are temporarily unavailable.</p>
      ) : (
        <TeamRecentResultsList data={data} compact />
      )}
    </div>
  );
}

/** Both teams' last 8 matches in all competitions, shown beside the head-to-head. */
export function RecentFormPanel({ homeId, homeName, awayId, awayName }: { homeId: number; homeName: string; awayId: number; awayName: string }) {
  return (
    <Card className="overflow-hidden border-border/50" data-testid="panel-recent-form">
      <div className="flex items-center gap-2 border-b border-border/50 px-4 py-3">
        <History className="h-4 w-4 text-muted-foreground" />
        <h2 className="font-mono text-sm font-bold uppercase tracking-widest text-muted-foreground">Last 8 matches</h2>
        <span className="ml-auto text-[10px] text-muted-foreground/70">All competitions · newest first</span>
      </div>
      <div className="grid grid-cols-1 divide-y divide-border/50 md:grid-cols-2 md:divide-x md:divide-y-0">
        <TeamColumn teamId={homeId} teamName={homeName} accent="text-primary" />
        <TeamColumn teamId={awayId} teamName={awayName} accent="text-chart-2" />
      </div>
    </Card>
  );
}
