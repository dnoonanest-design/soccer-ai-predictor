import { Feather } from "@expo/vector-icons";
import type { Match, XGPrediction } from "@workspace/api-client-react";
import { useGetMatches, useGetXg } from "@workspace/api-client-react";
import { useRouter } from "expo-router";
import React, { useMemo } from "react";
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { PulseLogo } from "@/components/PulseLogo";
import { useColors } from "@/hooks/useColors";

const EDGE_THRESHOLD = 8;

type Outcome = "home" | "draw" | "away";

interface ValueBet {
  match: Match;
  xg: XGPrediction;
  outcome: Outcome;
  modelPct: number;
  marketPct: number | null;
  edge: number;
}

function findValueBets(
  matches: Match[],
  xgMap: Map<number, XGPrediction>,
): ValueBet[] {
  const bets: ValueBet[] = [];
  for (const m of matches) {
    if (m.status === "finished") continue;
    const xg = xgMap.get(m.id);
    if (!xg || !m.odds) continue;

    const checks: Array<{
      outcome: Outcome;
      modelPct: number;
      marketPct: number | null | undefined;
    }> = [
      {
        outcome: "home",
        modelPct: xg.home_win,
        marketPct: m.odds.home_win,
      },
      { outcome: "draw", modelPct: xg.draw, marketPct: m.odds.draw },
      {
        outcome: "away",
        modelPct: xg.away_win,
        marketPct: m.odds.away_win,
      },
    ];

    for (const c of checks) {
      const edge = c.marketPct != null ? c.modelPct - c.marketPct : 0;
      if (edge >= EDGE_THRESHOLD) {
        bets.push({
          match: m,
          xg,
          outcome: c.outcome,
          modelPct: c.modelPct,
          marketPct: c.marketPct ?? null,
          edge,
        });
      }
    }
  }
  return bets.sort((a, b) => b.edge - a.edge);
}

