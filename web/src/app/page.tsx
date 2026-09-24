import { getCurrentProfile } from "@/server/identity/identity";
import { getLeaderboard } from "@/server/points/points";
import { HomeActions } from "./home-actions";
import { Scoreboard } from "./scoreboard";

const dancingLetters = [
  { letter: "r", width: 233, height: 161 },
  { letter: "i", width: 170, height: 170 },
  { letter: "d", width: 152, height: 184 },
  { letter: "d", width: 152, height: 184 },
  { letter: "l", width: 132, height: 167 },
  { letter: "e", width: 157, height: 165 },
  { letter: "t", width: 167, height: 169 },
  { letter: "i", width: 170, height: 170 },
  { letter: "m", width: 179, height: 163 },
  { letter: "e", width: 157, height: 165 },
];

export default async function Home() {
  const profile = await getCurrentProfile();
  const leaderboard = profile ? await getLeaderboard() : [];

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex flex-col items-center gap-4 px-4 py-5 sm:flex-row sm:justify-between sm:px-8 sm:py-6">
        <h1 className="sr-only">RiddleTime</h1>
        <div aria-hidden="true" className="flex items-end gap-0.5 sm:gap-1">
          {dancingLetters.map(({ letter, width, height }, index) => (
            <span
              key={`${letter}-${index}`}
              className="dancing-letter"
              style={{
                animationDelay: `${-index * 140}ms`,
                animationDuration: `${1.15 + (index % 3) * 0.14}s`,
              }}
            >
              <img
                src={`/images/dancing-alphabet/dancing-${letter}.gif`}
                alt=""
                width={width}
                height={height}
                className={`h-9 w-auto sm:h-14 ${letter === "r" ? "-mr-4 sm:-mr-6" : ""}`}
              />
            </span>
          ))}
        </div>
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
