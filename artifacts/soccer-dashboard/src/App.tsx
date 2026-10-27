import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Dashboard from "@/pages/dashboard";
import { lazy, Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { LiveFeedProvider } from "@/hooks/use-live-feed";

// The matches page loads with the app; other pages load the first time they are opened.
const Leagues = lazy(() => import("@/pages/leagues"));
const MatchDetail = lazy(() => import("@/pages/match-detail"));
const Backtest = lazy(() => import("@/pages/backtest"));
const Performance = lazy(() => import("@/pages/performance"));
const IpadLive = lazy(() => import("@/pages/ipad-live"));
const MatchSquad = lazy(() => import("@/pages/match-squad"));
const MatchForm = lazy(() => import("@/pages/match-form"));
const Team = lazy(() => import("@/pages/team"));

function PageLoading() {
  return (
    <div className="mx-auto max-w-5xl space-y-4" aria-busy="true">
      <Skeleton className="h-5 w-64" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
import { Shell } from "@/components/layout/Shell";
import { PwaInstallPrompt } from "@/components/PwaInstallPrompt";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Coming back to the app (or back online) refreshes anything older than 15 seconds.
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      staleTime: 15_000,
      retry: 1,
    },
  },
});

function Router() {
  return (
    <Shell>
      <Suspense fallback={<PageLoading />}>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/leagues" component={Leagues} />
        <Route path="/matches/:id/squad" component={MatchSquad} />
        <Route path="/matches/:id/form" component={MatchForm} />
        <Route path="/teams/:id" component={Team} />
        <Route path="/matches/:id" component={MatchDetail} />
        <Route path="/backtest" component={Backtest} />
        <Route path="/performance" component={Performance} />
        <Route path="/ipad" component={IpadLive} />
        <Route component={NotFound} />
      </Switch>
      </Suspense>
    </Shell>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <LiveFeedProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        </LiveFeedProvider>
        <PwaInstallPrompt />
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
