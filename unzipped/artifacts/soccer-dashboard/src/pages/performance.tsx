import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { decimalToFractional } from "@/lib/odds";

type Accuracy = {
  totalPredictions: number;
  correctPicks: number;
  pickAccuracy: number;
  brierScore: number;
  byOutcome: Record<string, { predicted: number; actual: number; correct: number }>;
  recentResults: Array<{ fixtureId: number; homeTeam: string; awayTeam: string; predicted: string; actual: string; correct: boolean; brierScore: number }>;
};

type Tracker = {
  openBets: number;
  settledBets: number;
  winRate: number;
  totalStake: number;
  profit: number;
  roiPct: number;
  recent: Array<{ id: number; homeTeam: string; awayTeam: string; market: string; selection: string; decimalOdds: number; stake: string; status: string; profit?: string | null; edgePct?: number | null }>;
};

type TrainingRuns = { runs: Array<{ id: number; modelVersion: string; trainingRows: number; holdoutRows: number; pickAccuracy: number; brierScore: number; notes?: string | null; createdAt: string }> };

type Calibration = {
  sampleSize: number;
  pickAccuracy: number;
  brierScore: number;
  logLoss: number;
  expectedCalibrationError: number;
  recommendation: string;
  buckets: Array<{ outcome: string; bucket: string; count: number; averagePredicted: number; actualRate: number; correctionFactor: number }>;
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <Card className="p-4 border-border/50">
      <div className="text-[10px] uppercase tracking-widest text-muted-foreground font-mono">{label}</div>
      <div className="text-2xl font-black font-mono mt-1">{value}</div>
    </Card>
  );
}

