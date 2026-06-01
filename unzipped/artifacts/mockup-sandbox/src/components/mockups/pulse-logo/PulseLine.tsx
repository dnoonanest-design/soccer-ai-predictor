export function PulseLine() {
  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: "#090910" }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 2 }}>
        {/* Top row: PULSE + football */}
        <div style={{ display: "flex", alignItems: "center", gap: 0 }}>
          <span style={{
            fontFamily: "'Inter', 'Arial Black', sans-serif",
            fontWeight: 900,
            fontSize: 58,
            letterSpacing: -2,
            color: "#ffffff",
            lineHeight: 1,
          }}>
            PUL
          </span>
          {/* Football replacing the S */}
          <svg width="46" height="58" viewBox="0 0 46 58" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ marginTop: 0 }}>
            <circle cx="23" cy="29" r="20" fill="#111118" stroke="#a78bfa" strokeWidth="2"/>
            <circle cx="23" cy="29" r="20" fill="url(#ballGlow)" opacity="0.15"/>
            <ellipse cx="23" cy="29" rx="8" ry="20" fill="none" stroke="#a78bfa" strokeWidth="1.5"/>
            <line x1="3" y1="29" x2="43" y2="29" stroke="#a78bfa" strokeWidth="1.5"/>
            <line x1="7" y1="19" x2="39" y2="19" stroke="#7c6fa0" strokeWidth="1" opacity="0.6"/>
            <line x1="7" y1="39" x2="39" y2="39" stroke="#7c6fa0" strokeWidth="1" opacity="0.6"/>
            <defs>
              <radialGradient id="ballGlow" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor="#a78bfa"/>
                <stop offset="100%" stopColor="transparent"/>
              </radialGradient>
            </defs>
          </svg>
          <span style={{
            fontFamily: "'Inter', 'Arial Black', sans-serif",
            fontWeight: 900,
            fontSize: 58,
            letterSpacing: -2,
            color: "#ffffff",
            lineHeight: 1,
          }}>
            E
          </span>
        </div>

        {/* Pulse / heartbeat line */}
        <div style={{ width: "100%", paddingLeft: 2 }}>
          <svg width="280" height="24" viewBox="0 0 280 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M0 12 H60 L70 2 L80 22 L90 2 L100 22 L110 12 H280"
              stroke="url(#lineGrad)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            <defs>
              <linearGradient id="lineGrad" x1="0" y1="12" x2="280" y2="12" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#a78bfa" stopOpacity="0.2"/>
                <stop offset="30%" stopColor="#a78bfa"/>
                <stop offset="70%" stopColor="#4ade80"/>
                <stop offset="100%" stopColor="#4ade80" stopOpacity="0.2"/>
              </linearGradient>
            </defs>
          </svg>
        </div>

        {/* FOOTBALL sub-label */}
        <span style={{
          fontFamily: "'Inter', sans-serif",
          fontWeight: 700,
          fontSize: 13,
          letterSpacing: 8,
          color: "#4ade80",
          paddingLeft: 4,
        }}>
          FOOTBALL
        </span>
      </div>
    </div>
  );
}
