import { getCurrentProfile } from "@/server/identity/identity";
import { getLeaderboard } from "@/server/points/points";
import { HomeActions } from "./home-actions";
import { Scoreboard } from "./scoreboard";

export default async function Home() {
  const profile = await getCurrentProfile();
  const leaderboard = profile ? await getLeaderboard() : [];

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex items-center justify-between px-8 py-6">
        <span className="text-xl font-normal lowercase">riddletime</span>
        <div className="flex items-center gap-4">
          {profile && (
            <span className="text-sm text-white/80">
              {[profile.name, profile.displayName, profile.role].filter(Boolean).join(" · ")}
            </span>
          )}
          <HomeActions loggedIn={Boolean(profile)} isAdmin={profile?.role === "admin"} />
        </div>
      </header>
      {profile && <Scoreboard initialEntries={leaderboard} isAdmin={profile.role === "admin"} />}
    </div>
  );
}
