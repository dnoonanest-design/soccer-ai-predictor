import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useState } from "react";

export type OddsFormat = "fractional" | "decimal";

const STORAGE_KEY = "@pulse/odds_format";

export function useOddsFormat() {
  const [format, setFormat] = useState<OddsFormat>("fractional");

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((val) => {
      if (val === "fractional" || val === "decimal") setFormat(val);
    });
  }, []);

  const setOddsFormat = useCallback((next: OddsFormat) => {
    setFormat(next);
    AsyncStorage.setItem(STORAGE_KEY, next);
  }, []);

  return { format, setOddsFormat };
}
