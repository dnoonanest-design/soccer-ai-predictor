import { Link } from "wouter";
import { ChevronRight } from "lucide-react";
import type { Match } from "@workspace/api-client-react";

/** "Matches › Competition › Home v Away › Section" so people always know where they are and can step back. */
export function MatchBreadcrumb({ matchId, match, current }: { matchId: number; match?: Match | null; current?: string }) {
  const crumbs: Array<{ label: string; href?: string }> = [
    { label: "Matches", href: "/" },
    ...(match ? [{ label: match.league_name, href: `/?league_id=${match.league_id}` }] : []),
    { label: match ? `${match.home_team.name} v ${match.away_team.name}` : "Match", href: current ? `/matches/${matchId}` : undefined },
    ...(current ? [{ label: current }] : []),
  ];
  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 overflow-x-auto whitespace-nowrap text-sm text-muted-foreground" data-testid="breadcrumb">
      {crumbs.map((c, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 && <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-60" />}
          {c.href ? <Link href={c.href} className="hover:text-foreground">{c.label}</Link> : <span className="text-foreground" aria-current="page">{c.label}</span>}
        </span>
      ))}
    </nav>
  );
}
