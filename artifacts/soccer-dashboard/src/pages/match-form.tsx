import { useGetMatch, getGetMatchQueryKey } from "@workspace/api-client-react";
import { useParams, Link } from "wouter";
import { ArrowLeft, Swords } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { HeadToHead } from "@/components/head-to-head";
import { RecentFormPanel } from "@/components/team-recent-results";

/** Head-to-head and each team's last 8 matches in all competitions. */
export default function MatchForm() {
  const { id } = useParams<{ id: string }>();
  const matchId = Number(id);
  const { data: match, isLoading } = useGetMatch(matchId, { query: { queryKey: getGetMatchQueryKey(matchId) } });

  return (
    <div className="mx-auto max-w-[1400px] space-y-5">
      <Link href={`/matches/${matchId}`} className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" />
        Back to match
      </Link>
      <div>
        <div className="flex items-center gap-2">
          <Swords className="h-5 w-5 text-primary" />
          <h1 className="text-2xl font-bold">Head to head & recent form</h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {match ? `${match.home_team.name} vs ${match.away_team.name}` : "Previous meetings and recent results"}
        </p>
      </div>
      {isLoading || !match ? (
        <div className="space-y-4">
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-96 w-full" />
        </div>
      ) : (
        <>
          <HeadToHead matchId={match.id} homeTeamName={match.home_team.name} awayTeamName={match.away_team.name} />
          <RecentFormPanel
            homeId={match.home_team.id}
            homeName={match.home_team.name}
            awayId={match.away_team.id}
            awayName={match.away_team.name}
          />
        </>
      )}
    </div>
  );
}
