import { useParams, Link } from "wouter";
import { ArrowLeft, Shield, Trophy } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { summariseResults, TeamRecentResultsList, useTeamRecentResults } from "@/components/team-recent-results";

export default function Team() {
  const { id } = useParams<{ id: string }>();
  const teamId = Number(id);
  const params = new URLSearchParams(window.location.search);
  const teamName = params.get("name") || "Team";
  const { data, isLoading, isError } = useTeamRecentResults(teamId, teamName);
  const s = data ? summariseResults(data.matches) : null;

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <button type="button" onClick={() => window.history.length > 1 ? window.history.back() : (window.location.href = "/")} className="inline-flex items-center gap-1.5 hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />Back
        </button>
        <span aria-hidden>·</span>
        <Link href="/" className="hover:text-foreground">Matches</Link>
        <span aria-hidden>›</span>
        <span className="text-foreground">{data?.team_name ?? teamName}</span>
      </nav>
      <div className="flex items-center gap-3 border-b border-border/50 pb-4">
        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Shield className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-bold">{data?.team_name ?? teamName}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Most recent completed results, all competitions
          </p>
        </div>
      </div>
      <Card className="overflow-hidden border-border/50">
        <div className="flex items-center gap-2 border-b border-border/50 px-4 py-3">
          <Trophy className="h-4 w-4 text-primary" />
          <h2 className="font-mono text-xs font-bold uppercase tracking-widest">
            Last 8 results
          </h2>
          {s && s.played > 0 && (
            <span className="ml-auto font-mono text-[10px] text-muted-foreground">
              W{s.w} D{s.d} L{s.l} · Goals {s.gf}–{s.ga}
            </span>
          )}
        </div>
        {isLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : isError || !data ? (
          <p className="p-6 text-center text-sm text-muted-foreground">
            Recent results are temporarily unavailable. Please try again
            shortly.
          </p>
        ) : (
          <TeamRecentResultsList data={data} />
        )}
        <p className="border-t border-border/50 px-4 py-3 text-[10px] text-muted-foreground">
          Results are listed newest first and show the team’s W/D/L outcome.
        </p>
      </Card>
    </div>
  );
}
