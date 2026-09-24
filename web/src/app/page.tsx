import { getCurrentProfile } from "@/server/identity/identity";
import { HomeActions } from "./home-actions";

export default async function Home() {
  const profile = await getCurrentProfile();

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex items-center justify-between px-8 py-6">
        <span className="text-xl font-normal lowercase">riddletime</span>
        <div className="flex items-center gap-4">
          {profile && (
            <span className="text-sm text-white/80">
              {profile.displayName} · {profile.role}
            </span>
          )}
          <HomeActions loggedIn={Boolean(profile)} isAdmin={profile?.role === "admin"} />
        </div>
      </header>
    </div>
  );
}
