import { Feather } from "@expo/vector-icons";
import type { Match, XGPrediction } from "@workspace/api-client-react";
import { useGetMatches, useGetXg } from "@workspace/api-client-react";
import { Image } from "expo-image";
import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { PulseLogo } from "@/components/PulseLogo";
import { MatchCard } from "@/components/MatchCard";
import { TeamLogo } from "@/components/TeamLogo";
import { leagueSortKey } from "@/constants/leagueSorting";
import { useColors } from "@/hooks/useColors";
import { useOddsFormat } from "@/hooks/useOddsFormat";

type FilterTab = "all" | "live" | "upcoming";

const FILTERS: { key: FilterTab; label: string }[] = [
  { key: "all", label: "All" },
  { key: "live", label: "Live" },
  { key: "upcoming", label: "Upcoming" },
];

interface LeagueGroup {
  leagueId: number;
  leagueName: string;
  leagueLogo: string | null;
  country: string;
  matches: Match[];
}

type ListItem =
  | { type: "header"; group: LeagueGroup; key: string }
  | { type: "match"; match: Match; key: string };

export default function MatchesScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [filter, setFilter] = useState<FilterTab>("all");
  const { format: oddsFormat, setOddsFormat } = useOddsFormat();

  const topInset = Platform.OS === "web" ? 67 : insets.top;
  const bottomPad = Platform.OS === "web" ? 84 + 20 : insets.bottom + 90;

  const {
    data: matches,
    isLoading,
    isError,
    refetch,
    isFetching,
  } = useGetMatches(
    { status: filter === "all" ? "all" : filter },
    { query: { refetchInterval: 30_000 } },
  );

  const { data: xgData } = useGetXg({
    query: { refetchInterval: 30_000 },
  });

  const xgMap = useMemo(() => {
    const map = new Map<number, XGPrediction>();
    xgData?.predictions?.forEach((p) => map.set(p.match_id, p));
    return map;
  }, [xgData]);

  const groups = useMemo((): LeagueGroup[] => {
    if (!matches) return [];
    const groupMap = new Map<number, LeagueGroup>();
    for (const m of matches) {
      const g = groupMap.get(m.league_id);
      if (g) {
        g.matches.push(m);
      } else {
        groupMap.set(m.league_id, {
          leagueId: m.league_id,
          leagueName: m.league_name,
          leagueLogo: m.league_logo ?? null,
          country: m.country,
          matches: [m],
        });
      }
    }
    return Array.from(groupMap.values()).sort(
      (a, b) =>
        leagueSortKey(a.leagueId, a.country) -
        leagueSortKey(b.leagueId, b.country),
    );
  }, [matches]);

  const items = useMemo((): ListItem[] => {
    const result: ListItem[] = [];
    for (const group of groups) {
      result.push({ type: "header", group, key: `h-${group.leagueId}` });
      for (const match of group.matches) {
        result.push({ type: "match", match, key: `m-${match.id}` });
      }
    }
    return result;
  }, [groups]);

  const liveCount = useMemo(
    () => matches?.filter((m) => m.status === "live").length ?? 0,
    [matches],
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
        <View style={styles.headerLeft}>
          <PulseLogo size="md" />
          {liveCount > 0 && (
            <View
              style={[styles.liveChip, { backgroundColor: colors.destructive }]}
            >
              <View style={styles.liveDot} />
              <Text style={styles.liveChipText}>{liveCount} live</Text>
            </View>
          )}
        </View>
        <View style={styles.oddsToggle}>
          <Pressable
            style={[
              styles.oddsToggleBtn,
              oddsFormat === "fractional" && { backgroundColor: colors.primary },
            ]}
            onPress={() => setOddsFormat("fractional")}
          >
            <Text
              style={[
                styles.oddsToggleText,
                { color: oddsFormat === "fractional" ? colors.background : colors.mutedForeground },
              ]}
            >
              Frac
            </Text>
          </Pressable>
          <Pressable
            style={[
              styles.oddsToggleBtn,
              oddsFormat === "decimal" && { backgroundColor: colors.primary },
            ]}
            onPress={() => setOddsFormat("decimal")}
          >
            <Text
              style={[
                styles.oddsToggleText,
                { color: oddsFormat === "decimal" ? colors.background : colors.mutedForeground },
              ]}
            >
              Dec
            </Text>
          </Pressable>
        </View>
        {isFetching && !isLoading && (
          <ActivityIndicator size="small" color={colors.primary} />
        )}
      </View>

      {/* Filter tabs */}
      <View
        style={[styles.filterRow, { borderBottomColor: colors.border }]}
      >
        {FILTERS.map((f) => {
          const active = filter === f.key;
          return (
            <Pressable
              key={f.key}
              style={[
                styles.filterTab,
                active && {
                  borderBottomColor: colors.primary,
                  borderBottomWidth: 2,
                },
              ]}
              onPress={() => setFilter(f.key)}
            >
              <Text
                style={[
                  styles.filterText,
                  {
                    color: active ? colors.primary : colors.mutedForeground,
                    fontFamily: active
                      ? "Inter_700Bold"
                      : "Inter_400Regular",
                  },
                ]}
              >
                {f.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : isError ? (
        <View style={styles.center}>
          <Feather name="wifi-off" size={36} color={colors.mutedForeground} />
          <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
            Connection error
          </Text>
          <Text style={[styles.emptySub, { color: colors.mutedForeground }]}>
            Could not load matches
          </Text>
          <Pressable
            style={[
              styles.retryBtn,
              {
                backgroundColor: colors.primary,
                borderRadius: colors.radius,
              },
            ]}
            onPress={() => refetch()}
          >
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : items.length === 0 ? (
        <View style={styles.center}>
          <Feather name="calendar" size={36} color={colors.mutedForeground} />
          <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
            No matches
          </Text>
          <Text style={[styles.emptySub, { color: colors.mutedForeground }]}>
            {filter === "live"
              ? "No live matches right now"
              : filter === "upcoming"
                ? "No upcoming matches scheduled"
                : "No matches today"}
          </Text>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(item) => item.key}
          renderItem={({ item }) => {
            if (item.type === "header") {
              return (
                <View
                  style={[
                    styles.leagueHeader,
                    { borderBottomColor: colors.border },
                  ]}
                >
                  <TeamLogo
                    uri={item.group.leagueLogo}
                    name={item.group.leagueName}
                    size={16}
                  />
                  <Text
                    style={[
                      styles.leagueName,
                      { color: colors.mutedForeground },
                    ]}
                    numberOfLines={1}
                  >
                    {item.group.leagueName}
                  </Text>
                  <Text
                    style={[
                      styles.leagueCountry,
                      { color: colors.mutedForeground },
                    ]}
                  >
                    · {item.group.country}
                  </Text>
                </View>
              );
            }
            return (
              <MatchCard match={item.match} xg={xgMap.get(item.match.id)} />
            );
          }}
          contentContainerStyle={{ paddingTop: 4, paddingBottom: bottomPad }}
          refreshControl={
            <RefreshControl
              refreshing={!!isFetching}
              onRefresh={refetch}
              tintColor={colors.primary}
              colors={[colors.primary]}
            />
          }
          showsVerticalScrollIndicator={false}
          scrollEnabled={items.length > 0}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerLeft: { flexDirection: "row", alignItems: "center", gap: 10 },
  title: { fontSize: 28, fontFamily: "Inter_700Bold" },
  liveChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 99,
  },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: "#fff" },
  liveChipText: {
    color: "#fff",
    fontSize: 11,
    fontFamily: "Inter_700Bold",
  },
  oddsToggle: {
    flexDirection: "row",
    borderRadius: 8,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "#2e2248",
  },
  oddsToggleBtn: {
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  oddsToggleText: {
    fontSize: 11,
    fontFamily: "Inter_700Bold",
    letterSpacing: 0.3,
  },
  filterRow: {
    flexDirection: "row",
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  filterTab: {
    flex: 1,
    paddingVertical: 11,
    alignItems: "center",
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  filterText: { fontSize: 13 },
  leagueHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  leagueName: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0.4,
    flex: 1,
  },
  leagueCountry: { fontSize: 11, fontFamily: "Inter_400Regular" },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingHorizontal: 32,
  },
  emptyTitle: {
    fontSize: 17,
    fontFamily: "Inter_600SemiBold",
    marginTop: 4,
  },
  emptySub: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
  },
  retryBtn: { paddingHorizontal: 24, paddingVertical: 10, marginTop: 4 },
  retryText: {
    color: "#fff",
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
  },
});
