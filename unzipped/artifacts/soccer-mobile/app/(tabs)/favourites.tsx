import { Feather } from "@expo/vector-icons";
import type { Match, XGPrediction } from "@workspace/api-client-react";
import { useGetMatches, useGetXg } from "@workspace/api-client-react";
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
import { MatchCard } from "@/components/MatchCard";
import { useColors } from "@/hooks/useColors";
import { useFavourites } from "@/hooks/useFavourites";

export default function FavouritesScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const topInset = Platform.OS === "web" ? 67 : insets.top;
  const bottomPad = Platform.OS === "web" ? 84 + 20 : insets.bottom + 90;

  const { favouriteIds } = useFavourites();

  const {
    data: matches,
    isLoading,
    isError,
    refetch,
    isFetching,
  } = useGetMatches(
    { status: "all" },
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

  const favouriteMatches = useMemo(
    () => (matches ?? []).filter((m) => favouriteIds.has(m.id)),
    [matches, favouriteIds],
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View
        style={[
          styles.header,
          { paddingTop: topInset + 10, borderBottomColor: colors.border },
        ]}
      >
        <View style={styles.logoArea}>
          <PulseLogo size="sm" />
          <Text style={[styles.pageTitle, { color: colors.mutedForeground }]}>
            Favourites
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
      ) : favouriteMatches.length === 0 ? (
        <View style={styles.center}>
          <Feather name="star" size={40} color={colors.mutedForeground} />
          <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
            No favourites yet
          </Text>
          <Text style={[styles.emptySub, { color: colors.mutedForeground }]}>
            Tap the star on any match to save it here
          </Text>
        </View>
      ) : (
        <FlatList
          data={favouriteMatches}
          keyExtractor={(item) => `${item.id}`}
          renderItem={({ item }) => (
            <MatchCard
              match={item}
              xg={xgMap.get(item.id)}
            />
          )}
          contentContainerStyle={{ paddingTop: 12, paddingBottom: bottomPad }}
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
    lineHeight: 20,
  },
});
