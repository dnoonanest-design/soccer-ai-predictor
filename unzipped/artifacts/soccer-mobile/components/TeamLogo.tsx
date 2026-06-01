import { Image } from "expo-image";
import React from "react";
import { StyleSheet, Text, View } from "react-native";

import { useColors } from "@/hooks/useColors";

interface TeamLogoProps {
  uri: string | null | undefined;
  name: string;
  size?: number;
}

export function TeamLogo({ uri, name, size = 28 }: TeamLogoProps) {
  const colors = useColors();

  if (uri) {
    return (
      <Image
        source={{ uri }}
        style={{ width: size, height: size }}
        contentFit="contain"
        transition={200}
      />
    );
  }

  return (
    <View
      style={[
        styles.fallback,
        {
          width: size,
          height: size,
          backgroundColor: colors.muted,
          borderRadius: size / 5,
        },
      ]}
    >
      <Text
        style={[
          styles.initial,
          { color: colors.mutedForeground, fontSize: size * 0.44 },
        ]}
      >
        {name.charAt(0).toUpperCase()}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  fallback: { alignItems: "center", justifyContent: "center" },
  initial: { fontFamily: "Inter_700Bold" },
});
