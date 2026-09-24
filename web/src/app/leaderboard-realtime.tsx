"use client";

import { useEffect } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { LEADERBOARD_CHANGED_EVENT, LEADERBOARD_REALTIME_TOPIC } from "@/lib/realtime/leaderboard";

export function LeaderboardRealtime({ onChanged }: { onChanged: () => void }) {
  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    const channel = supabase
      .channel(LEADERBOARD_REALTIME_TOPIC, { config: { private: true } })
      .on("broadcast", { event: LEADERBOARD_CHANGED_EVENT }, onChanged)
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [onChanged]);

  return null;
}
