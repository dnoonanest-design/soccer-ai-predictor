import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { format } from "date-fns";
import { AlertTriangle, CheckCircle2, Database, Fingerprint, LockKeyhole, RefreshCw, ShieldCheck, TrendingUp } from "lucide-react";

type MetricRow = { phase?: string; checkpoint?: string; data_tier?: string; confidence_band?: string; model_version?: string; engine_revision?: string; group_name?: string; samples: number; accuracy: number | null; brierScore: number | null; logLoss: number | null; averageConfidence: number | null };
type Totals = { captured: number; fixtures: number; settled: number; pending: number; voided?: number; accuracy: number | null; brierScore: number | null; logLoss: number | null; over25Accuracy: number | null; bttsAccuracy: number | null };
type LedgerRow = { id: number; fixture_id: number; home_team: string; away_team: string; phase: string; checkpoint: string; predicted_outcome: string; actual_outcome: string | null; pick_confidence: number; correct: boolean | null; brier_score: number | null; score_home: number | null; score_away: number | null; captured_at: string; settled_at: string | null; integrity_status: "verified" | "invalid" | "legacy-signed" | "legacy-unsigned" };
type AuditReport = {
  generatedAt: string;
  dataMaturity: "collecting" | "developing" | "mature";
  integrity: { status: "verified" | "integrity-failed" | "signing-key-required" | "collecting"; signing: string; checked: number; verified: number; unsigned: number; invalid: number; latePrematch: number; invalidProbability: number; resultMismatch: number; coveragePct: number; currentSigned?: number; currentSealCoveragePct?: number; legacyArchiveCoveragePct?: number; verifiedAt: string };
  certified: Totals;
  overall: Totals;
  inPlay?: Totals;
  byPhase: MetricRow[];
  byCheckpoint: MetricRow[];
  inPlayByCheckpoint?: MetricRow[];
  byConfidence: MetricRow[];
  byModel: MetricRow[];
  recent: LedgerRow[];
  recentInPlay?: LedgerRow[];
};

type PerformanceReport = {
  generatedAt: string;
  windowDays: number;
  byLeague: Array<MetricRow & { leagueId: number | null; name: string; country?: string; kind: string; tier: number | null; strengthBand: string }>;
  byCompetitionType: Array<{ group: string; samples: number; accuracy: number | null; brierScore: number | null; logLoss: number | null }>;
  byPickSide: MetricRow[];
  byDataQuality: MetricRow[];
  byPhase: MetricRow[];
  inPlayByCheckpoint?: MetricRow[];
  byLineupState: MetricRow[];
  manchesterRule: MetricRow[];
  featureEvidence: Record<"confirmedLineups" | "manchesterRule", { status: "collecting" | "observed-improvement" | "no-proven-improvement"; minimumSamples: number; treatmentSamples: number; baselineSamples: number; brierImprovement: number | null; adaptivePromotionAllowed: false; reason: string }>;
  dailyTrend: Array<MetricRow & { day: string }>;
  lifecycleWarnings: Array<{ reason: string; samples: number }>;
  marketBenchmark: { policy: string; corePredictionUsesBookmakerOdds: boolean; samples: number; averageMarketMovementPctPoints: number | null; averageModelMarketGapPctPoints: number | null; modelAccuracy?: number | null; marketAccuracy?: number | null; modelBrierScore?: number | null; marketBrierScore?: number | null; brierEdgeVsMarket?: number | null };
  learningSafety: { minimumPromotionSamples: number; minimumResidualSamples: number; principle: string };
};

type ChallengerReport = {
  champion: string;
  championSince: string | null;
  championDescription: string;
  rules: { minMatches: number; minBrierImprovement: number; minTStat: number; minMarketMatches: number; autoPromote: boolean };
  pendingTotal?: number;
  standings: Array<{ challenger: string; description: string; pending?: number; matches: number; brier: number | null; championBrier: number | null; brierGain: number | null; tStat: number | null; marketMatches: number; marketBrierGain: number | null; closingOddsBrier: number | null; goalMarketMatches?: number; over25LogLossGain?: number | null; bttsLogLossGain?: number | null; eligible: boolean; reasons: string[] }>;
  ratings?: { shotStatistics?: { fixturesWithShots: number; stackingModel: { trainingMatches: number } | null; stackingNeeds: number } };
};

