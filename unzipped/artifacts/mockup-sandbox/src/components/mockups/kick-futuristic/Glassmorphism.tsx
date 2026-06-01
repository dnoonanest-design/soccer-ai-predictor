const matches = [
  { league: "Premier League", country: "England", home: "Arsenal", away: "Man City", time: "34'", live: true, score: "1 – 1", homeProb: 38, drawProb: 28, awayProb: 34 },
  { league: "La Liga", country: "Spain", home: "Real Madrid", away: "Barcelona", time: "67'", live: true, score: "2 – 1", homeProb: 52, drawProb: 22, awayProb: 26 },
  { league: "Bundesliga", country: "Germany", home: "Bayern", away: "Dortmund", time: "01:00 PM", live: false, score: null, homeProb: 61, drawProb: 18, awayProb: 21 },
  { league: "Serie A", country: "Italy", home: "Juventus", away: "Inter", time: "03:30 PM", live: false, score: null, homeProb: 44, drawProb: 27, awayProb: 29 },
];

function MatchCard({ m }: { m: typeof matches[0] }) {
  return (
    <div style={{
      background: "rgba(255,255,255,0.06)",
      backdropFilter: "blur(16px)",
      WebkitBackdropFilter: "blur(16px)",
      border: "1px solid rgba(255,255,255,0.12)",
      borderRadius: 16,
      padding: "14px 16px",
      marginBottom: 10,
      boxShadow: m.live ? "0 0 20px rgba(34,197,94,0.15), inset 0 1px 0 rgba(255,255,255,0.1)" : "inset 0 1px 0 rgba(255,255,255,0.07)",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <span style={{ fontSize: 10, color: "rgba(255,255,255,0.45)", letterSpacing: 1, textTransform: "uppercase", fontFamily: "Inter, sans-serif" }}>
          {m.league} · {m.country}
        </span>
        {m.live
          ? <span style={{ fontSize: 10, background: "rgba(239,68,68,0.25)", border: "1px solid rgba(239,68,68,0.5)", color: "#f87171", padding: "2px 8px", borderRadius: 99, fontFamily: "Inter, sans-serif", fontWeight: 700, display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ width: 5, height: 5, background: "#ef4444", borderRadius: "50%", display: "inline-block" }} />
              {m.time}
            </span>
          : <span style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", fontFamily: "Inter, sans-serif" }}>{m.time}</span>
        }
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <span style={{ color: "#fff", fontSize: 14, fontWeight: 600, fontFamily: "Inter, sans-serif", flex: 1 }}>{m.home}</span>
        <span style={{ color: m.live ? "#22c55e" : "rgba(255,255,255,0.6)", fontSize: 16, fontWeight: 700, fontFamily: "Inter, sans-serif", minWidth: 70, textAlign: "center" }}>
          {m.live ? m.score : "vs"}
        </span>
        <span style={{ color: "#fff", fontSize: 14, fontWeight: 600, fontFamily: "Inter, sans-serif", flex: 1, textAlign: "right" }}>{m.away}</span>
      </div>
      <div style={{ display: "flex", gap: 2, borderRadius: 99, overflow: "hidden", height: 4, marginBottom: 8 }}>
        <div style={{ width: `${m.homeProb}%`, background: "linear-gradient(90deg, #22c55e, #16a34a)", borderRadius: "99px 0 0 99px" }} />
        <div style={{ width: `${m.drawProb}%`, background: "rgba(255,255,255,0.2)" }} />
        <div style={{ width: `${m.awayProb}%`, background: "linear-gradient(90deg, #6366f1, #8b5cf6)", borderRadius: "0 99px 99px 0" }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <span style={{ fontSize: 11, color: "#4ade80", fontFamily: "Inter, sans-serif", fontWeight: 600 }}>{m.homeProb}%</span>
        <span style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", fontFamily: "Inter, sans-serif" }}>{m.drawProb}%</span>
        <span style={{ fontSize: 11, color: "#a78bfa", fontFamily: "Inter, sans-serif", fontWeight: 600 }}>{m.awayProb}%</span>
      </div>
    </div>
  );
}

export function Glassmorphism() {
  return (
    <div style={{
      width: 390, height: 844, overflow: "hidden", position: "relative",
      background: "linear-gradient(145deg, #0a0f1e 0%, #0d1a10 40%, #0f0a1a 100%)",
      fontFamily: "Inter, sans-serif",
    }}>
      <div style={{
        position: "absolute", top: -120, left: -80, width: 300, height: 300,
        background: "radial-gradient(circle, rgba(34,197,94,0.18) 0%, transparent 70%)",
        pointerEvents: "none",
      }} />
      <div style={{
        position: "absolute", top: 200, right: -100, width: 280, height: 280,
        background: "radial-gradient(circle, rgba(99,102,241,0.15) 0%, transparent 70%)",
        pointerEvents: "none",
      }} />

      <div style={{ padding: "54px 16px 12px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 24, fontWeight: 900, color: "#fff", letterSpacing: -1 }}>KICK</span>
          <span style={{ fontSize: 10, background: "rgba(239,68,68,0.2)", border: "1px solid rgba(239,68,68,0.4)", color: "#f87171", padding: "2px 8px", borderRadius: 99, fontWeight: 700, display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ width: 5, height: 5, background: "#ef4444", borderRadius: "50%" }} /> 14 live
          </span>
        </div>
      </div>

      <div style={{ display: "flex", gap: 0, padding: "0 16px", marginBottom: 16, borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
        {["All", "Live", "Upcoming"].map((t, i) => (
          <div key={t} style={{
            padding: "8px 16px", fontSize: 13, fontWeight: i === 0 ? 700 : 400,
            color: i === 0 ? "#22c55e" : "rgba(255,255,255,0.4)",
            borderBottom: i === 0 ? "2px solid #22c55e" : "2px solid transparent",
            cursor: "pointer",
          }}>{t}</div>
        ))}
      </div>

      <div style={{ padding: "0 16px", overflowY: "auto", maxHeight: 680 }}>
        {matches.map((m, i) => <MatchCard key={i} m={m} />)}
      </div>

      <div style={{
        position: "absolute", bottom: 0, left: 0, right: 0, height: 80,
        background: "rgba(10,15,30,0.85)",
        backdropFilter: "blur(20px)",
        borderTop: "1px solid rgba(255,255,255,0.08)",
        display: "flex", alignItems: "center", justifyContent: "space-around",
        padding: "0 16px 12px",
      }}>
        {[["⚽", "Matches"], ["🏆", "Leagues"], ["⚡", "Value"]].map(([icon, label], i) => (
          <div key={label} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
            <span style={{ fontSize: 20 }}>{icon}</span>
            <span style={{ fontSize: 10, color: i === 0 ? "#22c55e" : "rgba(255,255,255,0.4)", fontWeight: i === 0 ? 700 : 400 }}>{label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
