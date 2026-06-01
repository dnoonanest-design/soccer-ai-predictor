import { Feather } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import React from "react";
import {
  ActivityIndicator,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { PulseLogo } from "@/components/PulseLogo";
import { useColors } from "@/hooks/useColors";

interface ByOutcomeRow { predicted: number; actual: number; correct: number }
interface RecentResult {
  fixtureId:   number;
  homeTeam:    string;
  awayTeam:    string;
  homeWinProb: number;
  drawProb:    number;
  awayWinProb: number;
  predicted:   string;
  actual:      string;
  correct:     boolean;
  brierScore:  number;
}
interface AccuracyStats {
  totalPredictions: number;
  correctPicks:     number;
  pickAccuracy:     number;
  brierScore:       number;
  byOutcome:        { home: ByOutcomeRow; draw: ByOutcomeRow; away: ByOutcomeRow };
  recentResults:    RecentResult[];
}

function useAccuracy() {
  return useQuery<AccuracyStats>({
    queryKey: ["accuracy"],
    queryFn:  () => customFetch<AccuracyStats>("/api/accuracy"),
    refetchInterval: 5 * 60_000,
    staleTime:       5 * 60_000,
  });
}

function StatCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color: string }) {
  const colors = useColors();
  return (
    <View style={[styles.statCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Text style={[styles.statValue, { color }]}>{value}</Text>
      <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>{label}</Text>
      {sub ? <Text style={[styles.statSub, { color: colors.mutedForeground }]}>{sub}</Text> : null}
    </View>
  );
}

function OutcomeBar({ label, row, color }: { label: string; row: ByOutcomeRow; color: string }) {
  const colors = useColors();
  const acc = row.actual > 0 ? row.correct / row.actual : 0;
  return (
    <View style={styles.outcomeRow}>
      <Text style={[styles.outcomeLabel, { color: colors.mutedForeground, width: 42 }]}>{label}</Text>
      <View style={[styles.barBg, { flex: 1, backgroundColor: colors.border }]}>
        <View style={[styles.barFill, { width: `${acc * 100}%`, backgroundColor: color }]} />
      </View>
      <Text style={[styles.outcomeVal, { color: colors.foreground, width: 40, textAlign: "right" }]}>
        {row.correct}/{row.actual}
      </Text>
    </View>
  );
}

function ResultRow({ item }: { item: RecentResult }) {
  const colors = useColors();
  return (
    <View style={[styles.resultRow, { borderBottomColor: colors.border }]}>
      <View style={{ flex: 1 }}>
        <Text style={[styles.resultMatch, { color: colors.foreground }]} numberOfLines={1}>
          {item.homeTeam} vs {item.awayTeam}
        </Text>
        <View style={styles.resultMeta}>
          <Text style={[styles.resultChip, {
            color: item.correct ? colors.green : "#f87171",
            backgroundColor: item.correct ? colors.green + "18" : "#f8717118",
          }]}>
            {item.correct ? "✓ Correct" : "✗ Wrong"}
          </Text>
          <Text style={[styles.resultDetail, { color: colors.mutedForeground }]}>
            Predicted: <Text style={{ color: colors.primary }}>{item.predicted.toUpperCase()}</Text>
            {"  "}Actual: <Text style={{ color: colors.foreground }}>{item.actual.toUpperCase()}</Text>
          </Text>
        </View>
      </View>
      <Text style={[styles.brierVal, { color: colors.mutedForeground }]}>
        BS {item.brierScore.toFixed(2)}
      </Text>
    </View>
  );
}

export default function AccuracyScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const topInset  = Platform.OS === "web" ? 67 : insets.top;
  const bottomPad = Platform.OS === "web" ? 84 + 20 : insets.bottom + 90;

  const { data, isLoading, error } = useAccuracy();

  const brierBaseline = 0.333;
  const brierDelta = data ? brierBaseline - data.brierScore : null;
  const brierColor = brierDelta != null && brierDelta > 0 ? colors.green : "#f87171";

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: topInset + 10, borderBottomColor: colors.border }]}>
        <View style={styles.logoArea}>
          <PulseLogo size="sm" />
          <Text style={[styles.pageTitle, { color: colors.mutedForeground }]}>
            Model Accuracy · Self-improving calibration
          </Text>
        </View>
      </View>

      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : error || !data ? (
        <View style={styles.center}>
          <Feather name="alert-circle" size={36} color={colors.mutedForeground} />
          <Text style={[styles.emptyTitle, { color: colors.foreground }]}>No data yet</Text>
          <Text style={[styles.emptySub, { color: colors.mutedForeground }]}>
            Predictions are recorded as matches are viewed. Check back after some matches have finished.
          </Text>
        </View>
      ) : data.totalPredictions === 0 ? (
        <View style={styles.center}>
          <Feather name="bar-chart-2" size={36} color={colors.mutedForeground} />
          <Text style={[styles.emptyTitle, { color: colors.foreground }]}>Building history</Text>
          <Text style={[styles.emptySub, { color: colors.mutedForeground }]}>
            Open match detail pages for upcoming games. Once those matches finish the model records its accuracy and improves.
          </Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: 16, paddingBottom: bottomPad, gap: 20 }}
          showsVerticalScrollIndicator={false}
        >
          {/* Top stats */}
          <View style={styles.statsGrid}>
            <StatCard
              label="Predictions"
              value={String(data.totalPredictions)}
              color={colors.primary}
            />
            <StatCard
              label="Pick Accuracy"
              value={`${(data.pickAccuracy * 100).toFixed(1)}%`}
              sub={`${data.correctPicks} correct`}
              color={colors.green}
            />
            <StatCard
              label="Brier Score"
              value={data.brierScore.toFixed(3)}
              sub={brierDelta != null ? (brierDelta > 0 ? `+${brierDelta.toFixed(3)} vs random` : `${brierDelta.toFixed(3)} vs random`) : undefined}
              color={brierColor}
            />
          </View>

          {/* Calibration note */}
          <View style={[styles.infoBox, { backgroundColor: colors.card, borderColor: colors.primary + "40" }]}>
            <Feather name="cpu" size={14} color={colors.primary} />
            <Text style={[styles.infoText, { color: colors.mutedForeground }]}>
              Probabilities are automatically recalibrated using{" "}
              <Text style={{ color: colors.primary }}>{data.totalPredictions} recorded predictions</Text>
              . The model adjusts each probability bucket so forecasts match real-world frequencies over time.
            </Text>
          </View>

          {/* By outcome bars */}
          <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Accuracy by Outcome</Text>
            <View style={{ gap: 12, marginTop: 12 }}>
              <OutcomeBar label="Home"  row={data.byOutcome.home} color={colors.primary} />
              <OutcomeBar label="Draw"  row={data.byOutcome.draw} color={colors.amber ?? "#f59e0b"} />
              <OutcomeBar label="Away"  row={data.byOutcome.away} color={colors.green} />
            </View>
            <Text style={[styles.barCaption, { color: colors.mutedForeground }]}>
              Correct picks / actual occurrences per outcome
            </Text>
          </View>

          {/* Recent results */}
          {data.recentResults.length > 0 && (
            <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Recent Results</Text>
              <View style={{ marginTop: 4 }}>
                {data.recentResults.map((r) => (
                  <ResultRow key={r.fixtureId} item={r} />
                ))}
              </View>
            </View>
          )}

          {/* Brier score explainer */}
          <View style={[styles.infoBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Feather name="info" size={14} color={colors.mutedForeground} />
            <Text style={[styles.infoText, { color: colors.mutedForeground }]}>
              <Text style={{ color: colors.foreground }}>Brier score</Text> measures calibration — lower is better. Random guessing scores 0.333. A score below 0.333 means the model is genuinely informative.
            </Text>
          </View>
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container:   { flex: 1 },
  header:      { paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  logoArea:    { gap: 2 },
  pageTitle:   { fontSize: 11, fontFamily: "Inter_500Medium", letterSpacing: 0.3 },
  center:      { flex: 1, alignItems: "center", justifyContent: "center", gap: 10, paddingHorizontal: 32 },
  emptyTitle:  { fontSize: 17, fontFamily: "Inter_600SemiBold", marginTop: 4 },
  emptySub:    { fontSize: 13, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 20 },
  statsGrid:   { flexDirection: "row", gap: 8 },
  statCard:    { flex: 1, borderWidth: 1, borderRadius: 12, padding: 12, alignItems: "center", gap: 2 },
  statValue:   { fontSize: 22, fontFamily: "Inter_700Bold" },
  statLabel:   { fontSize: 10, fontFamily: "Inter_600SemiBold", letterSpacing: 0.5, textAlign: "center" },
  statSub:     { fontSize: 9,  fontFamily: "Inter_400Regular", textAlign: "center" },
  section:     { borderWidth: 1, borderRadius: 12, padding: 14 },
  sectionTitle:{ fontSize: 13, fontFamily: "Inter_700Bold", letterSpacing: 0.3 },
  outcomeRow:  { flexDirection: "row", alignItems: "center", gap: 10 },
  outcomeLabel:{ fontSize: 11, fontFamily: "Inter_600SemiBold" },
  barBg:       { height: 8, borderRadius: 99, overflow: "hidden" },
  barFill:     { height: "100%", borderRadius: 99 },
  outcomeVal:  { fontSize: 11, fontFamily: "Inter_500Medium" },
  barCaption:  { fontSize: 10, fontFamily: "Inter_400Regular", marginTop: 10 },
  resultRow:   { paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: "row", alignItems: "center", gap: 8 },
  resultMatch: { fontSize: 13, fontFamily: "Inter_500Medium" },
  resultMeta:  { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 3, flexWrap: "wrap" },
  resultChip:  { fontSize: 10, fontFamily: "Inter_700Bold", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },
  resultDetail:{ fontSize: 11, fontFamily: "Inter_400Regular" },
  brierVal:    { fontSize: 10, fontFamily: "Inter_500Medium" },
  infoBox:     { borderWidth: 1, borderRadius: 10, padding: 12, flexDirection: "row", gap: 8, alignItems: "flex-start" },
  infoText:    { flex: 1, fontSize: 12, fontFamily: "Inter_400Regular", lineHeight: 18 },
});
