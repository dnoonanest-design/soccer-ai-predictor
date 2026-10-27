import {
  useGetMatch, getGetMatchQueryKey,
  useGetMatchPresentation, getGetMatchPresentationQueryKey,
  PresentationPlayer, PresentationTeam, PresentationLeader, PresentationScoringForm, PresentationLineupStatus,
} from "@workspace/api-client-react";
import { useParams } from "wouter";
import { Flame, Star, Users } from "lucide-react";
import { MatchBreadcrumb } from "@/components/match-breadcrumb";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

function PlayerMetric({ label, player, suffix }: { label: string; player: PresentationPlayer | null; suffix: string }) {
  return <div className="min-w-0 rounded-lg border border-border/50 bg-background/50 px-3 py-2.5">
    <div className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground">{label}</div>
    {player ? <div className="mt-1 flex items-center justify-between gap-2"><span className="truncate text-xs font-semibold">{player.name}</span><span className="whitespace-nowrap font-mono text-[10px] text-primary">{player.value ?? 0}{suffix}</span></div> : <div className="mt-1 text-xs text-muted-foreground">Unavailable</div>}
  </div>;
}

const STATUS: Record<PresentationLineupStatus, { label: string; cls: string }> = {
  starting: { label: "Starting", cls: "bg-emerald-500/15 text-emerald-400" },
  bench: { label: "Bench", cls: "bg-sky-500/15 text-sky-400" },
  not_in_squad: { label: "Not in squad", cls: "bg-muted text-muted-foreground" },
  injured_or_suspended: { label: "Out", cls: "bg-rose-500/15 text-rose-400" },
  doubtful: { label: "Doubtful", cls: "bg-amber-500/15 text-amber-400" },
};

