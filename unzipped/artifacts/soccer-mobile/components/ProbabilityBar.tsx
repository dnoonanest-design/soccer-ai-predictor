import { LinearGradient } from "expo-linear-gradient";
import React from "react";
import { StyleSheet, Text, View } from "react-native";

import { useColors } from "@/hooks/useColors";

interface ProbabilityBarProps {
  home: number | null | undefined;
  draw: number | null | undefined;
  away: number | null | undefined;
  showLabels?: boolean;
}

export function ProbabilityBar({
  home,
  draw,
  away,
  showLabels = true,
}: ProbabilityBarProps) {
  const colors = useColors();
  const h = home ?? 0;
  const d = draw ?? 0;
  const a = away ?? 0;
  const total = h + d + a;

  if (total === 0) return null;

  const hPct = (h / total) * 100;
  const dPct = (d / total) * 100;
  const aPct = (a / total) * 100;

  return (
    <View style={styles.wrapper}>
      {showLabels && (
        <View style={styles.labels}>
          <Text style={[styles.label, { color: colors.primary }]}>
            {h.toFixed(0)}%
          </Text>
          <Text style={[styles.label, { color: colors.mutedForeground }]}>
            {d.toFixed(0)}%
          </Text>
          <Text style={[styles.label, { color: colors.green }]}>
            {a.toFixed(0)}%
          </Text>
        </View>
      )}
      <View style={[styles.bar, { borderRadius: colors.radius / 2, backgroundColor: colors.muted }]}>
        <LinearGradient
          colors={["#a78bfa", "#c4b5fd"]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={[styles.seg, { flex: hPct }]}
        />
        <View style={[styles.seg, { flex: dPct, backgroundColor: colors.accent }]} />
        <LinearGradient
          colors={["#4ade80", "#22c55e"]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={[styles.seg, { flex: aPct }]}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { gap: 4 },
  labels: { flexDirection: "row", justifyContent: "space-between" },
  label: { fontSize: 11, fontFamily: "Inter_600SemiBold" },
  bar: { height: 5, flexDirection: "row", overflow: "hidden" },
  seg: { height: "100%" },
});
