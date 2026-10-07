import type { CSSProperties } from "react";
import { getCurrentProfile } from "@/server/identity/identity";
import { getLeaderboard } from "@/server/points/points";
import { HomeWorkspace } from "./home-workspace";
import { FloatingQuestionMarks } from "./floating-question-marks";
import { LoginForm } from "./login-form";

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

  if (!profile) {
    return (
      <>
        <FloatingQuestionMarks />
        <main className="flex min-h-screen flex-col items-center justify-center gap-10 px-6">
          <RiddleTimeWordmark />
          <LoginForm />
        </main>
      </>
    );
  }

  const leaderboard = await getLeaderboard();

  return <HomeWorkspace profile={profile} leaderboard={leaderboard}><RiddleTimeWordmark /></HomeWorkspace>;
}

function RiddleTimeWordmark() {
  return (
    <div className="max-sm:w-full">
      <h1 className="sr-only">RiddleTime</h1>
      <div aria-hidden="true" className="flex items-end gap-0.5 sm:gap-1 max-sm:w-full">
        {dancingLetters.map(({ letter, width, height }, index) => (
          <span
            key={`${letter}-${index}`}
            className="dancing-letter max-sm:min-w-0 max-sm:grow-(--ratio) max-sm:basis-0"
            style={{
              "--ratio": (width / height).toFixed(3),
              animationDelay: `${-index * 140}ms`,
              animationDuration: `${1.15 + (index % 3) * 0.14}s`,
            } as CSSProperties}
          >
            <img
              src={`/images/dancing-alphabet/dancing-${letter}.gif`}
              alt=""
              width={width}
              height={height}
              className={letter === "r"
                ? "h-auto w-full sm:h-14 sm:w-auto sm:-mr-5"
                : "h-auto w-full sm:h-12 sm:w-auto"}
            />
          </span>
        ))}
      </div>
    </div>
  );
}
