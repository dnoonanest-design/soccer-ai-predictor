import { Feather } from "@expo/vector-icons";
import {
  useGetMatch,
  useGetMatchEvents,
  useGetMatchH2H,
  useGetMatchStats,
  useGetXg,
} from "@workspace/api-client-react";
import type {
  H2HMatch,
  MatchEvent,
  TeamStats,
} from "@workspace/api-client-react";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { FormBubbles } from "@/components/FormBubbles";
import { ProbabilityBar } from "@/components/ProbabilityBar";
import { TeamLogo } from "@/components/TeamLogo";
import { useColors } from "@/hooks/useColors";

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** Maps a probability 0-100 to a colour (green → amber → muted) with optional alpha */
function probColor(prob: number, alpha: number): string {
  if (prob >= 55) return `rgba(74,222,128,${alpha})`;   // green
  if (prob >= 35) return `rgba(251,191,36,${alpha})`;   // amber
  return `rgba(148,163,184,${alpha})`;                   // slate/muted
}

function decimalToFractional(dec: number | null | undefined): string {
  if (!dec || dec <= 1.01) return "—";
  if (Math.abs(dec - 2.0) < 0.06) return "Evs";
  const num = Math.round((dec - 1) * 100);
  const den = 100;
  const g = gcd(num, den);
  return `${num / g}/${den / g}`;
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString([], {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

type DetailTab = "overview" | "stats" | "h2h" | "lineup" | "events";

const TABS: { key: DetailTab; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "stats", label: "Stats" },
  { key: "h2h", label: "H2H" },
  { key: "lineup", label: "Lineup" },
  { key: "events", label: "Events" },
];

function StatRow({
  label,
  home,
  away,
  homeColor,
  awayColor,
}: {
  label: string;
  home: string;
  away: string;
  homeColor?: string;
  awayColor?: string;
}) {
  const colors = useColors();
  return (
    <View style={statStyles.row}>
      <Text
        style={[
          statStyles.value,
          { color: homeColor ?? colors.foreground, textAlign: "left" },
        ]}
      >
        {home}
      </Text>
      <Text style={[statStyles.label, { color: colors.mutedForeground }]}>
        {label}
      </Text>
      <Text
        style={[
          statStyles.value,
          { color: awayColor ?? colors.foreground, textAlign: "right" },
        ]}
      >
        {away}
      </Text>
    </View>
  );
}

const statStyles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 8,
  },
  label: {
    flex: 1,
    textAlign: "center",
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    letterSpacing: 0.3,
  },
  value: { width: 80, fontSize: 14, fontFamily: "Inter_700Bold" },
});

function EventIcon({ type }: { type: string }) {
  const colors = useColors();
  if (type === "goal" || type === "own_goal") {
    return <Text style={{ fontSize: 14 }}>⚽</Text>;
  }
  if (type === "yellow_card") {
    return (
      <View
        style={{
          width: 10,
          height: 13,
          backgroundColor: "#facc15",
          borderRadius: 1,
        }}
      />
    );
  }
  if (type === "red_card" || type === "yellow_red_card") {
    return (
      <View
        style={{
          width: 10,
          height: 13,
          backgroundColor: colors.destructive,
          borderRadius: 1,
        }}
      />
    );
  }
  if (type === "substitution") {
    return (
      <Feather name="refresh-cw" size={13} color={colors.mutedForeground} />
    );
  }
  return <Feather name="circle" size={13} color={colors.mutedForeground} />;
}

