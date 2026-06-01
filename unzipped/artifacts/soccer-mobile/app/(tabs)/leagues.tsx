import { Feather } from "@expo/vector-icons";
import type { League } from "@workspace/api-client-react";
import { useGetLeagues } from "@workspace/api-client-react";
import React, { useMemo } from "react";
import {
  ActivityIndicator,
  FlatList,
  Platform,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { PulseLogo } from "@/components/PulseLogo";
import { TeamLogo } from "@/components/TeamLogo";
import { useColors } from "@/hooks/useColors";

import { leagueSortKey } from "@/constants/leagueSorting";

function sortLeagues(leagues: League[]): League[] {
  return [...leagues].sort((a, b) => {
    const pa = leagueSortKey(a.id, a.country);
    const pb = leagueSortKey(b.id, b.country);
    if (pa !== pb) return pa - pb;
    return b.match_count - a.match_count;
  });
}

export default function LeaguesScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const topInset = Platform.OS === "web" ? 67 : insets.top;
  const bottomPad = Platform.OS === "web" ? 84 + 20 : insets.bottom + 90;

  const {
    data: leaguesRaw,
    isLoading,
    isError,
    refetch,
    isFetching,
  } = useGetLeagues({ query: { refetchInterval: 60_000 } });

  const leagues = useMemo(
    () => (leaguesRaw ? sortLeagues(leaguesRaw) : leaguesRaw),
    [leaguesRaw],
  );

  const renderLeague = ({ item }: { item: League }) => (
    <View
      style={[
        styles.row,
        {
          backgroundColor: colors.card,
          borderColor: colors.border,
          borderRadius: colors.radius,
        },
      ]}
    >
      <TeamLogo uri={item.logo} name={item.name} size={38} />
      <View style={styles.info}>
        <Text
          style={[styles.leagueName, { color: colors.foreground }]}
          numberOfLines={1}
        >
          {item.name}
        </Text>
        <Text style={[styles.country, { color: colors.mutedForeground }]}>
          {item.country}
        </Text>
      </View>
      <View style={styles.counts}>
        {item.live_count > 0 && (
          <View
            style={[styles.liveBadge, { backgroundColor: colors.destructive }]}
          >
            <View style={styles.dot} />
            <Text style={styles.liveBadgeText}>{item.live_count} live</Text>
          </View>
        )}
        <Text style={[styles.matchCount, { color: colors.mutedForeground }]}>
          {item.match_count} {item.match_count === 1 ? "match" : "matches"}
        </Text>
      </View>
    </View>
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
            Leagues
          </Text>
        </View>
        {isFetching && !isLoading && (
          <ActivityIndicator size="small" color={colors.primary} />
        )}
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
        </View>
      ) : !leagues || leagues.length === 0 ? (
        <View style={styles.center}>
          <Feather name="award" size={36} color={colors.mutedForeground} />
          <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
            No active leagues
          </Text>
          <Text style={[styles.emptySub, { color: colors.mutedForeground }]}>
            No leagues with matches today
          </Text>
        </View>
      ) : (
        <FlatList
          data={leagues}
          keyExtractor={(item) => `${item.id}`}
          renderItem={renderLeague}
          contentContainerStyle={{ padding: 12, paddingBottom: bottomPad }}
          ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={!!isFetching}
              onRefresh={refetch}
              tintColor={colors.primary}
              colors={[colors.primary]}
            />
          }
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
  logoArea: { gap: 2 },
  pageTitle: { fontSize: 11, fontFamily: "Inter_500Medium", letterSpacing: 0.3 },
  title: { fontSize: 28, fontFamily: "Inter_700Bold" },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  emptyTitle: { fontSize: 17, fontFamily: "Inter_600SemiBold", marginTop: 4 },
  emptySub: { fontSize: 13, fontFamily: "Inter_400Regular" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    padding: 14,
    gap: 12,
    borderWidth: 1,
  },
  info: { flex: 1 },
  leagueName: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  country: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 2 },
  counts: { alignItems: "flex-end", gap: 5 },
  liveBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 99,
  },
  dot: { width: 5, height: 5, borderRadius: 3, backgroundColor: "#fff" },
  liveBadgeText: { color: "#fff", fontSize: 10, fontFamily: "Inter_700Bold" },
  matchCount: { fontSize: 12, fontFamily: "Inter_400Regular" },
});
