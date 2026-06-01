export function EmblemShield() {
  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: "#090910" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        {/* Shield emblem */}
        <div style={{ position: "relative", width: 64, height: 72 }}>
          <svg width="64" height="72" viewBox="0 0 64 72" fill="none" xmlns="http://www.w3.org/2000/svg">
            {/* Shield shape */}
            <path d="M32 2L4 14V38C4 54 17 67 32 71C47 67 60 54 60 38V14L32 2Z"
              fill="#111118" stroke="url(#shieldGrad)" strokeWidth="1.5"/>
            {/* Diagonal split */}
            <path d="M32 2L4 14V38C4 54 17 67 32 71V2Z" fill="#1a1530" opacity="0.5"/>
            {/* Football icon in center */}
            <circle cx="32" cy="36" r="13" fill="none" stroke="#a78bfa" strokeWidth="1.2"/>
            <ellipse cx="32" cy="36" rx="5" ry="13" fill="none" stroke="#4ade80" strokeWidth="1"/>
            <line x1="19" y1="36" x2="45" y2="36" stroke="#a78bfa" strokeWidth="1"/>
            <line x1="22" y1="28" x2="42" y2="28" stroke="#a78bfa" strokeWidth="0.8" opacity="0.5"/>
            <line x1="22" y1="44" x2="42" y2="44" stroke="#a78bfa" strokeWidth="0.8" opacity="0.5"/>
            <defs>
              <linearGradient id="shieldGrad" x1="4" y1="2" x2="60" y2="71" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#a78bfa"/>
                <stop offset="100%" stopColor="#4ade80"/>
              </linearGradient>
            </defs>
          </svg>
        </div>

        {/* Text stack */}
        <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
          <span style={{
            fontFamily: "'Inter', 'Arial Black', sans-serif",
            fontWeight: 900,
            fontSize: 46,
            letterSpacing: -1.5,
            color: "#ffffff",
            lineHeight: 0.95,
          }}>
            PULSE
          </span>
          <span style={{
            fontFamily: "'Inter', sans-serif",
            fontWeight: 500,
            fontSize: 13,
            letterSpacing: 5,
            color: "#4ade80",
            marginTop: 4,
          }}>
            FOOTBALL
          </span>
        </div>
      </div>
    </div>
  );
}
