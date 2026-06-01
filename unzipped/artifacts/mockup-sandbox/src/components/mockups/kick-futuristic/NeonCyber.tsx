const matches = [
  { league: "Premier League", country: "England", home: "Arsenal", away: "Man City", time: "34'", live: true, score: "1 – 1", homeProb: 38, drawProb: 28, awayProb: 34 },
  { league: "La Liga", country: "Spain", home: "Real Madrid", away: "Barcelona", time: "67'", live: true, score: "2 – 1", homeProb: 52, drawProb: 22, awayProb: 26 },
  { league: "Bundesliga", country: "Germany", home: "Bayern", away: "Dortmund", time: "01:00 PM", live: false, score: null, homeProb: 61, drawProb: 18, awayProb: 21 },
  { league: "Serie A", country: "Italy", home: "Juventus", away: "Inter", time: "03:30 PM", live: false, score: null, homeProb: 44, drawProb: 27, awayProb: 29 },
];

function MatchCard({ m }: { m: typeof matches[0] }) {
  return (
    <div style={{
      background: "#060606",
      border: m.live ? "1px solid #00ff88" : "1px solid #1a1a1a",
      borderRadius: 8,
      padding: "14px 16px",
      marginBottom: 8,
      boxShadow: m.live ? "0 0 16px rgba(0,255,136,0.2), inset 0 0 30px rgba(0,255,136,0.03)" : "none",
      position: "relative",
      overflow: "hidden",
    }}>
      {m.live && (
        <div style={{
          position: "absolute", top: 0, left: 0, right: 0, height: 1,
          background: "linear-gradient(90deg, transparent, #00ff88, transparent)",
        }} />
      )}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <span style={{ fontSize: 9, color: "#333", letterSpacing: 2, textTransform: "uppercase", fontFamily: "'Courier New', monospace" }}>
          {m.league} / {m.country}
        </span>
        {m.live
          ? <span style={{ fontSize: 10, color: "#00ff88", fontFamily: "'Courier New', monospace", fontWeight: 700, textShadow: "0 0 8px #00ff88" }}>
              ● {m.time}
            </span>
          : <span style={{ fontSize: 10, color: "#444", fontFamily: "'Courier New', monospace" }}>{m.time}</span>
        }
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <span style={{ color: "#e0e0e0", fontSize: 13, fontWeight: 700, fontFamily: "'Courier New', monospace", flex: 1 }}>{m.home}</span>
        <span style={{
          color: m.live ? "#00ff88" : "#333",
          fontSize: 15, fontWeight: 900, fontFamily: "'Courier New', monospace",
          minWidth: 70, textAlign: "center",
          textShadow: m.live ? "0 0 10px #00ff88" : "none",
        }}>
          {m.live ? m.score : "VS"}
        </span>
        <span style={{ color: "#e0e0e0", fontSize: 13, fontWeight: 700, fontFamily: "'Courier New', monospace", flex: 1, textAlign: "right" }}>{m.away}</span>
      </div>
      <div style={{ display: "flex", gap: 1, borderRadius: 2, overflow: "hidden", height: 3, marginBottom: 8 }}>
        <div style={{ width: `${m.homeProb}%`, background: "#00ff88", boxShadow: "0 0 6px #00ff88" }} />
        <div style={{ width: `${m.drawProb}%`, background: "#222" }} />
        <div style={{ width: `${m.awayProb}%`, background: "#ff6b6b", boxShadow: "0 0 6px #ff6b6b" }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <span style={{ fontSize: 10, color: "#00ff88", fontFamily: "'Courier New', monospace", textShadow: "0 0 6px #00ff88" }}>{m.homeProb}%</span>
        <span style={{ fontSize: 10, color: "#333", fontFamily: "'Courier New', monospace" }}>{m.drawProb}%</span>
        <span style={{ fontSize: 10, color: "#ff6b6b", fontFamily: "'Courier New', monospace" }}>{m.awayProb}%</span>
      </div>
    </div>
  );
}

export function NeonCyber() {
  return (
    <div style={{
      width: 390, height: 844, overflow: "hidden", position: "relative",
      background: "#000",
      fontFamily: "'Courier New', monospace",
    }}>
      <div style={{
        position: "absolute", inset: 0,
        backgroundImage: "linear-gradient(rgba(0,255,136,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(0,255,136,0.03) 1px, transparent 1px)",
        backgroundSize: "40px 40px",
        pointerEvents: "none",
      }} />

      <div style={{ padding: "54px 16px 12px", display: "flex", alignItems: "center", justifyContent: "space-between", position: "relative" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{
            fontSize: 26, fontWeight: 900, color: "#00ff88",
            letterSpacing: 4, textTransform: "uppercase",
            textShadow: "0 0 20px #00ff88, 0 0 40px rgba(0,255,136,0.5)",
          }}>KICK</span>
          <span style={{ fontSize: 9, color: "#ff4444", fontWeight: 700, letterSpacing: 1, textShadow: "0 0 8px #ff4444" }}>
            ● 14 LIVE
          </span>
        </div>
        <div style={{ width: 28, height: 28, border: "1px solid #00ff88", borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 0 8px rgba(0,255,136,0.3)" }}>
          <span style={{ color: "#00ff88", fontSize: 14 }}>≡</span>
        </div>
      </div>

      <div style={{ display: "flex", gap: 0, padding: "0 16px", marginBottom: 16, borderBottom: "1px solid #111" }}>
        {["ALL", "LIVE", "UPCOMING"].map((t, i) => (
          <div key={t} style={{
            padding: "8px 14px", fontSize: 10, fontWeight: 700,
            color: i === 0 ? "#00ff88" : "#333",
            borderBottom: i === 0 ? "2px solid #00ff88" : "2px solid transparent",
            letterSpacing: 1,
            textShadow: i === 0 ? "0 0 8px #00ff88" : "none",
          }}>{t}</div>
        ))}
      </div>

      <div style={{ padding: "0 16px", overflowY: "auto", maxHeight: 660 }}>
        {matches.map((m, i) => <MatchCard key={i} m={m} />)}
      </div>

      <div style={{
        position: "absolute", bottom: 0, left: 0, right: 0, height: 80,
        background: "#000",
        borderTop: "1px solid #0f0f0f",
        display: "flex", alignItems: "center", justifyContent: "space-around",
        padding: "0 16px 12px",
      }}>
        <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 1, background: "linear-gradient(90deg, transparent, #00ff88 50%, transparent)" }} />
        {[["⚽", "Matches", true], ["🏆", "Leagues", false], ["⚡", "Value", false]].map(([icon, label, active]) => (
          <div key={String(label)} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
            <span style={{ fontSize: 18 }}>{icon}</span>
            <span style={{ fontSize: 9, color: active ? "#00ff88" : "#333", fontWeight: 700, letterSpacing: 1, textShadow: active ? "0 0 8px #00ff88" : "none" }}>{String(label).toUpperCase()}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