export default function MatchDetailScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const matchId = parseInt(id ?? "0", 10);
  const [activeTab, setActiveTab] = useState<DetailTab>("overview");

  const topInset = Platform.OS === "web" ? 67 : insets.top;

  const { data: match, isLoading: matchLoading } = useGetMatch(matchId, {
    query: { refetchInterval: 30_000, enabled: matchId > 0 },
  });
  const { data: xgAll } = useGetXg({ query: { refetchInterval: 30_000 } });
  const { data: statsData } = useGetMatchStats(matchId, {
    query: { enabled: matchId > 0 },
  });
  const { data: h2hData } = useGetMatchH2H(matchId, {
    query: { enabled: matchId > 0 },
  });
  const { data: eventsData } = useGetMatchEvents(matchId, {
    query: {
      refetchInterval: 30_000,
      enabled: matchId > 0 && (match?.status === "live" || match?.status === "finished"),
    },
  });

  const xg = xgAll?.predictions?.find((p) => p.match_id === matchId);

  if (matchLoading || !match) {
    return (
      <View
        style={[
          styles.loadingContainer,
          { backgroundColor: colors.background, paddingTop: topInset },
        ]}
      >
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  const isLive = match.status === "live";
  const isHT = match.status_detail === "HT";
  const isFinished = match.status === "finished";
  const hasScore = match.score?.home != null && match.score?.away != null;

  const statusText = isHT
    ? "HT"
    : isFinished
      ? "FT"
      : isLive
        ? `${match.minute ?? ""}′`
        : match.status_detail;

  const statusBg =
    isLive && !isHT
      ? colors.destructive
      : isHT
        ? colors.amber
        : colors.secondary;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Custom header */}
      <View
        style={[
          styles.header,
          { paddingTop: topInset + 4, borderBottomColor: colors.border },
        ]}
      >
        <Pressable style={styles.backBtn} onPress={() => router.back()}>
          <Feather name="arrow-left" size={22} color={colors.foreground} />
        </Pressable>
        <View style={styles.headerCenter}>
          <Text
            style={[styles.leagueName, { color: colors.mutedForeground }]}
            numberOfLines={1}
          >
            {match.league_name}
          </Text>
        </View>
        <View style={[styles.statusChip, { backgroundColor: statusBg }]}>
          <Text style={styles.statusChipText}>{statusText}</Text>
        </View>
      </View>

      {/* Teams & score */}
      <View
        style={[styles.matchBanner, { borderBottomColor: colors.border }]}
      >
        <View style={styles.teamCol}>
          <TeamLogo
            uri={match.home_team.logo}
            name={match.home_team.name}
            size={48}
          />
          <Text
            style={[styles.teamLabel, { color: colors.foreground }]}
            numberOfLines={2}
          >
            {match.home_team.name}
          </Text>
        </View>

        <View style={styles.scoreCol}>
          {hasScore ? (
            <Text style={[styles.scoreLarge, { color: colors.foreground }]}>
              {match.score!.home} – {match.score!.away}
            </Text>
          ) : (
            <Text style={[styles.kickoffTime, { color: colors.mutedForeground }]}>
              {new Date(match.kickoff).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </Text>
          )}
          {match.score_ht && (
            <Text
              style={[styles.htScore, { color: colors.mutedForeground }]}
            >
              HT {match.score_ht.home}–{match.score_ht.away}
            </Text>
          )}
        </View>

        <View style={[styles.teamCol, styles.teamColRight]}>
          <TeamLogo
            uri={match.away_team.logo}
            name={match.away_team.name}
            size={48}
          />
          <Text
            style={[styles.teamLabel, styles.teamLabelRight, { color: colors.foreground }]}
            numberOfLines={2}
          >
            {match.away_team.name}
          </Text>
        </View>
      </View>

      {/* Tab bar */}
      <View style={[styles.tabBar, { borderBottomColor: colors.border }]}>
        {TABS.map((t) => {
          const active = activeTab === t.key;
          return (
            <Pressable
              key={t.key}
              style={[
                styles.tabBtn,
                active && {
                  borderBottomColor: colors.primary,
                  borderBottomWidth: 2,
                },
              ]}
              onPress={() => setActiveTab(t.key)}
            >
              <Text
                style={[
                  styles.tabText,
                  {
                    color: active ? colors.primary : colors.mutedForeground,
                    fontFamily: active ? "Inter_700Bold" : "Inter_400Regular",
                  },
                ]}
              >
                {t.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* Content */}
      <ScrollView
        style={styles.content}
        contentContainerStyle={{
          padding: 16,
          paddingBottom: Platform.OS === "web" ? 34 : insets.bottom + 20,
        }}
        showsVerticalScrollIndicator={false}
      >
        {/* ── OVERVIEW ── */}
        {activeTab === "overview" && (
          <View style={styles.section}>
            {/* Market odds probability */}
            {match.odds &&
              (match.odds.home_win != null ||
                match.odds.draw != null ||
                match.odds.away_win != null) && (
                <View
                  style={[
                    styles.card,
                    { backgroundColor: colors.card, borderColor: colors.border },
                  ]}
                >
                  <Text
                    style={[styles.cardTitle, { color: colors.mutedForeground }]}
                  >
                    MARKET ODDS
                  </Text>
                  <ProbabilityBar
                    home={match.odds.home_win}
                    draw={match.odds.draw}
                    away={match.odds.away_win}
                  />
                  <View style={styles.oddsRow}>
                    <View style={styles.oddsCol}>
                      <Text
                        style={[styles.oddsTeam, { color: colors.mutedForeground }]}
                        numberOfLines={1}
                      >
                        {match.home_team.name}
                      </Text>
                      <Text style={[styles.oddsVal, { color: colors.primary }]}>
                        {decimalToFractional(match.odds.home_odds)}
                      </Text>
                    </View>
                    <View style={styles.oddsCol}>
                      <Text
                        style={[styles.oddsTeam, { color: colors.mutedForeground }]}
                      >
                        Draw
                      </Text>
                      <Text
                        style={[styles.oddsVal, { color: colors.mutedForeground }]}
                      >
                        {decimalToFractional(match.odds.draw_odds)}
                      </Text>
                    </View>
                    <View style={styles.oddsCol}>
                      <Text
                        style={[styles.oddsTeam, { color: colors.mutedForeground }]}
                        numberOfLines={1}
                      >
                        {match.away_team.name}
                      </Text>
                      <Text style={[styles.oddsVal, { color: colors.green }]}>
                        {decimalToFractional(match.odds.away_odds)}
                      </Text>
                    </View>
                  </View>
                </View>
              )}

            {/* xG model */}
            {xg && (
              <View
                style={[
                  styles.card,
                  {
                    backgroundColor: colors.card,
                    borderColor: colors.border,
                    marginTop: 10,
                  },
                ]}
              >
                <Text
                  style={[styles.cardTitle, { color: colors.mutedForeground }]}
                >
                  PRE-MATCH MODEL
                </Text>
                <ProbabilityBar
                  home={xg.home_win}
                  draw={xg.draw}
                  away={xg.away_win}
                />
                <View style={styles.xgRow}>
                  <View style={styles.xgItem}>
                    <Text style={[styles.xgTeam, { color: colors.mutedForeground }]}>
                      Home xG
                    </Text>
                    <Text style={[styles.xgVal, { color: "#60a5fa" }]}>
                      {xg.home_xg.toFixed(2)}
                    </Text>
                  </View>
                  <View style={styles.xgItem}>
                    <Text style={[styles.xgTeam, { color: colors.mutedForeground }]}>
                      Away xG
                    </Text>
                    <Text style={[styles.xgVal, { color: "#4ade80" }]}>
                      {xg.away_xg.toFixed(2)}
                    </Text>
                  </View>
                </View>
              </View>
            )}

            {/* Live Score Adjusted Model — shown only during live matches */}
            {statsData?.enhanced?.live_adjusted_home_win != null &&
              statsData.enhanced.live_score_home != null &&
              statsData.enhanced.live_score_away != null && (
                <View
                  style={[
                    styles.card,
                    { backgroundColor: colors.card, borderColor: "#4ade8044", borderWidth: 1, marginTop: 10 },
                  ]}
                >
                  {/* Title row */}
                  <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                    <Text style={[styles.cardTitle, { color: colors.mutedForeground, marginBottom: 0 }]}>
                      IN-MATCH MODEL
                    </Text>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: "#4ade80" }} />
                      <Text style={{ fontSize: 11, fontFamily: "Inter_600SemiBold", color: "#4ade80" }}>LIVE</Text>
                    </View>
                  </View>

                  {/* Current score display */}
                  <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", marginBottom: 10, gap: 10 }}>
                    <Text style={{ fontSize: 11, fontFamily: "Inter_500Medium", color: colors.mutedForeground }} numberOfLines={1}>
                      {match.home_team.name}
                    </Text>
                    <Text style={{ fontSize: 22, fontFamily: "Inter_700Bold", color: colors.foreground, letterSpacing: 2 }}>
                      {statsData.enhanced.live_score_home} – {statsData.enhanced.live_score_away}
                    </Text>
                    <Text style={{ fontSize: 11, fontFamily: "Inter_500Medium", color: colors.mutedForeground }} numberOfLines={1}>
                      {match.away_team.name}
                    </Text>
                  </View>

                  <ProbabilityBar
                    home={statsData.enhanced.live_adjusted_home_win}
                    draw={statsData.enhanced.live_adjusted_draw ?? 0}
                    away={statsData.enhanced.live_adjusted_away_win ?? 0}
                  />

                  {/* Delta vs pre-match */}
                  {xg && (
                    <View style={{ flexDirection: "row", justifyContent: "space-around", marginTop: 8 }}>
                      {[
                        { label: match.home_team.name, live: statsData.enhanced.live_adjusted_home_win, pre: xg.home_win, color: colors.primary },
                        { label: "Draw", live: statsData.enhanced.live_adjusted_draw ?? 0, pre: xg.draw, color: colors.mutedForeground },
                        { label: match.away_team.name, live: statsData.enhanced.live_adjusted_away_win ?? 0, pre: xg.away_win, color: colors.green },
                      ].map(({ label, live, pre, color }) => {
                        const delta = live - pre;
                        return (
                          <View key={label} style={{ alignItems: "center", flex: 1, gap: 1 }}>
                            <Text style={{ fontSize: 10, fontFamily: "Inter_400Regular", color: colors.mutedForeground }} numberOfLines={1}>{label}</Text>
                            <Text style={{ fontSize: 17, fontFamily: "Inter_700Bold", color }}>{live.toFixed(1)}%</Text>
                            {Math.abs(delta) >= 1 && (
                              <Text style={{ fontSize: 10, fontFamily: "Inter_600SemiBold", color: delta > 0 ? colors.green : colors.destructive }}>
                                {delta > 0 ? "+" : ""}{delta.toFixed(1)}%
                              </Text>
                            )}
                          </View>
                        );
                      })}
                    </View>
                  )}

                  <Text style={{ fontSize: 9, fontFamily: "Inter_400Regular", color: colors.mutedForeground, textAlign: "center", marginTop: 8, letterSpacing: 0.3 }}>
                    Remaining-game Poisson · chasing team +18% intensity · leading team −15%
                  </Text>
                </View>
              )}

            {/* Player Spotlights */}
            {statsData?.enhanced &&
              (statsData.enhanced.home_spotlights || statsData.enhanced.away_spotlights) && (
                <View
                  style={[
                    styles.card,
                    { backgroundColor: colors.card, borderColor: colors.border, marginTop: 10 },
                  ]}
                >
                  <Text style={[styles.cardTitle, { color: colors.mutedForeground }]}>
                    PLAYER SPOTLIGHTS
                  </Text>

                  {/* Column headers */}
                  <View style={spotlightStyles.headerRow}>
                    <Text
                      style={[spotlightStyles.teamHeader, { color: colors.primary }]}
                      numberOfLines={1}
                    >
                      {match.home_team.name}
                    </Text>
                    <View style={spotlightStyles.roleCol} />
                    <Text
                      style={[spotlightStyles.teamHeader, { color: colors.green, textAlign: "right" }]}
                      numberOfLines={1}
                    >
                      {match.away_team.name}
                    </Text>
                  </View>

                  {(
                    [
                      {
                        role: "⚽ Top Scorer",
                        home: statsData.enhanced.home_spotlights?.top_scorer,
                        away: statsData.enhanced.away_spotlights?.top_scorer,
                        statLabel: "G",
                      },
                      {
                        role: "🅰 Top Assist",
                        home: statsData.enhanced.home_spotlights?.top_assister,
                        away: statsData.enhanced.away_spotlights?.top_assister,
                        statLabel: "A",
                      },
                      {
                        role: "⚡ Most Fouls",
                        home: statsData.enhanced.home_spotlights?.top_fouler,
                        away: statsData.enhanced.away_spotlights?.top_fouler,
                        statLabel: "F",
                      },
                    ] as const
                  ).map(({ role, home, away, statLabel }) => (
                    <View key={role} style={spotlightStyles.spotRow}>
                      {/* Home player */}
                      <View style={spotlightStyles.playerCol}>
                        {home ? (
                          <>
                            <Text
                              style={[spotlightStyles.playerName, { color: colors.foreground }]}
                              numberOfLines={1}
                            >
                              {home.name}
                            </Text>
                            <View style={spotlightStyles.playerMeta}>
                              <Text style={[spotlightStyles.statBubble, { backgroundColor: "#1e1e2e", color: colors.primary }]}>
                                {home.total}{statLabel}
                              </Text>
                              <View
                                style={[
                                  spotlightStyles.probBadge,
                                  { backgroundColor: probColor(home.prob, 0.12) },
                                ]}
                              >
                                <Text style={[spotlightStyles.probText, { color: probColor(home.prob, 1) }]}>
                                  {home.prob.toFixed(0)}%
                                </Text>
                              </View>
                            </View>
                          </>
                        ) : (
                          <Text style={[spotlightStyles.playerName, { color: colors.mutedForeground }]}>—</Text>
                        )}
                      </View>

                      {/* Role label */}
                      <View style={spotlightStyles.roleCol}>
                        <Text style={[spotlightStyles.roleText, { color: colors.mutedForeground }]}>
                          {role}
                        </Text>
                      </View>

                      {/* Away player */}
                      <View style={[spotlightStyles.playerCol, { alignItems: "flex-end" }]}>
                        {away ? (
                          <>
                            <Text
                              style={[spotlightStyles.playerName, { color: colors.foreground, textAlign: "right" }]}
                              numberOfLines={1}
                            >
                              {away.name}
                            </Text>
                            <View style={[spotlightStyles.playerMeta, { flexDirection: "row-reverse" }]}>
                              <Text style={[spotlightStyles.statBubble, { backgroundColor: "#1e1e2e", color: colors.green }]}>
                                {away.total}{statLabel}
                              </Text>
                              <View
                                style={[
                                  spotlightStyles.probBadge,
                                  { backgroundColor: probColor(away.prob, 0.12) },
                                ]}
                              >
                                <Text style={[spotlightStyles.probText, { color: probColor(away.prob, 1) }]}>
                                  {away.prob.toFixed(0)}%
                                </Text>
                              </View>
                            </View>
                          </>
                        ) : (
                          <Text style={[spotlightStyles.playerName, { color: colors.mutedForeground, textAlign: "right" }]}>—</Text>
                        )}
                      </View>
                    </View>
                  ))}

                  <Text style={[spotlightStyles.footnote, { color: colors.mutedForeground }]}>
                    % = Poisson probability of registering ≥1 in this match
                  </Text>
                </View>
              )}
          </View>
        )}

        {/* ── STATS ── */}
        {activeTab === "stats" && (
          <View style={styles.section}>
            {!statsData ? (
              <ActivityIndicator color={colors.primary} />
            ) : (
              <View
                style={[
                  styles.card,
                  { backgroundColor: colors.card, borderColor: colors.border },
                ]}
              >
                {/* Team headers */}
                <View style={statsStyles.headerRow}>
                  <Text
                    style={[
                      statsStyles.teamHeader,
                      { color: colors.primary, textAlign: "left" },
                    ]}
                    numberOfLines={1}
                  >
                    {match.home_team.name}
                  </Text>
                  <View style={{ width: 80 }} />
                  <Text
                    style={[
                      statsStyles.teamHeader,
                      { color: colors.green, textAlign: "right" },
                    ]}
                    numberOfLines={1}
                  >
                    {match.away_team.name}
                  </Text>
                </View>

                {/* Form */}
                <View style={statStyles.row}>
                  <View style={{ width: 80, alignItems: "flex-start" }}>
                    <FormBubbles form={statsData.home.form} size={18} />
                  </View>
                  <Text
                    style={[
                      statStyles.label,
                      { color: colors.mutedForeground },
                    ]}
                  >
                    Form
                  </Text>
                  <View style={{ width: 80, alignItems: "flex-end" }}>
                    <FormBubbles form={statsData.away.form} size={18} />
                  </View>
                </View>

                <View
                  style={[
                    styles.divider,
                    { backgroundColor: colors.border },
                  ]}
                />

                <StatRow
                  label="Goals / game"
                  home={statsData.home.goals_per_game.toFixed(2)}
                  away={statsData.away.goals_per_game.toFixed(2)}
                  homeColor={colors.primary}
                  awayColor={colors.green}
                />
                <StatRow
                  label="Conceded / game"
                  home={statsData.home.conceded_per_game.toFixed(2)}
                  away={statsData.away.conceded_per_game.toFixed(2)}
                />
                <StatRow
                  label="Clean sheets"
                  home={`${statsData.home.clean_sheets}`}
                  away={`${statsData.away.clean_sheets}`}
                />
                <StatRow
                  label="Played"
                  home={`${statsData.home.matches_played}`}
                  away={`${statsData.away.matches_played}`}
                />
                <StatRow
                  label="W / D / L"
                  home={`${statsData.home.wins}/${statsData.home.draws}/${statsData.home.losses}`}
                  away={`${statsData.away.wins}/${statsData.away.draws}/${statsData.away.losses}`}
                />

                {/* Live stats if available */}
                {statsData.has_live_stats && (
                  <>
                    <View
                      style={[
                        styles.divider,
                        { backgroundColor: colors.border, marginVertical: 10 },
                      ]}
                    />
                    <Text
                      style={[
                        styles.sectionLabel,
                        { color: colors.mutedForeground },
                      ]}
                    >
                      LIVE
                    </Text>
                    {statsData.home.possession && statsData.away.possession && (
                      <StatRow
                        label="Possession"
                        home={statsData.home.possession}
                        away={statsData.away.possession}
                      />
                    )}
                    {statsData.home.shots_total != null && (
                      <StatRow
                        label="Shots"
                        home={`${statsData.home.shots_total}`}
                        away={`${statsData.away.shots_total ?? 0}`}
                      />
                    )}
                    {statsData.home.shots_on_target != null && (
                      <StatRow
                        label="On target"
                        home={`${statsData.home.shots_on_target}`}
                        away={`${statsData.away.shots_on_target ?? 0}`}
                      />
                    )}
                    {statsData.home.corners != null && (
                      <StatRow
                        label="Corners"
                        home={`${statsData.home.corners}`}
                        away={`${statsData.away.corners ?? 0}`}
                      />
                    )}
                    {statsData.home.fouls != null && (
                      <StatRow
                        label="Fouls"
                        home={`${statsData.home.fouls}`}
                        away={`${statsData.away.fouls ?? 0}`}
                      />
                    )}
                  </>
                )}
              </View>
            )}
          </View>
        )}

        {/* ── H2H ── */}
        {activeTab === "h2h" && (
          <View style={styles.section}>
            {!h2hData ? (
              <ActivityIndicator color={colors.primary} />
            ) : (
              <>
                {/* Summary */}
                <View
                  style={[
                    styles.card,
                    {
                      backgroundColor: colors.card,
                      borderColor: colors.border,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.cardTitle,
                      { color: colors.mutedForeground },
                    ]}
                  >
                    SUMMARY — {h2hData.ref_team} perspective
                  </Text>
                  <View style={h2hStyles.summaryRow}>
                    <View style={h2hStyles.summaryItem}>
                      <Text style={[h2hStyles.summaryVal, { color: colors.green }]}>
                        {h2hData.summary.wins}
                      </Text>
                      <Text
                        style={[
                          h2hStyles.summaryLabel,
                          { color: colors.mutedForeground },
                        ]}
                      >
                        W
                      </Text>
                    </View>
                    <View style={h2hStyles.summaryItem}>
                      <Text
                        style={[h2hStyles.summaryVal, { color: colors.mutedForeground }]}
                      >
                        {h2hData.summary.draws}
                      </Text>
                      <Text
                        style={[
                          h2hStyles.summaryLabel,
                          { color: colors.mutedForeground },
                        ]}
                      >
                        D
                      </Text>
                    </View>
                    <View style={h2hStyles.summaryItem}>
                      <Text
                        style={[h2hStyles.summaryVal, { color: colors.destructive }]}
                      >
                        {h2hData.summary.losses}
                      </Text>
                      <Text
                        style={[
                          h2hStyles.summaryLabel,
                          { color: colors.mutedForeground },
                        ]}
                      >
                        L
                      </Text>
                    </View>
                    <View style={h2hStyles.summaryItem}>
                      <Text
                        style={[h2hStyles.summaryVal, { color: colors.primary }]}
                      >
                        {h2hData.summary.goals_scored}
                      </Text>
                      <Text
                        style={[
                          h2hStyles.summaryLabel,
                          { color: colors.mutedForeground },
                        ]}
                      >
                        GF
                      </Text>
                    </View>
                    <View style={h2hStyles.summaryItem}>
                      <Text
                        style={[
                          h2hStyles.summaryVal,
                          { color: colors.mutedForeground },
                        ]}
                      >
                        {h2hData.summary.goals_conceded}
                      </Text>
                      <Text
                        style={[
                          h2hStyles.summaryLabel,
                          { color: colors.mutedForeground },
                        ]}
                      >
                        GA
                      </Text>
                    </View>
                  </View>
                </View>

                {/* Past meetings */}
                {h2hData.matches.map((m: H2HMatch, i: number) => {
                  const refIsHome =
                    m.home_team_id === h2hData.ref_team_id;
                  const resultColor =
                    m.result === "win"
                      ? colors.green
                      : m.result === "loss"
                        ? colors.destructive
                        : colors.mutedForeground;
                  return (
                    <View
                      key={i}
                      style={[
                        styles.card,
                        {
                          backgroundColor: colors.card,
                          borderColor: colors.border,
                          marginTop: 8,
                        },
                      ]}
                    >
                      <View style={h2hStyles.matchRow}>
                        <View
                          style={[
                            h2hStyles.resultDot,
                            { backgroundColor: resultColor },
                          ]}
                        />
                        <Text
                          style={[
                            h2hStyles.matchTeams,
                            { color: colors.foreground },
                          ]}
                          numberOfLines={1}
                        >
                          {m.home_team} {m.home_score}–{m.away_score}{" "}
                          {m.away_team}
                        </Text>
                      </View>
                      <View style={h2hStyles.matchMeta}>
                        <Text
                          style={[
                            h2hStyles.matchComp,
                            { color: colors.mutedForeground },
                          ]}
                        >
                          {m.competition}
                        </Text>
                        <Text
                          style={[
                            h2hStyles.matchDate,
                            { color: colors.mutedForeground },
                          ]}
                        >
                          {formatDate(m.date)}
                        </Text>
                      </View>
                    </View>
                  );
                })}
              </>
            )}
          </View>
        )}

        {/* ── LINEUP ── */}
        {activeTab === "lineup" && (
          <View style={styles.section}>
            {!statsData?.enhanced ? (
              <View style={styles.emptyState}>
                <ActivityIndicator color={colors.primary} />
                <Text style={[styles.emptyStateText, { color: colors.mutedForeground }]}>
                  Loading enhanced prediction…
                </Text>
              </View>
            ) : (
              <>
                {/* Enhanced probabilities vs base */}
                <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
                  <Text style={[styles.cardTitle, { color: colors.mutedForeground }]}>
                    ENHANCED MODEL
                  </Text>
                  <ProbabilityBar
                    home={statsData.enhanced.home_win}
                    draw={statsData.enhanced.draw}
                    away={statsData.enhanced.away_win}
                  />
                  <View style={lineupStyles.probCompRow}>
                    {[
                      { label: match.home_team.name, enhanced: statsData.enhanced.home_win, base: statsData.enhanced.base_home_win, color: colors.primary },
                      { label: "Draw", enhanced: statsData.enhanced.draw, base: statsData.enhanced.base_draw, color: colors.mutedForeground },
                      { label: match.away_team.name, enhanced: statsData.enhanced.away_win, base: statsData.enhanced.base_away_win, color: colors.green },
                    ].map(({ label, enhanced, base, color }) => {
                      const diff = enhanced - base;
                      return (
                        <View key={label} style={lineupStyles.probCompCol}>
                          <Text style={[lineupStyles.probLabel, { color: colors.mutedForeground }]} numberOfLines={1}>{label}</Text>
                          <Text style={[lineupStyles.probVal, { color }]}>{enhanced.toFixed(1)}%</Text>
                          {Math.abs(diff) >= 0.5 && (
                            <Text style={[lineupStyles.probDiff, { color: diff > 0 ? colors.green : colors.destructive }]}>
                              {diff > 0 ? "+" : ""}{diff.toFixed(1)}%
                            </Text>
                          )}
                        </View>
                      );
                    })}
                  </View>
                </View>

                {/* Adjustment factors */}
                <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border, marginTop: 10 }]}>
                  <Text style={[styles.cardTitle, { color: colors.mutedForeground }]}>MODEL ADJUSTMENTS</Text>
                  {[
                    { label: "Home advantage", value: statsData.enhanced.home_advantage ?? 1.08, type: "multiplier" },
                    { label: "Recent form — " + match.home_team.name, value: statsData.enhanced.home_form_factor ?? 1.0, type: "factor" },
                    { label: "Recent form — " + match.away_team.name, value: statsData.enhanced.away_form_factor ?? 1.0, type: "factor" },
                    { label: "Lineup quality — " + match.home_team.name, value: statsData.enhanced.home_lineup_factor, type: "factor" },
                    { label: "Lineup quality — " + match.away_team.name, value: statsData.enhanced.away_lineup_factor, type: "factor" },
                    { label: "Injury factor — " + match.home_team.name, value: statsData.enhanced.home_injury_factor, type: "factor" },
                    { label: "Injury factor — " + match.away_team.name, value: statsData.enhanced.away_injury_factor, type: "factor" },
                  ].map(({ label, value, type }) => {
                    const pct = (value - 1) * 100;
                    const unchanged = Math.abs(pct) < 0.5;
                    const color = unchanged ? colors.mutedForeground : pct > 0 ? colors.green : colors.destructive;
                    const display = type === "multiplier"
                      ? `×${value.toFixed(2)}`
                      : unchanged ? "—" : `${pct > 0 ? "+" : ""}${pct.toFixed(0)}%`;
                    return (
                      <View key={label} style={lineupStyles.factorRow}>
                        <Text style={[lineupStyles.factorLabel, { color: colors.foreground }]} numberOfLines={1}>{label}</Text>
                        <Text style={[lineupStyles.factorVal, { color: type === "multiplier" ? colors.primary : color }]}>
                          {display}
                        </Text>
                      </View>
                    );
                  })}
                  {statsData.enhanced.h2h && (
                    <View style={lineupStyles.factorRow}>
                      <Text style={[lineupStyles.factorLabel, { color: colors.foreground }]}>H2H blend (last {statsData.enhanced.h2h.matches})</Text>
                      <Text style={[lineupStyles.factorVal, { color: colors.primary }]}>30% weight</Text>
                    </View>
                  )}
                </View>

                {/* H2H record from enhanced */}
                {statsData.enhanced.h2h && statsData.enhanced.h2h.matches > 0 && (
                  <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border, marginTop: 10 }]}>
                    <Text style={[styles.cardTitle, { color: colors.mutedForeground }]}>
                      HEAD-TO-HEAD — LAST {statsData.enhanced.h2h.matches} MEETINGS
                    </Text>
                    <View style={lineupStyles.h2hRow}>
                      {[
                        { label: match.home_team.name, value: statsData.enhanced.h2h.home_wins, color: colors.primary },
                        { label: "Draw", value: statsData.enhanced.h2h.draws, color: colors.mutedForeground },
                        { label: match.away_team.name, value: statsData.enhanced.h2h.away_wins, color: colors.green },
                      ].map(({ label, value, color }) => (
                        <View key={label} style={lineupStyles.h2hItem}>
                          <Text style={[lineupStyles.h2hVal, { color }]}>{value}</Text>
                          <Text style={[lineupStyles.h2hLabel, { color: colors.mutedForeground }]} numberOfLines={1}>{label}</Text>
                        </View>
                      ))}
                    </View>
                  </View>
                )}

                {/* Injuries / suspensions */}
                {(statsData.enhanced.home_injuries.length > 0 || statsData.enhanced.away_injuries.length > 0) && (
                  <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border, marginTop: 10 }]}>
                    <Text style={[styles.cardTitle, { color: colors.mutedForeground }]}>ABSENCES</Text>
                    {[
                      { team: match.home_team.name, players: statsData.enhanced.home_injuries, color: colors.primary },
                      { team: match.away_team.name, players: statsData.enhanced.away_injuries, color: colors.green },
                    ].map(({ team, players, color }) =>
                      players.length > 0 ? (
                        <View key={team} style={{ marginBottom: 10 }}>
                          <Text style={[lineupStyles.absenceTeam, { color }]}>{team}</Text>
                          {players.map((p, i) => (
                            <View key={i} style={lineupStyles.absenceRow}>
                              <View style={[lineupStyles.absenceDot, {
                                backgroundColor: p.type === "Suspension" ? colors.amber : colors.destructive,
                              }]} />
                              <Text style={[lineupStyles.absenceName, { color: colors.foreground }]}>{p.name}</Text>
                              <Text style={[lineupStyles.absenceType, { color: colors.mutedForeground }]}>{p.type}</Text>
                            </View>
                          ))}
                        </View>
                      ) : null
                    )}
                  </View>
                )}

                {/* Starting XI */}
                {statsData.enhanced.lineup?.confirmed && (
                  <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border, marginTop: 10 }]}>
                    <Text style={[styles.cardTitle, { color: colors.mutedForeground }]}>STARTING XI</Text>
                    <View style={lineupStyles.xiHeader}>
                      <Text style={[lineupStyles.xiTeamHeader, { color: colors.primary }]} numberOfLines={1}>{match.home_team.name}</Text>
                      <Text style={[lineupStyles.xiTeamHeader, { color: colors.green, textAlign: "right" }]} numberOfLines={1}>{match.away_team.name}</Text>
                    </View>
                    {Array.from({ length: Math.max(statsData.enhanced.lineup.home.length, statsData.enhanced.lineup.away.length) }).map((_, i) => {
                      const h = statsData.enhanced!.lineup!.home[i];
                      const a = statsData.enhanced!.lineup!.away[i];
                      return (
                        <View key={i} style={lineupStyles.xiRow}>
                          <Text style={[lineupStyles.xiPlayer, { color: colors.foreground }]} numberOfLines={1}>
                            {h ? `${h.number}. ${h.name}` : ""}
                          </Text>
                          <Text style={[lineupStyles.xiPos, { color: colors.mutedForeground }]}>
                            {h?.position ?? ""}
                          </Text>
                          <Text style={[lineupStyles.xiPos, { color: colors.mutedForeground, textAlign: "right" }]}>
                            {a?.position ?? ""}
                          </Text>
                          <Text style={[lineupStyles.xiPlayer, { color: colors.foreground, textAlign: "right" }]} numberOfLines={1}>
                            {a ? `${a.name} .${a.number}` : ""}
                          </Text>
                        </View>
                      );
                    })}
                  </View>
                )}

                {/* No lineup yet */}
                {!statsData.enhanced.lineup?.confirmed && (
                  <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border, marginTop: 10 }]}>
                    <Text style={[styles.cardTitle, { color: colors.mutedForeground }]}>STARTING XI</Text>
                    <View style={styles.emptyState}>
                      <Feather name="clock" size={24} color={colors.mutedForeground} />
                      <Text style={[styles.emptyStateText, { color: colors.mutedForeground }]}>
                        Lineup released ~1 hour before kickoff
                      </Text>
                    </View>
                  </View>
                )}

                {/* Substitution impact — live / finished matches */}
                {statsData.enhanced.substitution_impacts && statsData.enhanced.substitution_impacts.length > 0 && (
                  <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border, marginTop: 10 }]}>
                    <Text style={[styles.cardTitle, { color: colors.mutedForeground }]}>SUBSTITUTION IMPACT</Text>

                    {/* Net xG delta summary */}
                    {(statsData.enhanced.home_sub_xg_delta != null || statsData.enhanced.away_sub_xg_delta != null) && (
                      <View style={lineupStyles.subSummaryRow}>
                        {[
                          { label: match.home_team.name, delta: statsData.enhanced.home_sub_xg_delta ?? 0, color: colors.primary },
                          { label: match.away_team.name, delta: statsData.enhanced.away_sub_xg_delta ?? 0, color: colors.green },
                        ].map(({ label, delta, color }) => {
                          const isPos = delta > 0.005;
                          const isNeg = delta < -0.005;
                          const deltaColor = isPos ? colors.green : isNeg ? colors.destructive : colors.mutedForeground;
                          return (
                            <View key={label} style={lineupStyles.subSummaryItem}>
                              <Text style={[lineupStyles.subSummaryTeam, { color }]} numberOfLines={1}>{label}</Text>
                              <Text style={[lineupStyles.subSummaryDelta, { color: deltaColor }]}>
                                {isPos ? "+" : ""}{delta.toFixed(2)} xG
                              </Text>
                            </View>
                          );
                        })}
                      </View>
                    )}

                    {/* Sub-adjusted probabilities if they differ */}
                    {statsData.enhanced.sub_adjusted_home_win != null && (
                      <View style={{ marginTop: 10, marginBottom: 4 }}>
                        <ProbabilityBar
                          home={statsData.enhanced.sub_adjusted_home_win}
                          draw={statsData.enhanced.sub_adjusted_draw ?? statsData.enhanced.draw}
                          away={statsData.enhanced.sub_adjusted_away_win ?? statsData.enhanced.away_win}
                        />
                        <Text style={[lineupStyles.subAdjLabel, { color: colors.mutedForeground }]}>
                          Adjusted for substitutions
                        </Text>
                      </View>
                    )}

                    <View style={[styles.divider, { backgroundColor: colors.border, marginVertical: 10 }]} />

                    {/* Individual substitutions */}
                    {statsData.enhanced.substitution_impacts.map((sub, i) => {
                      const isHome = sub.team === "home";
                      const teamColor = isHome ? colors.primary : colors.green;
                      const ratingColor =
                        sub.rating === "positive" ? colors.green :
                        sub.rating === "negative" ? colors.destructive :
                        colors.mutedForeground;
                      return (
                        <View key={i} style={lineupStyles.subRow}>
                          <View style={[lineupStyles.subMinuteBadge, { backgroundColor: colors.card, borderColor: colors.border }]}>
                            <Text style={[lineupStyles.subMinuteText, { color: colors.mutedForeground }]}>{sub.minute}′</Text>
                          </View>
                          <View style={[lineupStyles.subTeamDot, { backgroundColor: teamColor }]} />
                          <View style={{ flex: 1 }}>
                            <View style={lineupStyles.subPlayerRow}>
                              <Text style={[lineupStyles.subPlayerOut, { color: colors.destructive }]}>↓ {sub.player_out}</Text>
                            </View>
                            <View style={lineupStyles.subPlayerRow}>
                              <Text style={[lineupStyles.subPlayerIn, { color: colors.green }]}>↑ {sub.player_in}</Text>
                            </View>
                            <Text style={[lineupStyles.subTeamLabel, { color: colors.mutedForeground }]}>{sub.team_name}</Text>
                          </View>
                          <View style={lineupStyles.subImpactCol}>
                            <View style={[lineupStyles.subRatingBadge, {
                              backgroundColor:
                                sub.rating === "positive" ? "rgba(74,222,128,0.12)" :
                                sub.rating === "negative" ? "rgba(239,68,68,0.12)" :
                                "rgba(148,163,184,0.10)",
                            }]}>
                              <Text style={[lineupStyles.subRatingText, { color: ratingColor }]}>
                                {sub.rating === "positive" ? "▲" : sub.rating === "negative" ? "▼" : "—"} {sub.rating}
                              </Text>
                            </View>
                            <Text style={[lineupStyles.subXgDelta, { color: ratingColor }]}>
                              {sub.xg_delta > 0 ? "+" : ""}{sub.xg_delta.toFixed(2)} xG
                            </Text>
                          </View>
                        </View>
                      );
                    })}
                  </View>
                )}
              </>
            )}
          </View>
        )}

        {/* ── EVENTS ── */}
        {activeTab === "events" && (
          <View style={styles.section}>
            {!eventsData ? (
              match.status === "upcoming" ? (
                <View style={styles.emptyState}>
                  <Feather
                    name="clock"
                    size={28}
                    color={colors.mutedForeground}
                  />
                  <Text
                    style={[
                      styles.emptyStateText,
                      { color: colors.mutedForeground },
                    ]}
                  >
                    Match hasn't started yet
                  </Text>
                </View>
              ) : (
                <ActivityIndicator color={colors.primary} />
              )
            ) : eventsData.events.length === 0 ? (
              <View style={styles.emptyState}>
                <Text
                  style={[
                    styles.emptyStateText,
                    { color: colors.mutedForeground },
                  ]}
                >
                  No events yet
                </Text>
              </View>
            ) : (
              eventsData.events.map((event: MatchEvent, i: number) => (
                <View
                  key={i}
                  style={[
                    styles.eventRow,
                    {
                      borderBottomColor: colors.border,
                    },
                  ]}
                >
                  <Text
                    style={[styles.eventMin, { color: colors.mutedForeground }]}
                  >
                    {event.minute}
                    {event.extra_time ? `+${event.extra_time}` : ""}′
                  </Text>
                  <View style={styles.eventIcon}>
                    <EventIcon type={event.type} />
                  </View>
                  <View style={styles.eventInfo}>
                    <Text
                      style={[styles.eventPlayer, { color: colors.foreground }]}
                      numberOfLines={1}
                    >
                      {event.player ?? event.detail}
                    </Text>
                    <Text
                      style={[
                        styles.eventTeam,
                        { color: colors.mutedForeground },
                      ]}
                    >
                      {event.team_name}
                      {event.assist ? ` · Assist: ${event.assist}` : ""}
                    </Text>
                  </View>
                </View>
              ))
            )}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const statsStyles = StyleSheet.create({
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
  },
  teamHeader: { width: 80, fontSize: 11, fontFamily: "Inter_700Bold" },
});

const h2hStyles = StyleSheet.create({
  summaryRow: {
    flexDirection: "row",
    justifyContent: "space-around",
    marginTop: 6,
  },
  summaryItem: { alignItems: "center", gap: 2 },
  summaryVal: { fontSize: 28, fontFamily: "Inter_700Bold" },
  summaryLabel: { fontSize: 10, fontFamily: "Inter_500Medium" },
  matchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  resultDot: { width: 8, height: 8, borderRadius: 4 },
  matchTeams: { flex: 1, fontSize: 13, fontFamily: "Inter_600SemiBold" },
  matchMeta: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 4,
  },
  matchComp: { fontSize: 11, fontFamily: "Inter_400Regular" },
  matchDate: { fontSize: 11, fontFamily: "Inter_400Regular" },
});

