import React from "react";
import { StyleSheet, Text, View } from "react-native";

import { useColors } from "@/hooks/useColors";

interface FormBubblesProps {
  form: string;
  size?: number;
}

export function FormBubbles({ form, size = 20 }: FormBubblesProps) {
  const colors = useColors();
  const chars = form.split("").slice(-5);

  return (
    <View style={styles.row}>
      {chars.map((c, i) => {
        const bg =
          c === "W"
            ? colors.green
            : c === "D"
              ? colors.muted
              : colors.destructive;
        const textColor =
          c === "D" ? colors.mutedForeground : colors.destructiveForeground;
        return (
          <View
            key={i}
            style={[
              styles.bubble,
              { backgroundColor: bg, width: size, height: size, borderRadius: size / 2 },
            ]}
          >
            <Text
              style={[
                styles.text,
                { color: textColor, fontSize: size * 0.48 },
              ]}
            >
              {c}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: 4 },
  bubble: { alignItems: "center", justifyContent: "center" },
  text: { fontFamily: "Inter_700Bold" },
});