export default function ValueScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const topInset = Platform.OS === "web" ? 67 : insets.top;
  const bottomPad = Platform.OS === "web" ? 84 + 20 : insets.bottom + 90;

  const { data: matches, isLoading: matchLoading } = useGetMatches(
    { status: "all" },
    { query: { refetchInterval: 60_000 } },
  );
  const { data: xgData, isLoading: xgLoading } = useGetXg({
    query: { refetchInterval: 60_000 },
  });
  const isLoading = matchLoading || xgLoading;

  const xgMap = useMemo(() => {
    const map = new Map<number, XGPrediction>();
    xgData?.predictions?.forEach((p) => map.set(p.match_id, p));
    return map;
  }, [xgData]);

  const valueBets = useMemo(() => {
    if (!matches || !xgData) return [];
    return findValueBets(matches, xgMap);
  }, [matches, xgData, xgMap]);

  const outcomeLabel = (o: Outcome, m: Match) =>
    o === "home"
      ? m.home_team.name
      : o === "away"
        ? m.away_team.name
        : "Draw";

  const outcomeColor = (o: Outcome) =>
    o === "home"
      ? colors.primary
      : o === "away"
        ? colors.green
        : colors.amber;

  const renderBet = ({ item }: { item: ValueBet }) => (
    <Pressable
      style={({ pressed }) => [
        styles.card,
        {
          backgroundColor: colors.card,
          borderColor: colors.border,
          borderRadius: colors.radius,
          opacity: pressed ? 0.82 : 1,
        },
      ]}
      onPress={() => router.push(`/match/${item.match.id}` as never)}
    >
      {/* Edge badge */}
      <View
        style={[
          styles.edgeBadge,
          {
            backgroundColor: colors.green + "18",
            borderColor: colors.green + "50",
          },
        ]}
      >
        <Feather name="trending-up" size={11} color={colors.green} />
        <Text style={[styles.edgeText, { color: colors.green }]}>
          +{item.edge.toFixed(1)}% model edge
        </Text>
      </View>

      {/* Match title */}
      <Text
        style={[styles.teamsText, { color: colors.foreground }]}
        numberOfLines={1}
      >
        {item.match.home_team.name} vs {item.match.away_team.name}
      </Text>
      <Text style={[styles.leagueText, { color: colors.mutedForeground }]}>
        {item.match.league_name} · {item.match.country}
      </Text>

      {/* Pick */}
      <View
        style={[
          styles.pickRow,
          {
            backgroundColor: colors.secondary,
            borderRadius: colors.radius / 2,
          },
        ]}
      >
        <Text style={[styles.pickLabel, { color: colors.mutedForeground }]}>
          Pick
        </Text>
        <Text
          style={[styles.pickValue, { color: outcomeColor(item.outcome) }]}
          numberOfLines={1}
        >
          {outcomeLabel(item.outcome, item.match)}
        </Text>
      </View>

      {/* Model vs market */}
      <View style={styles.compRow}>
        <View style={styles.compCol}>
          <Text style={[styles.compLabel, { color: colors.mutedForeground }]}>
            MODEL
          </Text>
          <Text style={[styles.compValue, { color: colors.primary }]}>
            {item.modelPct.toFixed(0)}%
          </Text>
        </View>
        <Feather name="chevron-right" size={18} color={colors.mutedForeground} />
        <View style={styles.compCol}>
          <Text style={[styles.compLabel, { color: colors.mutedForeground }]}>
            MARKET
          </Text>
          <Text style={[styles.compValue, { color: colors.mutedForeground }]}>
            {item.marketPct != null ? `${item.marketPct.toFixed(0)}%` : "—"}
          </Text>
        </View>
      </View>
    </Pressable>
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View
        style={[
          styles.header,
          { paddingTop: topInset + 10, borderBottomColor: colors.border },
        ]}
      >
        <View style={styles.logoArea}>
          <PulseLogo size="sm" />
          <Text style={[styles.pageTitle, { color: colors.mutedForeground }]}>
            Value · Model edge ≥{EDGE_THRESHOLD}%
          </Text>
        </View>
      </View>

      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : valueBets.length === 0 ? (
        <View style={styles.center}>
          <Feather name="zap" size={36} color={colors.mutedForeground} />
          <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
            No value bets
          </Text>
          <Text style={[styles.emptySub, { color: colors.mutedForeground }]}>
            Model and market are currently aligned
          </Text>
        </View>
      ) : (
        <FlatList
          data={valueBets}
          keyExtractor={(item) => `${item.match.id}-${item.outcome}`}
          renderItem={renderBet}
          contentContainerStyle={{ padding: 12, paddingBottom: bottomPad }}
          ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
          showsVerticalScrollIndicator={false}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  logoArea: { gap: 2 },
  pageTitle: { fontSize: 11, fontFamily: "Inter_500Medium", letterSpacing: 0.3 },
  title: { fontSize: 28, fontFamily: "Inter_700Bold" },
  subtitle: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 2 },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingHorizontal: 32,
  },
  emptyTitle: { fontSize: 17, fontFamily: "Inter_600SemiBold", marginTop: 4 },
  emptySub: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
  },
  card: { padding: 14, borderWidth: 1, gap: 10 },
  edgeBadge: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 99,
    borderWidth: 1,
  },
  edgeText: { fontSize: 11, fontFamily: "Inter_700Bold" },
  teamsText: { fontSize: 15, fontFamily: "Inter_600SemiBold" },
  leagueText: { fontSize: 11, fontFamily: "Inter_400Regular", marginTop: -4 },
  pickRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  pickLabel: { fontSize: 11, fontFamily: "Inter_500Medium" },
  pickValue: { fontSize: 15, fontFamily: "Inter_700Bold", flex: 1, textAlign: "right" },
  compRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 20,
  },
  compCol: { alignItems: "center", gap: 3 },
  compLabel: { fontSize: 9, fontFamily: "Inter_700Bold", letterSpacing: 1 },
  compValue: { fontSize: 22, fontFamily: "Inter_700Bold" },
});
