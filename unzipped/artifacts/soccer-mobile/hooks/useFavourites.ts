import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "@pulse/favourites";

export function useFavourites() {
  const [favouriteIds, setFavouriteIds] = useState<Set<number>>(new Set());

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((raw) => {
      if (raw) {
        try {
          const ids: number[] = JSON.parse(raw);
          setFavouriteIds(new Set(ids));
        } catch {}
      }
    });
  }, []);

  const persist = useCallback((next: Set<number>) => {
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
  }, []);

  const toggleFavourite = useCallback(
    (matchId: number) => {
      setFavouriteIds((prev) => {
        const next = new Set(prev);
        if (next.has(matchId)) {
          next.delete(matchId);
        } else {
          next.add(matchId);
        }
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const isFavourite = useCallback(
    (matchId: number) => favouriteIds.has(matchId),
    [favouriteIds],
  );

  return { favouriteIds, isFavourite, toggleFavourite };
}
