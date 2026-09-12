import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { format } from "date-fns";
import { AlertTriangle, CheckCircle2, Database, Fingerprint, LockKeyhole, RefreshCw, ShieldCheck } from "lucide-react";

type MetricRow = { phase?: string; checkpoint?: string; confidence_band?: string; model_version?: string; engine_revision?: string; samples: number; accuracy: number | null; brierScore: number | null; logLoss: number | null; averageConfidence: number | null };
type Totals = { captured: number; fixtures: number; settled: number; pending: number; accuracy: number | null; brierScore: number | null; logLoss: number | null; over25Accuracy: number | null; bttsAccuracy: number | null };
type AuditReport = {
  generatedAt: string;
  dataMaturity: "collecting" | "developing" | "mature";
  integrity: { status: "verified" | "integrity-failed" | "signing-key-required" | "collecting"; signing: string; checked: number; verified: number; unsigned: number; invalid: number; latePrematch: number; invalidProbability: number; resultMismatch: number; coveragePct: number; verifiedAt: string };
  certified: Totals;
  overall: Totals;
  byPhase: MetricRow[];
  byCheckpoint: MetricRow[];
  byConfidence: MetricRow[];
  byModel: MetricRow[];
  recent: Array<{ id: number; fixture_id: number; home_team: string; away_team: string; phase: string; checkpoint: string; predicted_outcome: string; actual_outcome: string | null; pick_confidence: number; correct: boolean | null; brier_score: number | null; captured_at: string; integrity_status: "verified" | "invalid" | "legacy-unsigned" }>;
};

async function api<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

const pct = (value: number | null | undefined) => value == null ? "—" : `${(value * 100).toFixed(1)}%`;
const score = (value: number | null | undefined) => value == null ? "—" : value.toFixed(3);
const outcome = (value: string | null) => !value ? "Pending" : value === "home" ? "Home" : value === "away" ? "Away" : "Draw";

function Metric({ label, value, note }: { label: string; value: string | number; note: string }) {
  return <Card className="p-4 border-border/60 bg-card/70"><div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground font-mono">{label}</div><div className="text-2xl font-black font-mono mt-1">{value}</div><div className="text-[11px] text-muted-foreground mt-1">{note}</div></Card>;
}

