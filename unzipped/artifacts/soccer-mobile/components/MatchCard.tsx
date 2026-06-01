import { Feather } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";
import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import type { Match, XGPrediction } from "@workspace/api-client-react";

import { HOLO_COLORS } from "@/constants/colors";
import { useColors } from "@/hooks/useColors";
import { useFavourites } from "@/hooks/useFavourites";
import { useOddsFormat } from "@/hooks/useOddsFormat";

import { ProbabilityBar } from "./ProbabilityBar";
import { TeamLogo } from "./TeamLogo";

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

function formatKickoff(kickoff: string): string {
  const d = new Date(kickoff);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const date = d.toLocaleDateString([], { day: "numeric", month: "short" });
  return `${time} · ${date}`;
}

interface MatchCardProps {
  match: Match;
  xg?: XGPrediction;
}

function formatOdds(dec: number | null | undefined, fmt: "fractional" | "decimal"): string {
  if (!dec || dec <= 1.01) return "—";
  if (fmt === "decimal") return dec.toFixed(2);
  if (Math.abs(dec - 2.0) < 0.06) return "Evs";
  const num = Math.round((dec - 1) * 100);
  const den = 100;
  const g = gcd(num, den);
  return `${num / g}/${den / g}`;
}

export function MatchCard({ match, xg }: MatchCardProps) {
  const colors = useColors();
  const router = useRouter();
  const { isFavourite, toggleFavourite } = useFavourites();
  const { format: oddsFormat } = useOddsFormat();

  const isLive = match.status === "live";
  const isFinished = match.status === "finished";
  const isHT = match.status_detail === "HT";

  const homeScore = match.score?.home;
  const awayScore = match.score?.away;
  const hasScore = homeScore != null && awayScore != null;

  const statusText = isHT
    ? "HT"
    : isFinished
      ? "FT"
      : isLive
        ? `${match.minute ?? ""}′`
        : formatKickoff(match.kickoff);

  const statusBg =
    isLive && !isHT
      ? colors.destructive
      : isHT
        ? colors.amber
        : isFinished
          ? colors.muted
          : colors.secondary;

  const statusTextColor =
    isLive && !isHT
      ? "#fff"
      : isHT
        ? "#000"
        : isFinished
          ? colors.mutedForeground
          : colors.mutedForeground;

  const odds = match.odds;

  const cardInner = (
    <View
      style={[
        styles.cardInner,
        {
          backgroundColor: colors.card,
          borderRadius: isLive ? colors.radius - 1 : colors.radius,
        },
        !isLive && {
          borderWidth: 1,
          borderColor: colors.border,
        },
      ]}
    >
      {/* Competition strip */}
      <View style={styles.competitionRow}>
        <TeamLogo uri={match.league_logo ?? null} name={match.league_name} size={13} />
        <Text style={[styles.competitionName, { color: colors.mutedForeground }]} numberOfLines={1}>
          {match.league_name}
        </Text>
        <Text style={[styles.competitionCountry, { color: colors.mutedForeground }]} numberOfLines={1}>
          · {match.country}
        </Text>
      </View>

      <View style={styles.topRow}>
        <View
          style={[
            styles.statusBadge,
            { backgroundColor: statusBg, borderRadius: colors.radius / 2 },
          ]}
        >
          <Text style={[styles.statusText, { color: statusTextColor }]}>
            {statusText}
          </Text>
        </View>
        {isLive && !isHT && (
          <View
            style={[styles.liveDot, { backgroundColor: colors.destructive }]}
          />
        )}
        <Pressable
          onPress={(e) => {
            e.stopPropagation?.();
            toggleFavourite(match.id);
          }}
          style={styles.starBtn}
          hitSlop={8}
        >
          <Feather
            name={isFavourite(match.id) ? "star" : "star"}
            size={16}
            color={isFavourite(match.id) ? "#facc15" : colors.mutedForeground}
          />
        </Pressable>
      </View>

      <View style={styles.teamsRow}>
        <View style={styles.team}>
          <TeamLogo uri={match.home_team.logo} name={match.home_team.name} size={22} />
          <Text
            style={[styles.teamName, { color: colors.foreground }]}
            numberOfLines={1}
          >
            {match.home_team.name}
          </Text>
        </View>

        <View style={styles.scoreBox}>
          {hasScore ? (
            <Text
              style={[
                styles.score,
                { color: isLive ? colors.primary : colors.foreground },
              ]}
            >
              {homeScore} – {awayScore}
            </Text>
          ) : (
            <Text style={[styles.vsText, { color: colors.mutedForeground }]}>
              vs
            </Text>
          )}
        </View>

        <View style={[styles.team, styles.teamRight]}>
          <Text
            style={[
              styles.teamName,
              styles.teamNameRight,
              { color: colors.foreground },
            ]}
            numberOfLines={1}
          >
            {match.away_team.name}
          </Text>
          <TeamLogo uri={match.away_team.logo} name={match.away_team.name} size={22} />
        </View>
      </View>

      {odds &&
        (odds.home_win != null || odds.draw != null || odds.away_win != null) && (
          <View style={styles.probSection}>
            <ProbabilityBar
              home={odds.home_win}
              draw={odds.draw}
              away={odds.away_win}
            />
          </View>
        )}

      {odds &&
        (odds.home_odds != null ||
          odds.draw_odds != null ||
          odds.away_odds != null) && (
          <View style={styles.oddsSection}>
            <Text style={[styles.oddsSectionLabel, { color: colors.mutedForeground }]}>
              MARKET ODDS
            </Text>
            <View style={styles.oddsButtons}>
              <View style={[styles.oddsBtn, { backgroundColor: "#1e1a2e", borderColor: "#2e2248" }]}>
                <Text style={[styles.oddsBtnLabel, { color: "#7c6fa0" }]}>Home</Text>
                <Text style={[styles.oddsBtnOdds, { color: colors.primary }]}>
                  {formatOdds(odds.home_odds, oddsFormat)}
                </Text>
              </View>
              <View style={[styles.oddsBtn, { backgroundColor: colors.secondary, borderColor: colors.border }]}>
                <Text style={[styles.oddsBtnLabel, { color: colors.mutedForeground }]}>Draw</Text>
                <Text style={[styles.oddsBtnOdds, { color: colors.foreground }]}>
                  {formatOdds(odds.draw_odds, oddsFormat)}
                </Text>
              </View>
              <View style={[styles.oddsBtn, { backgroundColor: "#0f1e14", borderColor: "#1a3020" }]}>
                <Text style={[styles.oddsBtnLabel, { color: "#4a8060" }]}>Away</Text>
                <Text style={[styles.oddsBtnOdds, { color: colors.green }]}>
                  {formatOdds(odds.away_odds, oddsFormat)}
                </Text>
              </View>
            </View>
          </View>
        )}

      {xg && (
        <View style={styles.oddsSection}>
          <Text style={[styles.oddsSectionLabel, { color: colors.mutedForeground }]}>
            AI MODEL
          </Text>
          <View style={styles.oddsButtons}>
            <View style={[styles.oddsBtn, { backgroundColor: "#1a1a40", borderColor: "#252560" }]}>
              <Text style={[styles.oddsBtnLabel, { color: "#6060a0" }]}>Home</Text>
              <Text style={[styles.oddsBtnOdds, { color: "#818cf8" }]}>
                {xg.home_win.toFixed(0)}%
              </Text>
            </View>
            <View style={[styles.oddsBtn, { backgroundColor: colors.secondary, borderColor: colors.border }]}>
              <Text style={[styles.oddsBtnLabel, { color: colors.mutedForeground }]}>Draw</Text>
              <Text style={[styles.oddsBtnOdds, { color: colors.foreground }]}>
                {xg.draw.toFixed(0)}%
              </Text>
            </View>
            <View style={[styles.oddsBtn, { backgroundColor: "#0f1e14", borderColor: "#1a3020" }]}>
              <Text style={[styles.oddsBtnLabel, { color: "#4a8060" }]}>Away</Text>
              <Text style={[styles.oddsBtnOdds, { color: "#4ade80" }]}>
                {xg.away_win.toFixed(0)}%
              </Text>
            </View>
          </View>
        </View>
      )}
    </View>
  );

  return (
    <Pressable
      style={({ pressed }) => [styles.cardWrap, { opacity: pressed ? 0.82 : 1 }]}
      onPress={() => router.push(`/match/${match.id}` as never)}
      testID={`match-card-${match.id}`}
    >
      {isLive ? (
        <LinearGradient
          colors={[...HOLO_COLORS]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={[styles.holoWrap, { borderRadius: colors.radius }]}
        >
          {cardInner}
        </LinearGradient>
      ) : (
        cardInner
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  cardWrap: { marginHorizontal: 12, marginBottom: 8 },
  holoWrap: { padding: 1 },
  cardInner: { padding: 12 },
  competitionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    marginBottom: 8,
    opacity: 0.75,
  },
  competitionName: { fontSize: 10, fontFamily: "Inter_600SemiBold", letterSpacing: 0.2 },
  competitionCountry: { fontSize: 10, fontFamily: "Inter_400Regular" },
  topRow: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 8, flex: 1 },
  starBtn: { marginLeft: "auto" },
  statusBadge: { paddingHorizontal: 7, paddingVertical: 2 },
  statusText: { fontSize: 10, fontFamily: "Inter_700Bold", letterSpacing: 0.6 },
  liveDot: { width: 6, height: 6, borderRadius: 3 },
  teamsRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 10 },
  team: { flex: 1, flexDirection: "row", alignItems: "center", gap: 6 },
  teamRight: { justifyContent: "flex-end" },
  teamName: { flex: 1, fontSize: 13, fontFamily: "Inter_600SemiBold" },
  teamNameRight: { textAlign: "right" },
  scoreBox: { alignItems: "center", minWidth: 50 },
  score: { fontSize: 17, fontFamily: "Inter_700Bold", letterSpacing: 0.3 },
  vsText: { fontSize: 12, fontFamily: "Inter_400Regular" },
  probSection: { marginBottom: 10 },
  oddsSection: { marginTop: 10, gap: 5 },
  oddsSectionLabel: {
    fontSize: 9,
    fontFamily: "Inter_700Bold",
    letterSpacing: 1.2,
    textTransform: "uppercase",
  },
  oddsButtons: { flexDirection: "row", gap: 5 },
  oddsBtn: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 7,
    paddingHorizontal: 4,
    borderRadius: 6,
    borderWidth: 1,
    gap: 2,
  },
  oddsBtnLabel: {
    fontSize: 9,
    fontFamily: "Inter_500Medium",
    letterSpacing: 0.3,
    textTransform: "uppercase",
  },
  oddsBtnOdds: {
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    letterSpacing: 0.2,
  },
});