function StatusBadge({ status, reason }: { status?: PresentationLineupStatus | null; reason?: string | null }) {
  if (!status) return null;
  const s = STATUS[status];
  return <span title={reason ?? undefined} className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase ${s.cls}`}>{s.label}</span>;
}

function LeaderList({ title, players, render }: { title: string; players: PresentationLeader[]; render: (p: PresentationLeader) => string }) {
  return <div className="min-w-0 rounded-lg border border-border/50 bg-background/50 p-2.5">
    <div className="mb-1.5 font-mono text-[9px] uppercase tracking-widest text-muted-foreground">{title}</div>
    {players.length ? <ol className="space-y-1">{players.map((p, i) => <li key={p.id} className="flex items-center gap-1.5 text-xs">
      <span className="w-3 font-mono text-[9px] text-muted-foreground">{i + 1}</span>
      <span className="min-w-0 flex-1 truncate font-semibold">{p.name}</span>
      <StatusBadge status={p.lineup_status} reason={p.absence_reason}/>
      <span className="whitespace-nowrap font-mono text-[10px] text-primary">{render(p)}</span>
    </li>)}</ol> : <p className="text-xs text-muted-foreground">Unavailable</p>}
  </div>;
}

function ScoringForm({ entries, matches }: { entries: PresentationScoringForm[]; matches: number }) {
  return <div className="rounded-lg border border-border/50 bg-background/40 p-3" data-testid="scoring-form">
    <div className="mb-2 flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-widest text-muted-foreground"><Flame className="h-3 w-3 text-orange-400"/>Goal-scoring form</div>
    {entries.length ? <div className="space-y-1.5">{entries.map((p) => <div key={p.id} className="flex items-center gap-2 text-xs">
      <span className="min-w-0 flex-1 truncate font-semibold">{p.name}</span>
      <StatusBadge status={p.lineup_status}/>
      <span className="whitespace-nowrap font-mono text-[10px] text-orange-400">
        {p.scoring_streak >= 2 ? `scored in ${p.scoring_streak} in a row · ` : ""}{p.goals_last5} in last {p.matches_last5}
      </span>
    </div>)}</div> : <p className="text-xs text-muted-foreground">No player has scored in 2+ games in a row or 3+ in the last 5.</p>}
    <p className="mt-2 text-[9px] text-muted-foreground/60">From the team's last {matches} matches with player data in our records (some cup ties have none).</p>
  </div>;
}

function SquadList({ title, players }: { title: string; players: PresentationPlayer[] }) {
  return <div><div className="mb-2 font-mono text-[9px] uppercase tracking-widest text-muted-foreground">{title}</div>{players.length ? <div className="space-y-1.5">{players.map((p) => <div key={p.id} className="flex items-center gap-2 text-xs"><span className="w-6 text-right font-mono text-muted-foreground">{p.number ?? "–"}</span><span className="truncate">{p.name}</span>{p.position && <span className="ml-auto font-mono text-[9px] text-muted-foreground">{p.position}</span>}</div>)}</div> : <p className="text-xs text-muted-foreground">Not announced</p>}</div>;
}

function formationGrid(players: PresentationPlayer[], formation: string | null) {
  const lines = (formation ?? "").split("-").map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const fallbackRows = [1, ...lines];
  return players.map((player, playerIndex) => {
    const [providerRow, providerColumn] = (player.grid ?? "").split(":").map(Number);
    if (providerRow > 0 && providerColumn > 0) return { player, row: providerRow, column: providerColumn };
    let consumed = 0;
    for (let row = 0; row < fallbackRows.length; row += 1) {
      const next = consumed + fallbackRows[row];
      if (playerIndex < next) return { player, row: row + 1, column: playerIndex - consumed + 1 };
      consumed = next;
    }
    return { player, row: fallbackRows.length, column: 1 };
  });
}

function FormationPitch({ team, side }: { team: PresentationTeam; side: "home" | "away" }) {
  if (!team.starting_xi.length) return <div className="rounded-xl border border-border/50 bg-background/40 p-4 text-center text-xs text-muted-foreground">Starting XI not announced</div>;
  const placed = formationGrid(team.starting_xi, team.formation);
  const maxRow = Math.max(...placed.map((entry) => entry.row), 1);
  const rowCounts = new Map<number, number>();
  placed.forEach((entry) => rowCounts.set(entry.row, Math.max(rowCounts.get(entry.row) ?? 0, entry.column)));
  const accent = side === "home" ? "border-primary bg-primary text-primary-foreground" : "border-chart-2 bg-chart-2 text-background";
  return <div>
    <div className="mb-2 flex items-center justify-between"><span className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground">Starting XI · pitch view</span><span className="font-mono text-[9px] text-muted-foreground">{team.formation ?? "Formation unavailable"}</span></div>
    <div className="relative aspect-[3/4] overflow-hidden rounded-xl border border-emerald-300/30 bg-[linear-gradient(90deg,rgba(16,85,54,.96),rgba(19,105,65,.96),rgba(16,85,54,.96))] shadow-inner">
      <div className="absolute inset-3 rounded border border-white/30"/>
      <div className="absolute left-3 right-3 top-1/2 border-t border-white/30"/>
      <div className="absolute left-1/2 top-1/2 h-20 w-20 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/30"/>
      <div className="absolute left-1/2 top-3 h-14 w-32 -translate-x-1/2 border border-t-0 border-white/30"/>
      <div className="absolute bottom-3 left-1/2 h-14 w-32 -translate-x-1/2 border border-b-0 border-white/30"/>
      {placed.map(({ player, row, column }) => {
        const count = rowCounts.get(row) ?? 1;
        const x = (column / (count + 1)) * 100;
        const y = maxRow === 1 ? 50 : 90 - ((row - 1) / (maxRow - 1)) * 80;
        return <div key={player.id} className="absolute z-10 flex w-[27%] -translate-x-1/2 -translate-y-1/2 flex-col items-center text-center" style={{ left: `${x}%`, top: `${y}%` }}>
          <span className={`flex h-8 w-8 items-center justify-center rounded-full border-2 border-white/80 text-[10px] font-black shadow-lg ${accent}`}>{player.number ?? "–"}</span>
          <span className="mt-1 max-w-full truncate rounded bg-black/70 px-1.5 py-0.5 text-[9px] font-semibold leading-tight text-white shadow">{player.name}</span>
        </div>;
      })}
    </div>
  </div>;
}

function TeamSquad({ team, side }: { team: PresentationTeam; side: "home" | "away" }) {
  const color = side === "home" ? "text-primary" : "text-chart-2";
  return <div className="min-w-0 space-y-4">
    <div className="flex items-start justify-between gap-3 border-b border-border/50 pb-3"><div><h2 className="truncate text-lg font-bold">{team.team_name}</h2><p className="mt-1 font-mono text-[10px] text-muted-foreground">Coach: {team.coach ?? "Not available"}</p></div>{team.formation && <span className={`rounded-full border border-current/20 bg-current/5 px-2 py-1 font-mono text-[10px] font-bold ${color}`}>{team.formation}</span>}</div>
    {team.top_scorers ? <>
      <ScoringForm entries={team.scoring_form ?? []} matches={team.scoring_form_matches ?? 0}/>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <LeaderList title="Star players · season rating" players={team.star_players ?? []} render={(p) => `${p.rating?.toFixed(2) ?? "–"} · ${p.appearances ?? 0} apps`}/>
        <LeaderList title="Top scorers" players={team.top_scorers} render={(p) => `${p.goals} goals`}/>
        <LeaderList title="Top assists" players={team.top_assisters ?? []} render={(p) => `${p.assists} assists`}/>
        <LeaderList title="Most fouls" players={team.most_fouls ?? []} render={(p) => `${p.fouls} fouls · ${p.yellow_cards}🟨${p.red_cards ? ` ${p.red_cards}🟥` : ""}`}/>
      </div>
    </> : <>
      <div className="grid grid-cols-2 gap-2"><PlayerMetric label="Star player" player={team.star_player} suffix=" rating"/><PlayerMetric label="Most goals" player={team.top_scorer} suffix=" goals"/><PlayerMetric label="Most assists" player={team.top_assister} suffix=" assists"/><PlayerMetric label="Most fouls" player={team.top_fouler} suffix=" fouls"/></div>
      <div className="rounded-lg border border-border/50 bg-background/40 p-3"><div className="mb-2 font-mono text-[9px] uppercase tracking-widest text-muted-foreground">Players in form · season rating</div>{team.in_form.length ? <div className="flex flex-wrap gap-2">{team.in_form.map((p) => <span key={p.id} className="inline-flex gap-1.5 rounded-full bg-muted px-2.5 py-1 text-[10px]"><span className="font-semibold">{p.name}</span><span className={color}>{p.value}</span></span>)}</div> : <p className="text-xs text-muted-foreground">No rated player data available.</p>}</div>
    </>}
    <FormationPitch team={team} side={side}/>
    <div className="rounded-lg border border-border/50 bg-background/40 p-3"><SquadList title="Substitutes" players={team.substitutes}/></div>
  </div>;
}

/** Lineups and player stats for one match (used on the match page's Teams tab and on its own page). */
export function SquadPanel({ matchId }: { matchId: number }) {
  const { data, isLoading, isError } = useGetMatchPresentation(matchId, { query: {
    // Every minute until lineups are published (the server re-checks the provider every 2 minutes near kickoff).
    refetchInterval: (q) => (q.state.data?.lineups_announced ? 5 * 60_000 : 60_000),
    queryKey: getGetMatchPresentationQueryKey(matchId),
  } });
  return <Card className="overflow-hidden border-border/50"><div className="space-y-5 p-5">
    {isLoading ? <div className="grid gap-4 sm:grid-cols-2"><Skeleton className="h-72"/><Skeleton className="h-72"/></div> : isError || !data ? <p className="py-8 text-center text-xs text-muted-foreground">Lineup and player data are temporarily unavailable.</p> : <><div className={`rounded-lg border px-3 py-2 font-mono text-[10px] ${data.lineups_announced ? "border-primary/25 bg-primary/5 text-primary" : "border-amber-400/25 bg-amber-400/5 text-amber-300"}`}><span className="inline-flex items-center gap-1.5"><Star className="h-3 w-3"/>{data.note}</span></div><div className="grid gap-6 lg:grid-cols-2 lg:divide-x lg:divide-border/50"><TeamSquad team={data.home} side="home"/><div className="lg:pl-6"><TeamSquad team={data.away} side="away"/></div></div><p className="font-mono text-[9px] text-muted-foreground/60">Source: {data.source}. Player leaders are season-to-date and never derived from this fixture's result.</p></>}
  </div></Card>;
}

export default function MatchSquad() {
  const { id } = useParams<{ id: string }>();
  const matchId = Number(id);
  const { data: match } = useGetMatch(matchId, { query: { queryKey: getGetMatchQueryKey(matchId) } });
  return <div className="mx-auto max-w-[1400px] space-y-5">
    <MatchBreadcrumb matchId={matchId} match={match} current="Lineups & players" />
    <div><div className="flex items-center gap-2"><Users className="h-5 w-5 text-primary"/><h1 className="text-2xl font-bold">Team lineups & player stats</h1></div><p className="mt-1 text-sm text-muted-foreground">{match ? `${match.home_team.name} vs ${match.away_team.name}` : "Match squad intelligence"}</p></div>
    <SquadPanel matchId={matchId} />
  </div>;
}
