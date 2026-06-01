const matches = [
  { league: "Premier League", country: "England", home: "Arsenal", away: "Man City", time: "34'", live: true, score: "1 – 1", homeProb: 38, drawProb: 28, awayProb: 34 },
  { league: "La Liga", country: "Spain", home: "Real Madrid", away: "Barcelona", time: "67'", live: true, score: "2 – 1", homeProb: 52, drawProb: 22, awayProb: 26 },
  { league: "Bundesliga", country: "Germany", home: "Bayern", away: "Dortmund", time: "01:00 PM", live: false, score: null, homeProb: 61, drawProb: 18, awayProb: 21 },
  { league: "Serie A", country: "Italy", home: "Juventus", away: "Inter", time: "03:30 PM", live: false, score: null, homeProb: 44, drawProb: 27, awayProb: 29 },
];

const holoGradient = "linear-gradient(135deg, #c0f0ff, #b8e0ff, #d4b8ff, #ffb8e8, #b8ffdc, #ffe8b8, #b8d0ff)";

function MatchCard({ m }: { m: typeof matches[0] }) {
  return (
    <div style={{
      position: "relative",
      borderRadius: 14,
      padding: 1,
      marginBottom: 10,
      background: m.live ? holoGradient : "linear-gradient(135deg, #2a2a2a, #1a1a1a)",
      boxShadow: m.live ? "0 4px 24px rgba(180,160,255,0.2)" : "0 2px 8px rgba(0,0,0,0.4)",
    }}>
      <div style={{
        background: "linear-gradient(160deg, #111118 0%, #0d0d14 100%)",
        borderRadius: 13,
        padding: "13px 15px",
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <span style={{ fontSize: 10, color: "#666", letterSpacing: 0.5, fontFamily: "Inter, sans-serif" }}>
            {m.league} · {m.country}
          </span>
          {m.live
            ? <span style={{ fontSize: 10, background: "rgba(239,68,68,0.15)", border: "1px solid rgba(239,68,68,0.3)", color: "#f87171", padding: "2px 8px", borderRadius: 99, fontFamily: "Inter, sans-serif", fontWeight: 600 }}>
                ● {m.time}
              </span>
            : <span style={{ fontSize: 10, color: "#555", fontFamily: "Inter, sans-serif" }}>{m.time}</span>
          }
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <span style={{ color: "#d4d4d4", fontSize: 13, fontWeight: 600, fontFamily: "Inter, sans-serif", flex: 1 }}>{m.home}</span>
          <span style={{
            fontSize: 15, fontWeight: 800, fontFamily: "Inter, sans-serif",
            minWidth: 70, textAlign: "center",
            background: m.live ? holoGradient : "none",
            WebkitBackgroundClip: m.live ? "text" : "none",
            WebkitTextFillColor: m.live ? "transparent" : "#555",
            backgroundClip: m.live ? "text" : "none",
          }}>
            {m.live ? m.score : "vs"}
          </span>
          <span style={{ color: "#d4d4d4", fontSize: 13, fontWeight: 600, fontFamily: "Inter, sans-serif", flex: 1, textAlign: "right" }}>{m.away}</span>
        </div>
        <div style={{ position: "relative", height: 4, borderRadius: 99, background: "#1e1e1e", overflow: "hidden", marginBottom: 8 }}>
          <div style={{ position: "absolute", left: 0, top: 0, width: `${m.homeProb}%`, height: "100%", background: "linear-gradient(90deg, #4ade80, #22c55e)", borderRadius: "99px 0 0 99px" }} />
          <div style={{ position: "absolute", left: `${m.homeProb}%`, top: 0, width: `${m.drawProb}%`, height: "100%", background: "#222" }} />
          <div style={{ position: "absolute", right: 0, top: 0, width: `${m.awayProb}%`, height: "100%", background: "linear-gradient(90deg, #818cf8, #a78bfa)", borderRadius: "0 99px 99px 0" }} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ fontSize: 11, color: "#4ade80", fontFamily: "Inter, sans-serif", fontWeight: 600 }}>{m.homeProb}%</span>
          <span style={{ fontSize: 11, color: "#444", fontFamily: "Inter, sans-serif" }}>{m.drawProb}%</span>
          <span style={{ fontSize: 11, color: "#a78bfa", fontFamily: "Inter, sans-serif", fontWeight: 600 }}>{m.awayProb}%</span>
        </div>
      </div>
    </div>
  );
}

export function Chrome() {
  return (
    <div style={{
      width: 390, height: 844, overflow: "hidden", position: "relative",
      background: "linear-gradient(180deg, #0c0c14 0%, #080810 100%)",
      fontFamily: "Inter, sans-serif",
    }}>
      <div style={{
        position: "absolute", top: -200, left: "50%", transform: "translateX(-50%)",
        width: 500, height: 400,
        background: "radial-gradient(ellipse, rgba(160,140,255,0.08) 0%, transparent 65%)",
        pointerEvents: "none",
      }} />

      <div style={{ padding: "54px 16px 12px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{
            fontSize: 24, fontWeight: 900, letterSpacing: -1,
            background: holoGradient,
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            backgroundClip: "text",
            backgroundSize: "300% 300%",
          }}>KICK</span>
          <div style={{ padding: "2px 8px", borderRadius: 99, background: "rgba(239,68,68,0.15)", border: "1px solid rgba(239,68,68,0.3)" }}>
            <span style={{ fontSize: 10, color: "#f87171", fontWeight: 700 }}>● 14 live</span>
          </div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 0, padding: "0 16px", marginBottom: 14, borderBottom: "1px solid #1a1a1a" }}>
        {["All", "Live", "Upcoming"].map((t, i) => (
          <div key={t} style={{
            padding: "8px 16px", fontSize: 13, fontWeight: i === 0 ? 700 : 400,
            color: i === 0 ? "#c4b8ff" : "#444",
            borderBottom: i === 0 ? "2px solid" : "2px solid transparent",
            borderImage: i === 0 ? `${holoGradient} 1` : "none",
            cursor: "pointer",
          }}>{t}</div>
        ))}
      </div>

      <div style={{ padding: "0 16px", overflowY: "auto", maxHeight: 670 }}>
        {matches.map((m, i) => <MatchCard key={i} m={m} />)}
      </div>

      <div style={{
        position: "absolute", bottom: 0, left: 0, right: 0, height: 80,
        background: "rgba(8,8,16,0.95)",
        backdropFilter: "blur(20px)",
        display: "flex", alignItems: "center", justifyContent: "space-around",
        padding: "0 16px 12px",
        position: "absolute" as const,
      }}>
        <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 1, background: holoGradient }} />
        {[["⚽", "Matches", true], ["🏆", "Leagues", false], ["⚡", "Value", false]].map(([icon, label, active]) => (
          <div key={String(label)} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
            <span style={{ fontSize: 20 }}>{icon}</span>
            <span style={{
              fontSize: 10, fontWeight: active ? 700 : 400,
              color: active ? "transparent" : "#444",
              background: active ? holoGradient : "none",
              WebkitBackgroundClip: active ? "text" : "none",
              WebkitTextFillColor: active ? "transparent" : "#444",
              backgroundClip: active ? "text" : "none",
            }}>{String(label)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
