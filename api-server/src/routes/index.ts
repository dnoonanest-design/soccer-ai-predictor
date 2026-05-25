import { Router, type IRouter } from "express";
import healthRouter from "./health";
import matchesRouter from "./matches";
import leaguesRouter from "./leagues";
import summaryRouter from "./summary";
import backtestRouter from "./backtest";
import eventsRouter from "./events";
import h2hRouter from "./h2h";
import statsRouter from "./stats";
import accuracyRouter from "./accuracy";
import platformRouter from "./platform";
import backgroundRouter from "./background";
import pushRouter from "./push";
import aiRouter from "./ai";
import premiumRouter from "./premium";

const router: IRouter = Router();

router.use(healthRouter);
router.use(matchesRouter);
router.use(leaguesRouter);
router.use(summaryRouter);
router.use(backtestRouter);
router.use(eventsRouter);
router.use(h2hRouter);
router.use(statsRouter);
router.use(accuracyRouter);
router.use(platformRouter);
router.use(backgroundRouter);
router.use(pushRouter);
router.use(aiRouter);
router.use(premiumRouter);

export default router;
