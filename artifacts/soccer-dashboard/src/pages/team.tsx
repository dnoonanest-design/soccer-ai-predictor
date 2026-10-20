import { useQuery } from "@tanstack/react-query";
import { useParams, Link } from "wouter";
import { ArrowLeft, Shield, Trophy } from "lucide-react";
import { format } from "date-fns";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

type TeamRecentResult = {
  fixture_id: number;
  date: string;
  competition: string;
  home_team: string;
  away_team: string;
  home_score: number;
  away_score: number;
  venue: "home" | "away";
  opponent: string;
  result: "W" | "D" | "L";
};

type TeamResultsResponse = {
  team_id: number;
  team_name: string;
  matches: TeamRecentResult[];
};

const RESULT_STYLE: Record<TeamRecentResult["result"], string> = {
  W: "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
  D: "border-border bg-muted text-muted-foreground",
  L: "border-rose-500/30 bg-rose-500/10 text-rose-400",
};

export default function Team() {
  const { id } = useParams<{ id: string }>();
  const teamId = Number(id);
  const params = new URLSearchParams(window.location.search);
  const teamName = params.get("name") || "Team";
  const { data, isLoading, isError } = useQuery<TeamResultsResponse>({
    queryKey: ["team-results", teamId],
    enabled: Number.isInteger(teamId) && teamId > 0,
    queryFn: async () => {
      const response = await fetch(
        `/api/teams/${teamId}/results?name=${encodeURIComponent(teamName)}`,
        {
          headers: { Accept: "application/json" },
        },
      );
      if (!response.ok) throw new Error("Recent results unavailable");
      return response.json() as Promise<TeamResultsResponse>;
    },
    staleTime: 5 * 60_000,
  });

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <Link
        href="/"
        className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to matches
      </Link>
      <div className="flex items-center gap-3 border-b border-border/50 pb-4">
        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Shield className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-bold">{data?.team_name ?? teamName}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Most recent completed results
          </p>
        </div>
      </div>
      <Card className="overflow-hidden border-border/50">
        <div className="flex items-center gap-2 border-b border-border/50 px-4 py-3">
          <Trophy className="h-4 w-4 text-primary" />
          <h2 className="font-mono text-xs font-bold uppercase tracking-widest">
            Last 8 results
          </h2>
        </div>
        {isLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : isError ? (
          <p className="p-6 text-center text-sm text-muted-foreground">
            Recent results are temporarily unavailable. Please try again
            shortly.
          </p>
        ) : !data?.matches.length ? (
          <p className="p-6 text-center text-sm text-muted-foreground">
            No completed results were returned for this team.
          </p>
        ) : (
          <div className="divide-y divide-border/50">
            {data.matches.map((match) => (
              <div
                key={match.fixture_id}
                className="flex items-center gap-3 px-4 py-3"
              >
                <span
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border font-mono text-xs font-black ${RESULT_STYLE[match.result]}`}
                  aria-label={
                    match.result === "W"
                      ? "Win"
                      : match.result === "D"
                        ? "Draw"
                        : "Loss"
                  }
                >
                  {match.result}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold">
                    {match.venue === "home" ? (
                      <>
                        <span>{data.team_name}</span>
                        <span className="px-1.5 text-muted-foreground">vs</span>
                        <span className="text-muted-foreground">
                          {match.opponent}
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="text-muted-foreground">
                          {match.opponent}
                        </span>
                        <span className="px-1.5 text-muted-foreground">vs</span>
                        <span>{data.team_name}</span>
                      </>
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-2 text-[10px] text-muted-foreground">
                    <span>
                      {format(new Date(match.date), "d MMM yyyy · HH:mm")}
                    </span>
                    <span>·</span>
                    <span>{match.competition}</span>
                    <span>·</span>
                    <span>{match.venue === "home" ? "Home" : "Away"}</span>
                  </div>
                </div>
                <div className="shrink-0 font-mono text-lg font-bold">
                  {match.home_score}–{match.away_score}
                </div>
              </div>
            ))}
          </div>
        )}
        <p className="border-t border-border/50 px-4 py-3 text-[10px] text-muted-foreground">
          Results are listed newest first and show the team’s W/D/L outcome.
        </p>
      </Card>
    </div>
  );
}
