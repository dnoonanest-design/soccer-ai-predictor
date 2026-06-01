export function GradientWordmark() {
  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: "#090910" }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 0 }}>
        {/* Main wordmark row */}
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{
            fontFamily: "'Inter', 'Arial Black', sans-serif",
            fontWeight: 900,
            fontSize: 52,
            letterSpacing: -2,
            background: "linear-gradient(135deg, #a78bfa 0%, #7c3aed 40%, #4ade80 100%)",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            backgroundClip: "text",
            lineHeight: 1,
          }}>
            PULSE
          </span>

          {/* Geometric football mark — hexagon + ball lines */}
          <svg width="38" height="38" viewBox="0 0 38 38" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="19" cy="19" r="18" fill="#111118" stroke="#a78bfa" strokeWidth="1.5"/>
            {/* Pentagon shapes on ball */}
            <polygon points="19,7 24,11 22,17 16,17 14,11" fill="#a78bfa" opacity="0.9"/>
            <polygon points="7,21 12,18 16,21 14,27 8,27" fill="#7c6fa0" opacity="0.7"/>
            <polygon points="31,21 26,18 22,21 24,27 30,27" fill="#4ade80" opacity="0.7"/>
            {/* Seam lines */}
            <line x1="19" y1="7" x2="14" y2="11" stroke="#090910" strokeWidth="1"/>
            <line x1="19" y1="7" x2="24" y2="11" stroke="#090910" strokeWidth="1"/>
            <line x1="14" y1="11" x2="12" y2="18" stroke="#090910" strokeWidth="1"/>
            <line x1="24" y1="11" x2="26" y2="18" stroke="#090910" strokeWidth="1"/>
            <line x1="12" y1="18" x2="14" y2="27" stroke="#090910" strokeWidth="1"/>
            <line x1="26" y1="18" x2="24" y2="27" stroke="#090910" strokeWidth="1"/>
            <line x1="14" y1="27" x2="24" y2="27" stroke="#090910" strokeWidth="1"/>
          </svg>
        </div>

        {/* FOOTBALL sub-label */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ width: 32, height: 1, background: "#a78bfa", opacity: 0.5 }} />
          <span style={{
            fontFamily: "'Inter', sans-serif",
            fontWeight: 600,
            fontSize: 11,
            letterSpacing: 6,
            color: "#a78bfa",
            opacity: 0.85,
          }}>
            FOOTBALL
          </span>
          <div style={{ width: 32, height: 1, background: "#a78bfa", opacity: 0.5 }} />
        </div>
      </div>
    </div>
  );
}