function BreakdownTable({ title, rows, label }: { title: string; rows: MetricRow[]; label: (row: MetricRow) => string }) {
  return <Card className="p-4 border-border/60">
    <h2 className="font-bold mb-1">{title}</h2><p className="text-xs text-muted-foreground mb-3">Only cryptographically verified and eligible records.</p>
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
  if (report.isLoading) return <div className="min-h-[45vh] flex items-center justify-center text-muted-foreground"><RefreshCw className="h-5 w-5 animate-spin mr-2" /> Verifying performance ledger…</div>;
  if (report.isError || !report.data) return <Card className="p-6 border-destructive/50"><div className="flex items-center gap-2 font-bold text-destructive"><AlertTriangle className="h-5 w-5" />Performance verification unavailable</div><p className="text-sm text-muted-foreground mt-2">No figures are displayed because the audit source could not be verified.</p></Card>;

  const data = report.data;
  const integrityOk = data.integrity.status === "verified";
  const keyMissing = data.integrity.status === "signing-key-required";
  const hasCertifiedResults = data.certified.settled > 0;
  return <div className="space-y-5 max-w-[1500px] mx-auto">
    <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-3"><div><div className="flex flex-wrap items-center gap-2"><h1 className="text-2xl font-black tracking-tight">Verified Performance</h1><Badge variant="outline" className={integrityOk ? "border-emerald-500/60 text-emerald-500" : "border-amber-500/60 text-amber-500"}>{integrityOk ? hasCertifiedResults ? "AUDIT VERIFIED" : "VERIFIED · COLLECTING" : keyMissing ? "SIGNING SETUP REQUIRED" : "INTEGRITY WARNING"}</Badge></div><p className="text-sm text-muted-foreground mt-1">Immutable prediction snapshots, independently settled after full time.</p></div><div className="text-xs font-mono text-muted-foreground">VERIFIED {format(new Date(data.integrity.verifiedAt), "dd MMM yyyy HH:mm:ss")}</div></div>

    <Card className={`p-4 border ${integrityOk ? "border-emerald-500/40 bg-emerald-500/5" : "border-amber-500/40 bg-amber-500/5"}`}><div className="flex flex-col md:flex-row md:items-center gap-4">
      <div className={`h-11 w-11 rounded-full flex items-center justify-center ${integrityOk ? "bg-emerald-500/15 text-emerald-500" : "bg-amber-500/15 text-amber-500"}`}>{integrityOk ? <ShieldCheck className="h-6 w-6" /> : <AlertTriangle className="h-6 w-6" />}</div>
      <div className="flex-1"><div className="font-bold">{integrityOk ? hasCertifiedResults ? "Performance ledger passed every integrity check" : "Integrity is verified; certified results are still being collected" : keyMissing ? "Add the production signing key to certify new predictions" : data.integrity.status === "collecting" ? "Signing is active; the first verified results are being collected" : "Some records failed verification and are excluded"}</div><div className="text-xs text-muted-foreground mt-1">{data.integrity.signing} · {data.integrity.verified} verified · {data.integrity.unsigned} legacy unsigned · {data.integrity.invalid} invalid · {data.integrity.resultMismatch} result mismatches · {data.integrity.coveragePct}% coverage</div></div>
      <div className="flex gap-5 text-center font-mono text-xs"><div><Fingerprint className="h-4 w-4 mx-auto mb-1 text-primary" /><b>{data.integrity.checked}</b><div className="text-muted-foreground">CHECKED</div></div><div><LockKeyhole className="h-4 w-4 mx-auto mb-1 text-primary" /><b>{data.certified.settled}</b><div className="text-muted-foreground">CERTIFIED</div></div><div><Database className="h-4 w-4 mx-auto mb-1 text-primary" /><b>{data.certified.pending}</b><div className="text-muted-foreground">PENDING</div></div></div>
    </div></Card>

    <div className="grid grid-cols-2 lg:grid-cols-6 gap-3"><Metric label="Audited fixtures" value={data.certified.fixtures} note="Signed matches, including pending" /><Metric label="1X2 accuracy" value={pct(data.certified.accuracy)} note="Highest probability pick" /><Metric label="Brier score" value={score(data.certified.brierScore)} note="Lower is better" /><Metric label="Log loss" value={score(data.certified.logLoss)} note="Penalises overconfidence" /><Metric label="Over 2.5" value={pct(data.certified.over25Accuracy)} note="Certified market accuracy" /><Metric label="BTTS" value={pct(data.certified.bttsAccuracy)} note="Certified market accuracy" /></div>

    <div className="grid lg:grid-cols-2 gap-4"><BreakdownTable title="Pre-match vs In-play" rows={data.byPhase} label={(row) => row.phase === "live" ? "In-play" : "Pre-match"} /><BreakdownTable title="Checkpoint Accuracy" rows={data.byCheckpoint} label={(row) => `${row.phase === "live" ? "Live" : "Pre-match"} · ${(row.checkpoint ?? "").replaceAll("_", " ")}`} /></div>
    <div className="grid lg:grid-cols-2 gap-4"><BreakdownTable title="Confidence Calibration" rows={data.byConfidence} label={(row) => row.confidence_band ?? "Unknown"} /><BreakdownTable title="Model Revisions" rows={data.byModel} label={(row) => `${row.model_version ?? "Unknown"} · ${row.engine_revision ?? "unknown"}`} /></div>

    <Card className="p-4 border-border/60"><div className="flex items-start justify-between gap-3 mb-3"><div><h2 className="font-bold">Prediction Ledger</h2><p className="text-xs text-muted-foreground mt-1">Original checkpoint, timestamp and result. Entries cannot be edited or removed through the application.</p></div><Badge variant="secondary" className="font-mono">{data.dataMaturity.toUpperCase()}</Badge></div>
      <div className="overflow-x-auto"><table className="w-full text-xs min-w-[900px]"><thead className="text-muted-foreground uppercase font-mono"><tr><th className="text-left py-2">Match</th><th>Captured</th><th>Checkpoint</th><th>Pick</th><th>Confidence</th><th>Actual</th><th>Result</th><th>Brier</th><th>Seal</th></tr></thead><tbody>
        {data.recent.map((row) => <tr key={row.id} className="border-t border-border/40"><td className="py-2"><div className="font-medium">{row.home_team} v {row.away_team}</div><div className="text-[10px] text-muted-foreground font-mono">FIXTURE {row.fixture_id}</div></td><td className="text-center font-mono">{format(new Date(row.captured_at), "dd MMM HH:mm")}</td><td className="text-center font-mono">{row.checkpoint.replaceAll("_", " ")}</td><td className="text-center font-medium">{outcome(row.predicted_outcome)}</td><td className="text-center font-mono">{row.pick_confidence.toFixed(1)}%</td><td className="text-center">{outcome(row.actual_outcome)}</td><td className={`text-center font-bold ${row.correct == null ? "text-muted-foreground" : row.correct ? "text-emerald-500" : "text-destructive"}`}>{row.correct == null ? "PENDING" : row.correct ? "WIN" : "MISS"}</td><td className="text-center font-mono">{score(row.brier_score)}</td><td className="text-center">{row.integrity_status === "verified" ? <CheckCircle2 className="h-4 w-4 text-emerald-500 mx-auto" aria-label="Verified" /> : <AlertTriangle className="h-4 w-4 text-amber-500 mx-auto" aria-label={row.integrity_status} />}</td></tr>)}
      </tbody></table></div>
    </Card>

    <Card className="p-4 border-border/60 bg-muted/20"><h2 className="font-bold text-sm">What “verified” means</h2><div className="grid md:grid-cols-4 gap-3 mt-3 text-xs text-muted-foreground"><div><b className="text-foreground">1. Captured before outcome</b><br />Late pre-match records are automatically rejected.</div><div><b className="text-foreground">2. Cryptographically sealed</b><br />Probabilities, model revision and timestamp are signed.</div><div><b className="text-foreground">3. Settled once</b><br />Final scores are signed and cannot be altered later.</div><div><b className="text-foreground">4. Fail closed</b><br />Unverified or malformed rows never enter headline figures.</div></div></Card>
  </div>;
}