const spotlightStyles = StyleSheet.create({
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 10,
  },
  teamHeader: { flex: 1, fontSize: 11, fontFamily: "Inter_700Bold", letterSpacing: 0.3 },
  roleCol: { width: 90, alignItems: "center" },
  spotRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#1e1e2e",
  },
  playerCol: { flex: 1, gap: 4 },
  playerName: { fontSize: 12, fontFamily: "Inter_600SemiBold" },
  playerMeta: { flexDirection: "row", alignItems: "center", gap: 5 },
  statBubble: {
    fontSize: 10,
    fontFamily: "Inter_700Bold",
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 4,
  },
  probBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  probText: { fontSize: 11, fontFamily: "Inter_700Bold" },
  roleText: { fontSize: 10, fontFamily: "Inter_500Medium", textAlign: "center" },
  footnote: {
    fontSize: 9,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    marginTop: 10,
    letterSpacing: 0.3,
  },
});

const lineupStyles = StyleSheet.create({
  probCompRow: { flexDirection: "row", justifyContent: "space-around", marginTop: 12 },
  probCompCol: { alignItems: "center", flex: 1, gap: 2 },
  probLabel: { fontSize: 10, fontFamily: "Inter_500Medium", textAlign: "center" },
  probVal: { fontSize: 18, fontFamily: "Inter_700Bold" },
  probDiff: { fontSize: 11, fontFamily: "Inter_600SemiBold" },
  factorRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 7,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#1e1e2e",
  },
  factorLabel: { flex: 1, fontSize: 12, fontFamily: "Inter_400Regular", marginRight: 8 },
  factorVal: { fontSize: 13, fontFamily: "Inter_700Bold" },
  h2hRow: { flexDirection: "row", justifyContent: "space-around", marginTop: 6 },
  h2hItem: { alignItems: "center", gap: 3 },
  h2hVal: { fontSize: 28, fontFamily: "Inter_700Bold" },
  h2hLabel: { fontSize: 10, fontFamily: "Inter_500Medium", textAlign: "center", maxWidth: 80 },
  absenceTeam: { fontSize: 11, fontFamily: "Inter_700Bold", letterSpacing: 0.4, marginBottom: 6 },
  absenceRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 5 },
  absenceDot: { width: 7, height: 7, borderRadius: 4 },
  absenceName: { flex: 1, fontSize: 13, fontFamily: "Inter_500Medium" },
  absenceType: { fontSize: 11, fontFamily: "Inter_400Regular" },
  xiHeader: { flexDirection: "row", justifyContent: "space-between", marginBottom: 8 },
  xiTeamHeader: { flex: 1, fontSize: 11, fontFamily: "Inter_700Bold", letterSpacing: 0.4 },
  xiRow: { flexDirection: "row", alignItems: "center", paddingVertical: 5, gap: 4 },
  xiPlayer: { flex: 3, fontSize: 12, fontFamily: "Inter_500Medium" },
  xiPos: { flex: 1, fontSize: 10, fontFamily: "Inter_400Regular", textAlign: "center" },
  subSummaryRow: { flexDirection: "row", justifyContent: "space-around", marginBottom: 4 },
  subSummaryItem: { alignItems: "center", flex: 1, gap: 2 },
  subSummaryTeam: { fontSize: 11, fontFamily: "Inter_600SemiBold", textAlign: "center" },
  subSummaryDelta: { fontSize: 16, fontFamily: "Inter_700Bold" },
  subAdjLabel: { fontSize: 9, fontFamily: "Inter_500Medium", textAlign: "center", marginTop: 4, letterSpacing: 0.5 },
  subRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingVertical: 8,
    gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#1e1e2e",
  },
  subMinuteBadge: {
    width: 34,
    height: 34,
    borderRadius: 6,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 2,
  },
  subMinuteText: { fontSize: 11, fontFamily: "Inter_700Bold" },
  subTeamDot: { width: 6, height: 6, borderRadius: 3, marginTop: 10 },
  subPlayerRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  subPlayerOut: { fontSize: 12, fontFamily: "Inter_500Medium" },
  subPlayerIn:  { fontSize: 12, fontFamily: "Inter_600SemiBold" },
  subTeamLabel: { fontSize: 10, fontFamily: "Inter_400Regular", marginTop: 2 },
  subImpactCol: { alignItems: "flex-end", gap: 4, minWidth: 80 },
  subRatingBadge: { borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 },
  subRatingText: { fontSize: 10, fontFamily: "Inter_700Bold", letterSpacing: 0.3 },
  subXgDelta: { fontSize: 11, fontFamily: "Inter_700Bold" },
});

