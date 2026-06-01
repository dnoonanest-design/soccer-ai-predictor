import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Dashboard from "@/pages/dashboard";
import Leagues from "@/pages/leagues";
import MatchDetail from "@/pages/match-detail";
import Backtest from "@/pages/backtest";
import Performance from "@/pages/performance";
import IpadLive from "@/pages/ipad-live";
import { Shell } from "@/components/layout/Shell";
import { PwaInstallPrompt } from "@/components/PwaInstallPrompt";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

function Router() {
  return (
    <Shell>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/leagues" component={Leagues} />
        <Route path="/matches/:id" component={MatchDetail} />
        <Route path="/backtest" component={Backtest} />
        <Route path="/performance" component={Performance} />
        <Route path="/ipad" component={IpadLive} />
        <Route component={NotFound} />
      </Switch>
    </Shell>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <PwaInstallPrompt />
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
