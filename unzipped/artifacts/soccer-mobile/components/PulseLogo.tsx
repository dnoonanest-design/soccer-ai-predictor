import { LinearGradient } from "expo-linear-gradient";
import React from "react";
import { StyleSheet, Text, View } from "react-native";
import Svg, { Circle, Defs, Ellipse, Line, LinearGradient as SvgGradient, Path, Stop } from "react-native-svg";

interface PulseLogoProps {
  size?: "sm" | "md";
}

function ShieldEmblem({ size }: { size: number }) {
  const s = size / 64;
  return (
    <Svg width={size} height={size * 1.125} viewBox="0 0 64 72" fill="none">
      <Defs>
        <SvgGradient id="sg" x1="4" y1="2" x2="60" y2="71" gradientUnits="userSpaceOnUse">
          <Stop offset="0%" stopColor="#a78bfa" />
          <Stop offset="100%" stopColor="#4ade80" />
        </SvgGradient>
      </Defs>
      {/* Shield body */}
      <Path
        d="M32 2L4 14V38C4 54 17 67 32 71C47 67 60 54 60 38V14L32 2Z"
        fill="#111118"
        stroke="url(#sg)"
        strokeWidth="1.5"
      />
      {/* Left half tint */}
      <Path d="M32 2L4 14V38C4 54 17 67 32 71V2Z" fill="#1a1530" opacity="0.45" />
      {/* Football */}
      <Circle cx="32" cy="36" r="13" fill="none" stroke="#a78bfa" strokeWidth="1.4" />
      <Ellipse cx="32" cy="36" rx="5" ry="13" fill="none" stroke="#4ade80" strokeWidth="1.1" />
      <Line x1="19" y1="36" x2="45" y2="36" stroke="#a78bfa" strokeWidth="1.2" />
      <Line x1="22" y1="28" x2="42" y2="28" stroke="#a78bfa" strokeWidth="0.8" opacity="0.5" />
      <Line x1="22" y1="44" x2="42" y2="44" stroke="#a78bfa" strokeWidth="0.8" opacity="0.5" />
    </Svg>
  );
}

export function PulseLogo({ size = "md" }: PulseLogoProps) {
  const shieldSize  = size === "sm" ? 32 : 46;
  const pulseFont   = size === "sm" ? 26 : 38;
  const subFont     = size === "sm" ? 8  : 11;
  const subSpacing  = size === "sm" ? 3  : 4.5;

  return (
    <View style={styles.row}>
      <ShieldEmblem size={shieldSize} />
      <View style={styles.textCol}>
        <Text style={[styles.pulse, { fontSize: pulseFont }]}>PULSE</Text>
        <Text style={[styles.football, { fontSize: subFont, letterSpacing: subSpacing }]}>FOOTBALL</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  textCol: {
    flexDirection: "column",
    gap: 0,
  },
  pulse: {
    fontFamily: "Inter_700Bold",
    color: "#ffffff",
    letterSpacing: -1,
    lineHeight: undefined,
  },
  football: {
    fontFamily: "Inter_600SemiBold",
    color: "#4ade80",
    marginTop: -2,
  },
});