const styles = StyleSheet.create({
  container: { flex: 1 },
  loadingContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backBtn: { padding: 4, marginRight: 8 },
  headerCenter: { flex: 1 },
  leagueName: { fontSize: 12, fontFamily: "Inter_500Medium" },
  statusChip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
  },
  statusChipText: {
    color: "#fff",
    fontSize: 11,
    fontFamily: "Inter_700Bold",
    letterSpacing: 0.5,
  },
  matchBanner: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 16,
    paddingHorizontal: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  teamCol: { flex: 1, alignItems: "center", gap: 8 },
  teamColRight: {},
  teamLabel: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    textAlign: "center",
  },
  teamLabelRight: { textAlign: "center" },
  scoreCol: { alignItems: "center", minWidth: 80 },
  scoreLarge: { fontSize: 32, fontFamily: "Inter_700Bold" },
  kickoffTime: { fontSize: 22, fontFamily: "Inter_700Bold" },
  htScore: { fontSize: 11, fontFamily: "Inter_400Regular", marginTop: 2 },
  tabBar: {
    flexDirection: "row",
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  tabBtn: {
    flex: 1,
    paddingVertical: 10,
    alignItems: "center",
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  tabText: { fontSize: 12 },
  content: { flex: 1 },
  section: { gap: 0 },
  card: {
    borderRadius: 8,
    borderWidth: 1,
    padding: 14,
  },
  cardTitle: {
    fontSize: 9,
    fontFamily: "Inter_700Bold",
    letterSpacing: 1,
    marginBottom: 12,
  },
  divider: { height: StyleSheet.hairlineWidth, marginVertical: 4 },
  sectionLabel: {
    fontSize: 9,
    fontFamily: "Inter_700Bold",
    letterSpacing: 1,
    marginBottom: 4,
  },
  oddsRow: {
    flexDirection: "row",
    justifyContent: "space-around",
    marginTop: 12,
  },
  oddsCol: { alignItems: "center", flex: 1, gap: 3 },
  oddsTeam: { fontSize: 10, fontFamily: "Inter_500Medium", textAlign: "center" },
  oddsVal: { fontSize: 18, fontFamily: "Inter_700Bold" },
  xgRow: {
    flexDirection: "row",
    justifyContent: "space-around",
    marginTop: 12,
  },
  xgItem: { alignItems: "center", gap: 3 },
  xgTeam: { fontSize: 10, fontFamily: "Inter_500Medium" },
  xgVal: { fontSize: 22, fontFamily: "Inter_700Bold" },
  eventRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 10,
  },
  eventMin: { width: 32, fontSize: 11, fontFamily: "Inter_600SemiBold" },
  eventIcon: { width: 20, alignItems: "center" },
  eventInfo: { flex: 1 },
  eventPlayer: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  eventTeam: { fontSize: 11, fontFamily: "Inter_400Regular", marginTop: 1 },
  emptyState: {
    alignItems: "center",
    paddingVertical: 40,
    gap: 10,
  },
  emptyStateText: { fontSize: 14, fontFamily: "Inter_400Regular" },
});