export default function Performance() {
  const accuracy = useQuery({ queryKey: ["accuracy"], queryFn: () => api<Accuracy>("/api/accuracy"), refetchInterval: 60000 });
  const tracker = useQuery({ queryKey: ["tracker"], queryFn: () => api<Tracker>("/api/tracker"), refetchInterval: 60000 });
  const training = useQuery({ queryKey: ["training"], queryFn: () => api<TrainingRuns>("/api/training"), refetchInterval: 60000 });
  const calibration = useQuery({ queryKey: ["calibration"], queryFn: () => api<Calibration>("/api/calibration"), refetchInterval: 60000 });

  const runTraining = async () => {
    await api("/api/training/run", { method: "POST" });
    await Promise.all([training.refetch(), calibration.refetch()]);
  };

  const settleFinished = async () => {
    await api("/api/outcomes/settle-finished", { method: "POST" });
    await Promise.all([accuracy.refetch(), calibration.refetch(), training.refetch()]);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-black tracking-tight">Prediction Performance</h1>
        <p className="text-sm text-muted-foreground mt-1">Accuracy, ROI tracking and model-training health.</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Metric label="Predictions" value={accuracy.data?.totalPredictions ?? "—"} />
        <Metric label="Pick Accuracy" value={accuracy.data ? `${Math.round(accuracy.data.pickAccuracy * 100)}%` : "—"} />
        <Metric label="Brier Score" value={accuracy.data?.brierScore ?? "—"} />
        <Metric label="Calibration Error" value={calibration.data?.expectedCalibrationError ?? "—"} />
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <Card className="p-4 border-border/50">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-bold">Training Pipeline</h2>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={settleFinished}>Settle results</Button>
              <Button size="sm" onClick={runTraining}>Run training</Button>
            </div>
          </div>
          <div className="space-y-2 text-sm">
            {(training.data?.runs ?? []).slice(0, 5).map((r) => (
              <div key={r.id} className="border border-border/50 rounded p-2">
                <div className="font-mono font-bold">{r.modelVersion}</div>
                <div className="text-muted-foreground text-xs">Rows: {r.trainingRows} train / {r.holdoutRows} holdout · Accuracy {Math.round((r.pickAccuracy ?? 0) * 100)}% · Brier {r.brierScore ?? "—"}</div>
                {r.notes && <div className="text-xs mt-1 text-muted-foreground">{r.notes}</div>}
              </div>
            ))}
            {training.data?.runs?.length === 0 && <div className="text-muted-foreground">No training runs yet.</div>}
          </div>
        </Card>

        <Card className="p-4 border-border/50">
          <h2 className="font-bold mb-3">Bet Tracker</h2>
          <div className="grid grid-cols-3 gap-2 mb-3 text-center font-mono">
            <div><div className="text-muted-foreground text-[10px]">OPEN</div><div className="font-black">{tracker.data?.openBets ?? "—"}</div></div>
            <div><div className="text-muted-foreground text-[10px]">WIN RATE</div><div className="font-black">{tracker.data ? `${tracker.data.winRate}%` : "—"}</div></div>
            <div><div className="text-muted-foreground text-[10px]">PROFIT</div><div className="font-black">{tracker.data?.profit ?? "—"}</div></div>
          </div>
          <div className="space-y-2 text-xs">
            {(tracker.data?.recent ?? []).slice(0, 8).map((b) => (
              <div key={b.id} className="flex justify-between gap-2 border-b border-border/40 pb-1">
                <span>{b.homeTeam} v {b.awayTeam} · {b.market} {b.selection}</span>
                <span className="font-mono">{decimalToFractional(Number(b.decimalOdds))} · {b.status}</span>
              </div>
            ))}
            {tracker.data?.recent?.length === 0 && <div className="text-muted-foreground">No tracked bets yet.</div>}
          </div>
        </Card>
      </div>



      <Card className="p-4 border-border/50">
        <div className="flex items-center justify-between gap-3 mb-3">
          <div>
            <h2 className="font-bold">Machine-Learning Calibration</h2>
            <p className="text-xs text-muted-foreground">Compares predicted percentages against actual results, then feeds bucket correction into the model.</p>
          </div>
          <a className="text-xs underline text-muted-foreground" href="/api/training/dataset" target="_blank" rel="noreferrer">Export dataset</a>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3 text-center font-mono">
          <div><div className="text-muted-foreground text-[10px]">SAMPLE</div><div className="font-black">{calibration.data?.sampleSize ?? "—"}</div></div>
          <div><div className="text-muted-foreground text-[10px]">LOG LOSS</div><div className="font-black">{calibration.data?.logLoss ?? "—"}</div></div>
          <div><div className="text-muted-foreground text-[10px]">ECE</div><div className="font-black">{calibration.data?.expectedCalibrationError ?? "—"}</div></div>
          <div><div className="text-muted-foreground text-[10px]">ACCURACY</div><div className="font-black">{calibration.data ? `${Math.round(calibration.data.pickAccuracy * 100)}%` : "—"}</div></div>
        </div>
        {calibration.data?.recommendation && <p className="text-xs text-muted-foreground mb-3">{calibration.data.recommendation}</p>}
        <div className="overflow-x-auto max-h-72">
          <table className="w-full text-xs">
            <thead className="text-muted-foreground uppercase font-mono">
              <tr><th className="text-left py-2">Outcome</th><th>Bucket</th><th>Count</th><th>Predicted</th><th>Actual</th><th>Factor</th></tr>
            </thead>
            <tbody>
              {(calibration.data?.buckets ?? []).filter((b) => b.count >= 5).slice(0, 30).map((b, i) => (
                <tr key={`${b.outcome}-${b.bucket}-${i}`} className="border-t border-border/40">
                  <td className="py-1 font-mono">{b.outcome}</td>
                  <td className="text-center font-mono">{b.bucket}</td>
                  <td className="text-center font-mono">{b.count}</td>
                  <td className="text-center font-mono">{b.averagePredicted}%</td>
                  <td className="text-center font-mono">{b.actualRate}%</td>
                  <td className="text-center font-mono">{b.correctionFactor}x</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="p-4 border-border/50">
        <h2 className="font-bold mb-3">Recent Prediction Results</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground uppercase font-mono">
              <tr><th className="text-left py-2">Match</th><th>Pick</th><th>Actual</th><th>Result</th><th>Brier</th></tr>
            </thead>
            <tbody>
              {(accuracy.data?.recentResults ?? []).map((r) => (
                <tr key={r.fixtureId} className="border-t border-border/40">
                  <td className="py-2">{r.homeTeam} v {r.awayTeam}</td>
                  <td className="text-center font-mono">{r.predicted}</td>
                  <td className="text-center font-mono">{r.actual}</td>
                  <td className={`text-center font-mono ${r.correct ? "text-primary" : "text-destructive"}`}>{r.correct ? "WIN" : "MISS"}</td>
                  <td className="text-center font-mono">{r.brierScore}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