type InPlayReport = {
  champion: string;
  fittedParams: Record<string, number> | null;
  defaultParams: Record<string, number>;
  lastFit: { fixtures?: number; reason?: string | null; holdout?: { defaultLogLoss: number; fittedLogLoss: number } | null } | null;
  rules: { minFixtures: number; minBrierImprovement: number; minTStat: number };
  standings: Array<{ challenger: string; pending: number; fixtures: number; checkpoints: number; brier: number | null; championBrier: number | null; brierGain: number | null; tStat: number | null; eligible: boolean; reasons: string[] }>;
};

const PARAM_LABELS: Record<string, string> = { trailing: "Team behind", leading: "Team ahead", redOwn: "Own red card", redOpp: "Opponent red", telemetrySpread: "Live pressure", liveXgSlope: "Live xG" };
const signed = (v: number | null | undefined) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(4)}`);

async function api<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

const pct = (value: number | null | undefined) => value == null ? "—" : `${(value * 100).toFixed(1)}%`;
const score = (value: number | null | undefined) => value == null ? "—" : value.toFixed(3);
const outcome = (value: string | null) => !value ? "Pending" : value === "home" ? "Home" : value === "away" ? "Away" : "Draw";
const resultText = (row: LedgerRow) => row.correct == null ? "PENDING" : row.correct ? "WIN" : "MISS";
const resultClass = (row: LedgerRow) => row.correct == null ? "text-muted-foreground" : row.correct ? "text-emerald-500" : "text-destructive";

function Metric({ label, value, note }: { label: string; value: string | number; note: string }) {
  return <Card className="p-4 border-border/60 bg-card/70"><div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground font-mono">{label}</div><div className="text-2xl font-black font-mono mt-1">{value}</div><div className="text-[11px] text-muted-foreground mt-1">{note}</div></Card>;
}

function BreakdownTable({ title, rows, label }: { title: string; rows: MetricRow[]; label: (row: MetricRow) => string }) {
  return <Card className="p-4 border-border/60">
    <h2 className="font-bold mb-1">{title}</h2><p className="text-xs text-muted-foreground mb-3">Only cryptographically verified and eligible settled records.</p>
    <div className="overflow-x-auto"><table className="w-full text-xs">
      <thead className="text-muted-foreground uppercase font-mono"><tr><th className="text-left py-2">Group</th><th>Sample</th><th>Accuracy</th><th>Brier</th><th>Log loss</th><th>Avg confidence</th></tr></thead>
      <tbody>{rows.map((row, index) => <tr key={`${label(row)}-${index}`} className="border-t border-border/40">
        <td className="py-2 font-medium">{label(row)}</td><td className="text-center font-mono">{row.samples}</td><td className="text-center font-mono">{pct(row.accuracy)}</td><td className="text-center font-mono">{score(row.brierScore)}</td><td className="text-center font-mono">{score(row.logLoss)}</td><td className="text-center font-mono">{pct(row.averageConfidence == null ? null : row.averageConfidence / 100)}</td>
      </tr>)}{!rows.length && <tr><td colSpan={6} className="py-6 text-center text-muted-foreground">Verified results are still being collected.</td></tr>}</tbody>
    </table></div>
  </Card>;
}

export default function Performance() {
  const report = useQuery({ queryKey: ["prediction-accuracy-audit"], queryFn: () => api<AuditReport>("/api/accuracy/audit"), refetchInterval: 60_000, refetchOnWindowFocus: true });
  const challengers = useQuery({ queryKey: ["model-challengers"], queryFn: () => api<ChallengerReport>("/api/model/challengers"), refetchInterval: 5 * 60_000 });
  const inPlayModel = useQuery({ queryKey: ["model-inplay"], queryFn: () => api<InPlayReport>("/api/model/inplay"), refetchInterval: 5 * 60_000 });
  const intelligence = useQuery({ queryKey: ["prediction-performance-intelligence", 14], queryFn: () => api<PerformanceReport>("/api/accuracy/performance?days=14"), refetchInterval: 60_000, refetchOnWindowFocus: true });
  if (report.isLoading) return <div className="min-h-[45vh] flex items-center justify-center text-muted-foreground"><RefreshCw className="h-5 w-5 animate-spin mr-2" /> Verifying performance ledger…</div>;
  if (report.isError || !report.data) return <Card className="p-6 border-destructive/50"><div className="flex items-center gap-2 font-bold text-destructive"><AlertTriangle className="h-5 w-5" />Performance verification unavailable</div><p className="text-sm text-muted-foreground mt-2">No figures are displayed because the audit source could not be verified.</p></Card>;

  const data = report.data;
  const intel = intelligence.data;
  const integrityOk = data.integrity.status === "verified";
  const keyMissing = data.integrity.status === "signing-key-required";
  const hasCertifiedResults = data.certified.settled > 0;
  const manchesterTagged = intel?.manchesterRule.find((row) => row.group_name === "manchester-rule-tagged");
  const lineupEvidence = intel?.featureEvidence?.confirmedLineups;
  const manchesterEvidence = intel?.featureEvidence?.manchesterRule;
  const latestTrend = intel?.dailyTrend.at(-1);

  return <div className="space-y-5 max-w-[1500px] mx-auto">
    <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-3"><div><div className="flex flex-wrap items-center gap-2"><h1 className="text-2xl font-black tracking-tight">Verified Performance</h1><Badge variant="outline" className={integrityOk ? "border-emerald-500/60 text-emerald-500" : "border-amber-500/60 text-amber-500"}>{integrityOk ? hasCertifiedResults ? "AUDIT VERIFIED" : "VERIFIED · COLLECTING" : keyMissing ? "SIGNING SETUP REQUIRED" : "INTEGRITY WARNING"}</Badge>{intel && <Badge variant="secondary">ROLLING {intel.windowDays} DAYS</Badge>}</div><p className="text-sm text-muted-foreground mt-1">Immutable prediction snapshots, independently settled after full time.</p></div><div className="text-xs font-mono text-muted-foreground">VERIFIED {format(new Date(data.integrity.verifiedAt), "dd MMM yyyy HH:mm:ss")}</div></div>

    <Card className={`p-4 border ${integrityOk ? "border-emerald-500/40 bg-emerald-500/5" : "border-amber-500/40 bg-amber-500/5"}`}><div className="flex flex-col md:flex-row md:items-center gap-4">
      <div className={`h-11 w-11 rounded-full flex items-center justify-center ${integrityOk ? "bg-emerald-500/15 text-emerald-500" : "bg-amber-500/15 text-amber-500"}`}>{integrityOk ? <ShieldCheck className="h-6 w-6" /> : <AlertTriangle className="h-6 w-6" />}</div>
      <div className="flex-1"><div className="font-bold">{integrityOk ? hasCertifiedResults ? "Performance ledger passed every integrity check" : "Integrity is verified; certified results are still being collected" : keyMissing ? "Add the production signing key to certify new predictions" : data.integrity.status === "collecting" ? "Signing is active; the first verified results are being collected" : "Some records failed verification and are excluded"}</div><div className="text-xs text-muted-foreground mt-1">{data.integrity.signing} · {data.integrity.verified} verified · {data.integrity.currentSealCoveragePct ?? data.integrity.coveragePct}% current-seal coverage · {data.integrity.unsigned} legacy unsigned · {data.integrity.invalid} invalid · {data.integrity.resultMismatch} result mismatches · {data.integrity.legacyArchiveCoveragePct ?? data.integrity.coveragePct}% full-archive coverage</div></div>
      <div className="flex gap-5 text-center font-mono text-xs"><div><Fingerprint className="h-4 w-4 mx-auto mb-1 text-primary" /><b>{data.integrity.checked}</b><div className="text-muted-foreground">CHECKED</div></div><div><LockKeyhole className="h-4 w-4 mx-auto mb-1 text-primary" /><b>{data.certified.settled}</b><div className="text-muted-foreground">CERTIFIED</div></div><div><Database className="h-4 w-4 mx-auto mb-1 text-primary" /><b>{data.certified.pending}</b><div className="text-muted-foreground">PENDING</div></div></div>
    </div></Card>

    <div className="pt-1"><h2 className="text-lg font-black">Pre-match predictions</h2><p className="text-xs text-muted-foreground">One frozen prediction per match, captured before kickoff. In-play predictions are never included here.</p></div>
    <div className="grid grid-cols-2 lg:grid-cols-6 gap-3"><Metric label="Audited fixtures" value={data.certified.fixtures} note="Signed matches, including pending" /><Metric label="1X2 accuracy" value={pct(data.certified.accuracy)} note="Highest probability pick" /><Metric label="Brier score" value={score(data.certified.brierScore)} note="Lower is better" /><Metric label="Log loss" value={score(data.certified.logLoss)} note="Penalises overconfidence" /><Metric label="Over 2.5" value={pct(data.certified.over25Accuracy)} note="Certified market accuracy" /><Metric label="BTTS" value={pct(data.certified.bttsAccuracy)} note="Certified market accuracy" /></div>

    {intel && <>
      <div className="flex items-center gap-2 pt-2"><TrendingUp className="h-5 w-5 text-primary" /><h2 className="text-lg font-black">Pre-match Intelligence</h2></div>
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3"><Metric label="Latest day" value={latestTrend ? pct(latestTrend.accuracy) : "—"} note={latestTrend ? `${latestTrend.samples} certified pre-match predictions` : "Collecting"} /><Metric label="Manchester Rule" value={manchesterTagged ? pct(manchesterTagged.accuracy) : "—"} note={manchesterEvidence ? `${manchesterEvidence.treatmentSamples}/${manchesterEvidence.minimumSamples} · ${manchesterEvidence.status.replaceAll("-", " ")}` : "Awaiting tagged settlements"} /><Metric label="Market sample" value={intel.marketBenchmark.samples} note="Matches with closing odds" /><Metric label="Model vs closing odds" value={intel.marketBenchmark.modelBrierScore == null || intel.marketBenchmark.marketBrierScore == null ? "—" : `${score(intel.marketBenchmark.modelBrierScore)} / ${score(intel.marketBenchmark.marketBrierScore)}`} note={intel.marketBenchmark.brierEdgeVsMarket == null ? "Brier on the same matches · lower is better" : intel.marketBenchmark.brierEdgeVsMarket > 0 ? "Model beat the closing market" : "Closing market was more accurate"} /><Metric label="Model-market gap" value={intel.marketBenchmark.averageModelMarketGapPctPoints == null ? "—" : `${intel.marketBenchmark.averageModelMarketGapPctPoints.toFixed(2)} pts`} note="Pre-match predictions include bookmaker odds when stored" /></div>
      <div className="grid lg:grid-cols-2 gap-4"><BreakdownTable title="Home / Draw / Away Picks" rows={intel.byPickSide} label={(row) => outcome(row.group_name ?? null)} /><BreakdownTable title="Data Quality" rows={intel.byDataQuality} label={(row) => (row.group_name ?? "unknown").replaceAll("_", " ")} /></div>
      <div className="grid lg:grid-cols-2 gap-4"><BreakdownTable title={`Lineup Confirmation Impact · ${lineupEvidence?.status.replaceAll("-", " ") ?? "collecting"}`} rows={intel.byLineupState} label={(row) => (row.group_name ?? "unknown").replaceAll("-", " ")} /><BreakdownTable title={`Manchester Rule Contribution · ${manchesterEvidence?.status.replaceAll("-", " ") ?? "collecting"}`} rows={intel.manchesterRule} label={(row) => (row.group_name ?? "unknown").replaceAll("-", " ")} /></div>
      <Card className="p-4 border-border/60"><h2 className="font-bold mb-1">League & Competition Performance</h2><p className="text-xs text-muted-foreground mb-3">Use this to identify where calibration needs evidence-backed adjustment.</p><div className="overflow-x-auto"><table className="w-full text-xs min-w-[760px]"><thead className="text-muted-foreground uppercase font-mono"><tr><th className="text-left py-2">Competition</th><th>Type</th><th>Evidence band</th><th>Sample</th><th>Accuracy</th><th>Brier</th><th>Log loss</th></tr></thead><tbody>{intel.byLeague.map((row) => <tr key={String(row.leagueId)} className="border-t border-border/40"><td className="py-2 font-medium">{row.name}</td><td className="text-center">{row.kind}</td><td className="text-center">{row.strengthBand}</td><td className="text-center font-mono">{row.samples}</td><td className="text-center font-mono">{pct(row.accuracy)}</td><td className="text-center font-mono">{score(row.brierScore)}</td><td className="text-center font-mono">{score(row.logLoss)}</td></tr>)}</tbody></table></div></Card>
      <div className="grid lg:grid-cols-2 gap-4"><Card className="p-4 border-border/60"><h2 className="font-bold">Lifecycle Warning Diagnosis</h2><p className="text-xs text-muted-foreground mt-1 mb-3">Warnings remain visible; thresholds are not weakened.</p>{intel.lifecycleWarnings.length ? <div className="space-y-2">{intel.lifecycleWarnings.map((item) => <div key={item.reason} className="flex items-center justify-between border-t border-border/40 pt-2 text-xs"><span className="font-mono">{item.reason}</span><Badge variant="outline">{item.samples}</Badge></div>)}</div> : <div className="text-sm text-emerald-500 flex items-center gap-2"><CheckCircle2 className="h-4 w-4" />No warning/failure reasons in this window.</div>}</Card><Card className="p-4 border-border/60"><h2 className="font-bold">Learning Safety</h2><p className="text-xs text-muted-foreground mt-1">Automatic weights require meaningful settled evidence before they can become active.</p><div className="grid grid-cols-2 gap-3 mt-4"><Metric label="Weight promotion" value={`${intel.learningSafety.minimumPromotionSamples}+`} note="settled samples required" /><Metric label="Residual factors" value={`${intel.learningSafety.minimumResidualSamples}+`} note="samples required" /></div><p className="text-[11px] text-muted-foreground mt-3">{intel.learningSafety.principle}</p></Card></div>
    </>}

    <div className="grid lg:grid-cols-2 gap-4"><BreakdownTable title="Pre-match Checkpoints" rows={data.byCheckpoint} label={(row) => `${(row.checkpoint ?? "").replaceAll("_", " ")} · ${row.data_tier ?? ""}`} /><BreakdownTable title="Confidence Calibration · pre-match" rows={data.byConfidence} label={(row) => row.confidence_band ?? "Unknown"} /></div>
    <div className="grid lg:grid-cols-2 gap-4"><BreakdownTable title="Model Revisions · pre-match" rows={data.byModel} label={(row) => `${row.model_version ?? "Unknown"} · ${row.engine_revision ?? "unknown"}`} /></div>

    <Card className="p-4 border-border/60"><div className="flex items-start justify-between gap-3 mb-3"><div><h2 className="font-bold">Frozen Pre-match Ledger</h2><p className="text-xs text-muted-foreground mt-1">One row per match using the final verified prediction captured before kickoff. Live checkpoints never replace this pick.</p></div><Badge variant="secondary" className="font-mono">{data.dataMaturity.toUpperCase()}</Badge></div>
      <div className="md:hidden space-y-3">
        {data.recent.map((row) => <div key={row.fixture_id} className="rounded-lg border border-border/50 p-3 bg-muted/10">
          <div className="flex items-start justify-between gap-3"><div><div className="font-semibold text-sm">{row.home_team} v {row.away_team}</div><div className="text-[10px] text-muted-foreground font-mono mt-0.5">FIXTURE {row.fixture_id}</div></div><Badge variant="outline" className={`font-mono ${resultClass(row)}`}>{resultText(row)}</Badge></div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-3 mt-3 text-xs">
            <div><div className="text-[10px] uppercase text-muted-foreground font-mono">Prediction</div><div className="font-semibold mt-0.5">{outcome(row.predicted_outcome)} · {row.pick_confidence.toFixed(1)}%</div></div>
            <div><div className="text-[10px] uppercase text-muted-foreground font-mono">Actual</div><div className="font-semibold mt-0.5">{row.actual_outcome ? `${outcome(row.actual_outcome)} · ${row.score_home ?? "—"}-${row.score_away ?? "—"}` : "Pending"}</div></div>
            <div><div className="text-[10px] uppercase text-muted-foreground font-mono">Checkpoint</div><div className="font-mono mt-0.5">{row.checkpoint.replaceAll("_", " ")}</div></div>
            <div><div className="text-[10px] uppercase text-muted-foreground font-mono">Captured</div><div className="font-mono mt-0.5">{format(new Date(row.captured_at), "dd MMM HH:mm")}</div></div>
            <div><div className="text-[10px] uppercase text-muted-foreground font-mono">Brier</div><div className="font-mono mt-0.5">{score(row.brier_score)}</div></div>
            <div><div className="text-[10px] uppercase text-muted-foreground font-mono">Seal</div><div className="mt-0.5 flex items-center gap-1">{row.integrity_status === "verified" ? <><CheckCircle2 className="h-4 w-4 text-emerald-500" /><span>Verified</span></> : <><AlertTriangle className="h-4 w-4 text-amber-500" /><span>{row.integrity_status}</span></>}</div></div>
          </div>
        </div>)}
      </div>
      <div className="hidden md:block overflow-x-auto"><table className="w-full text-xs min-w-[900px]"><thead className="text-muted-foreground uppercase font-mono"><tr><th className="text-left py-2">Match</th><th>Captured</th><th>Checkpoint</th><th>Pick</th><th>Confidence</th><th>Actual</th><th>Score</th><th>Result</th><th>Brier</th><th>Seal</th></tr></thead><tbody>
        {data.recent.map((row) => <tr key={row.fixture_id} className="border-t border-border/40"><td className="py-2"><div className="font-medium">{row.home_team} v {row.away_team}</div><div className="text-[10px] text-muted-foreground font-mono">FIXTURE {row.fixture_id}</div></td><td className="text-center font-mono">{format(new Date(row.captured_at), "dd MMM HH:mm")}</td><td className="text-center font-mono">{row.checkpoint.replaceAll("_", " ")}</td><td className="text-center font-medium">{outcome(row.predicted_outcome)}</td><td className="text-center font-mono">{row.pick_confidence.toFixed(1)}%</td><td className="text-center">{outcome(row.actual_outcome)}</td><td className="text-center font-mono">{row.actual_outcome ? `${row.score_home ?? "—"}-${row.score_away ?? "—"}` : "—"}</td><td className={`text-center font-bold ${resultClass(row)}`}>{resultText(row)}</td><td className="text-center font-mono">{score(row.brier_score)}</td><td className="text-center">{row.integrity_status === "verified" ? <CheckCircle2 className="h-4 w-4 text-emerald-500 mx-auto" aria-label="Verified" /> : <AlertTriangle className="h-4 w-4 text-amber-500 mx-auto" aria-label={row.integrity_status} />}</td></tr>)}
      </tbody></table></div>
    </Card>

    {challengers.data && <Card className="p-4 border-border/60" data-testid="model-challengers">
      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-2 mb-3"><div><h2 className="font-bold">Model challengers</h2><p className="text-xs text-muted-foreground mt-1">New models run beside the live one on the same matches. One replaces it only after beating it on at least {challengers.data.rules.minMatches} unseen matches, by at least {challengers.data.rules.minBrierImprovement} Brier, and on matches with closing odds.</p></div><Badge variant="secondary" className="font-mono">LIVE MODEL: {challengers.data.champion}</Badge></div>
      <div className="overflow-x-auto"><table className="w-full text-xs min-w-[760px]"><thead className="text-muted-foreground uppercase font-mono"><tr><th className="text-left py-2">Challenger</th><th>Awaiting result</th><th>Matches</th><th>Brier</th><th>Live model</th><th>Gain</th><th>With odds</th><th>Closing odds</th><th title="Log-loss gain on over 2.5 goals / both teams to score">O2.5 / BTTS</th><th className="text-left">Status</th></tr></thead><tbody>
        {challengers.data.standings.map((row) => <tr key={row.challenger} className="border-t border-border/40 align-top"><td className="py-2"><div className="font-medium font-mono">{row.challenger}</div><div className="text-[10px] text-muted-foreground max-w-[260px]">{row.description}</div></td><td className="text-center font-mono">{row.pending ?? 0}</td><td className="text-center font-mono">{row.matches}</td><td className="text-center font-mono">{score(row.brier)}</td><td className="text-center font-mono">{score(row.championBrier)}</td><td className={`text-center font-mono ${row.brierGain != null && row.brierGain > 0 ? "text-emerald-500" : ""}`}>{row.brierGain == null ? "—" : `${row.brierGain > 0 ? "+" : ""}${row.brierGain.toFixed(4)}`}</td><td className="text-center font-mono">{row.marketMatches}</td><td className="text-center font-mono">{score(row.closingOddsBrier)}</td><td className="text-center font-mono text-[10px]">{row.goalMarketMatches ? `${signed(row.over25LogLossGain)} / ${signed(row.bttsLogLossGain)}` : "—"}</td><td className="text-[10px]">{row.eligible ? <span className="text-emerald-500 font-bold">Ready to promote</span> : <span className="text-muted-foreground">{row.reasons[0] ?? "Collecting"}</span>}</td></tr>)}
        {!challengers.data.standings.length && <tr><td colSpan={10} className="py-6 text-center text-muted-foreground">Challengers are recording forecasts; results appear as matches finish.</td></tr>}
      </tbody></table></div>
      <p className="text-[11px] text-muted-foreground mt-2">Gain = how much lower the challenger's Brier score is than the live model's on the same matches (positive is better). Closing odds = bookmakers' Brier on the matches that have odds. O2.5 / BTTS = log-loss gain on goal markets; a challenger may not make them worse.{challengers.data.ratings?.shotStatistics ? ` Shot data: ${challengers.data.ratings.shotStatistics.fixturesWithShots} past matches; stacking model ${challengers.data.ratings.shotStatistics.stackingModel ? `trained on ${challengers.data.ratings.shotStatistics.stackingModel.trainingMatches} matches` : `waiting for ${challengers.data.ratings.shotStatistics.stackingNeeds} training matches`}.` : ""}</p>
    </Card>}

    <div className="pt-2"><h2 className="text-lg font-black">In-play predictions</h2><p className="text-xs text-muted-foreground">Updated during matches as the score and clock change. Late checkpoints are naturally far more accurate, so they are reported separately and never mixed into pre-match results.</p></div>
    {data.inPlay && <div className="grid grid-cols-2 lg:grid-cols-4 gap-3"><Metric label="In-play checkpoints" value={data.inPlay.settled} note="Settled in-play snapshots" /><Metric label="Matches" value={data.inPlay.fixtures} note="With at least one in-play snapshot" /><Metric label="1X2 accuracy" value={pct(data.inPlay.accuracy)} note="All in-play checkpoints" /><Metric label="Brier score" value={score(data.inPlay.brierScore)} note="Lower is better" /></div>}
    {inPlayModel.data && <Card className="p-4 border-border/60" data-testid="inplay-challenger">
      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-2 mb-3"><div><h2 className="font-bold">In-play model challenger</h2><p className="text-xs text-muted-foreground mt-1">The live model's six in-play multipliers refitted on finished matches, scored beside the live model at the same in-play checkpoints. It replaces them only after beating them on {inPlayModel.data.rules.minFixtures} matches, by {inPlayModel.data.rules.minBrierImprovement} Brier at {inPlayModel.data.rules.minTStat} standard errors, counted per match.</p></div><Badge variant="secondary" className="font-mono">IN-PLAY MODEL: {inPlayModel.data.champion}</Badge></div>
      <div className="grid grid-cols-3 md:grid-cols-6 gap-2 mb-3">{Object.entries(inPlayModel.data.defaultParams).map(([k, v]) => <div key={k} className="rounded border border-border/40 p-2"><div className="text-[10px] uppercase text-muted-foreground">{PARAM_LABELS[k] ?? k}</div><div className="font-mono text-sm">{v}{inPlayModel.data.fittedParams ? <span className="text-primary"> → {inPlayModel.data.fittedParams[k]}</span> : null}</div></div>)}</div>
      <p className="text-[11px] text-muted-foreground">{inPlayModel.data.fittedParams ? `Fitted on ${inPlayModel.data.lastFit?.fixtures ?? 0} finished matches; on the newest 20% it scored log loss ${inPlayModel.data.lastFit?.holdout?.fittedLogLoss ?? "—"} vs ${inPlayModel.data.lastFit?.holdout?.defaultLogLoss ?? "—"} for the hand-set values.` : inPlayModel.data.lastFit?.reason ? `Not fitted yet: ${inPlayModel.data.lastFit.reason}.` : "First fit runs a few minutes after start-up."}</p>
      {inPlayModel.data.standings.map((row) => <div key={row.challenger} className="mt-2 text-xs font-mono flex flex-wrap gap-x-4"><span>{row.challenger}</span><span>awaiting {row.pending}</span><span>{row.fixtures} matches · {row.checkpoints} checkpoints</span><span>Brier {score(row.brier)} vs {score(row.championBrier)}</span><span className={row.brierGain != null && row.brierGain > 0 ? "text-emerald-500" : ""}>gain {signed(row.brierGain)}</span><span className="text-muted-foreground">{row.eligible ? "Ready to promote" : row.reasons[0]}</span></div>)}
    </Card>}
    <div className="grid lg:grid-cols-2 gap-4"><BreakdownTable title="In-play Checkpoints" rows={data.inPlayByCheckpoint ?? []} label={(row) => `${(row.checkpoint ?? "").replaceAll("_", " ")} · ${row.data_tier ?? ""}`} /><BreakdownTable title="Pre-match vs In-play (side by side, never combined)" rows={data.byPhase} label={(row) => row.phase === "live" ? "In-play (all checkpoints)" : "Pre-match (all checkpoints)"} /></div>

    <Card className="p-4 border-border/60 bg-muted/20"><h2 className="font-bold text-sm">What “verified” means</h2><div className="grid md:grid-cols-4 gap-3 mt-3 text-xs text-muted-foreground"><div><b className="text-foreground">1. Captured before outcome</b><br />Late pre-match records are automatically rejected.</div><div><b className="text-foreground">2. Cryptographically sealed</b><br />Probabilities, model revision and timestamp are signed.</div><div><b className="text-foreground">3. Settled once</b><br />Final scores are signed and cannot be altered later.</div><div><b className="text-foreground">4. Fail closed</b><br />Unverified or malformed rows never enter headline figures.</div></div></Card>
  </div>;
}
