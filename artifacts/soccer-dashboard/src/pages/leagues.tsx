import { useGetLeagues, getGetLeaguesQueryKey } from "@workspace/api-client-react";
import { Trophy, Activity, ArrowRight } from "lucide-react";
import { Link } from "wouter";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function Leagues() {
  const { data: leagues, isLoading } = useGetLeagues({
    query: { refetchInterval: 60000, queryKey: getGetLeaguesQueryKey() }
  });

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="border-b border-border/50 pb-4">
        <h1 className="text-2xl font-bold tracking-tight">Active Leagues</h1>
        <p className="text-muted-foreground text-sm mt-1">Leagues with matches scheduled for today.</p>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3, 4, 5, 6].map(i => <Skeleton key={i} className="h-24 w-full" />)}
        </div>
      ) : !leagues || leagues.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          No active leagues right now.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {leagues.map(league => (
            <Link key={league.id} href={`/?league_id=${league.id}`}>
              <Card className="p-4 flex items-center justify-between hover:bg-muted/50 transition-colors border-border/50 cursor-pointer group">
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center overflow-hidden">
                    {league.logo ? (
                      <img src={league.logo} alt={league.name} className="w-6 h-6 object-contain" />
                    ) : (
                      <Trophy className="w-5 h-5 text-muted-foreground" />
                    )}
                  </div>
                  <div>
                    <div className="font-semibold text-sm">{league.name}</div>
                    <div className="text-xs text-muted-foreground">{league.country}</div>
                  </div>
                </div>
                <div className="text-right flex flex-col items-end">
                  <div className="text-xs font-mono text-muted-foreground mb-1">
                    {league.match_count} matches
                  </div>
                  {league.live_count > 0 && (
                    <div className="text-[10px] font-bold text-destructive flex items-center gap-1 bg-destructive/10 px-1.5 py-0.5 rounded">
                      <Activity className="w-3 h-3" />
                      {league.live_count} LIVE
                    </div>
                  )}
                  <ArrowRight className="w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity mt-1" />
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
