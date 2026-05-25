import { Router, type IRouter } from "express";
import { getDashboardSummary, FOCUS_LEAGUE_IDS } from "../lib/soccerService";

const router: IRouter = Router();

router.get("/summary", async (_req, res) => {
  try {
    const summary = await getDashboardSummary();
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch summary" });
  }
});

// Focus-leagues metadata endpoint — used by the frontend to dynamically
// render league names in the Shell status bar without hardcoding them.
const LEAGUE_NAMES: Record<number, { name: string; shortName: string; country: string }> = {
  39:  { name: "Premier League",    shortName: "PL",       country: "England" },
  140: { name: "La Liga",           shortName: "La Liga",  country: "Spain"   },
  78:  { name: "Bundesliga",        shortName: "BL",       country: "Germany" },
  135: { name: "Serie A",           shortName: "Serie A",  country: "Italy"   },
  61:  { name: "Ligue 1",           shortName: "L1",       country: "France"  },
  2:   { name: "Champions League",  shortName: "UCL",      country: "Europe"  },
  3:   { name: "Europa League",     shortName: "UEL",      country: "Europe"  },
  848: { name: "Conference League", shortName: "UECL",     country: "Europe"  },
};

router.get("/focus-leagues", (_req, res) => {
  const leagues = Array.from(FOCUS_LEAGUE_IDS).map((id) => ({
    id,
    ...(LEAGUE_NAMES[id] ?? { name: `League ${id}`, shortName: String(id), country: "" }),
  }));
  // Short TTL — this data changes only on server restart (env var change)
  res.setHeader("Cache-Control", "public, max-age=300");
  res.json({ leagues, count: leagues.length });
});

export default router;
