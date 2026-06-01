import { Link, useLocation } from "wouter";
import { useGetDashboardSummary, getGetDashboardSummaryQueryKey } from "@workspace/api-client-react";
import { format } from "date-fns";
import { Activity, Trophy, Clock, ServerCrash, BarChart2, LineChart, TabletSmartphone } from "lucide-react";

export function Shell({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();

  const { data: summary, isError } = useGetDashboardSummary({
    query: {
      refetchInterval: 15000,
      queryKey: getGetDashboardSummaryQueryKey(),
    },
  });

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col font-sans dark selection:bg-primary/30">
      {/* Top Status Bar - Bloomberg Terminal Style */}
      <header className="sticky top-0 z-50 w-full border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="flex h-10 items-center px-4 text-xs font-mono tracking-tight justify-between">
          <div className="flex items-center space-x-6">
            <span className="font-bold text-primary flex items-center gap-1.5">
              <Activity className="h-3.5 w-3.5" />
              LSPD_TERM
            </span>
            {summary && (
              <div className="hidden sm:flex items-center space-x-4 text-muted-foreground">
                <span className="flex items-center gap-1">
                  <div className="h-2 w-2 rounded-full bg-destructive pulse-dot" />
                  LIVE: {summary.live_count}
                </span>
                <span className="flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  UPCOMING: {summary.upcoming_count}
                </span>
                <span className="flex items-center gap-1">
                  <Trophy className="h-3 w-3" />
                  ACTIVE LEAGUES: {summary.leagues_active}
                </span>
              </div>
            )}
          </div>
          <div className="flex items-center space-x-4 text-muted-foreground">
            {isError && (
              <span className="text-destructive flex items-center gap-1">
                <ServerCrash className="h-3 w-3" />
                SYS_ERR
              </span>
            )}
            <span>
              LST_UPD: {summary?.last_updated ? format(new Date(summary.last_updated), "HH:mm:ss") : "--:--:--"}
            </span>
          </div>
        </div>
        
        {/* Navigation Bar */}
        <div className="flex h-12 items-center px-4 border-t border-border/50 gap-6 text-sm font-medium overflow-x-auto touch-scroll">
          <Link 
            href="/" 
            className={`transition-colors hover:text-primary ${location === "/" ? "text-primary" : "text-muted-foreground"}`}
          >
            Matches
          </Link>
          <Link 
            href="/leagues" 
            className={`transition-colors hover:text-primary ${location === "/leagues" ? "text-primary" : "text-muted-foreground"}`}
          >
            Leagues
          </Link>
          <Link
            href="/backtest"
            className={`transition-colors hover:text-primary flex items-center gap-1.5 ${location === "/backtest" ? "text-primary" : "text-muted-foreground"}`}
          >
            <BarChart2 className="h-3.5 w-3.5" />
            Backtest
          </Link>
          <Link
            href="/performance"
            className={`transition-colors hover:text-primary flex items-center gap-1.5 ${location === "/performance" ? "text-primary" : "text-muted-foreground"}`}
          >
            <LineChart className="h-3.5 w-3.5" />
            Performance
          </Link>
          <Link
            href="/ipad"
            className={`transition-colors hover:text-primary flex items-center gap-1.5 ${location === "/ipad" ? "text-primary" : "text-muted-foreground"}`}
          >
            <TabletSmartphone className="h-3.5 w-3.5" />
            iPad Desk
          </Link>
        </div>
      </header>

      <main className="flex-1 p-4 md:p-6 overflow-x-hidden">
        {children}
      </main>
    </div>
  );
}
