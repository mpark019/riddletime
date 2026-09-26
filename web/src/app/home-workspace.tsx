"use client";

import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Profile } from "@/server/identity/identity";
import type { LeaderboardEntry } from "@/server/points/points";
import { InvitePanel, SignOutButton, UserAccountsPanel } from "./home-actions";
import { LeaderboardRealtime } from "./leaderboard-realtime";
import { PointsDesk, Scoreboard } from "./scoreboard";

type WorkspaceView = "home" | "riddle" | "points" | "settings";
type SettingsTab = "general" | "invitations" | "users";

export function HomeWorkspace({
  children,
  profile,
  leaderboard,
}: {
  children: ReactNode;
  profile: Profile;
  leaderboard: LeaderboardEntry[];
}) {
  const [view, setView] = useState<WorkspaceView>("home");
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const [realtimeRefreshVersion, setRealtimeRefreshVersion] = useState(0);
  const router = useRouter();
  const canManagePoints = profile.role === "admin" || profile.role === "spectator";

  function selectView(nextView: WorkspaceView) {
    setView(nextView);
    if (nextView === "settings") setSettingsTab("general");
  }

  const refreshRealtimeData = useCallback(() => {
    setRealtimeRefreshVersion((version) => version + 1);
    router.refresh();
  }, [router]);

  return (
    <div className="flex min-h-screen flex-col">
      <LeaderboardRealtime onChanged={refreshRealtimeData} />
      <header className="flex flex-col items-center gap-4 px-4 py-5 sm:flex-row sm:justify-between sm:px-8 sm:py-6">
        {children}
        <nav className="fixed inset-x-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-50 mx-auto flex max-w-md items-center border border-white/80 bg-black/10 p-1 backdrop-blur-sm sm:static sm:mx-0 sm:max-w-none sm:backdrop-blur-none" aria-label="Workspace">
          <PillButton active={view === "home"} onClick={() => selectView("home")}>Home</PillButton>
          <PillButton active={view === "riddle"} onClick={() => selectView("riddle")}>Riddle</PillButton>
          {canManagePoints && <PillButton active={view === "points"} onClick={() => selectView("points")}>Points</PillButton>}
          <AccountMenu active={view === "settings"} profile={profile} onOpenSettings={() => selectView("settings")} />
        </nav>
      </header>

      <main className="flex-1 pb-[calc(5rem+env(safe-area-inset-bottom))] sm:pb-0">
        {view === "home" && <Scoreboard initialEntries={leaderboard} />}
        {view === "riddle" && <RiddlePlaceholder />}
        {view === "points" && canManagePoints && <PointsDesk players={leaderboard} onChanged={async () => router.refresh()} refreshVersion={realtimeRefreshVersion} />}
        {view === "settings" && <SettingsPage profile={profile} isAdmin={profile.role === "admin"} tab={settingsTab} onTabChange={setSettingsTab} />}
      </main>
    </div>
  );
}

function PillButton({ active, children, onClick, ...props }: { active: boolean; children: ReactNode; onClick: () => void; "aria-label"?: string }) {
  return <button type="button" onClick={onClick} aria-pressed={active} className={`min-w-0 flex-1 px-3 py-2 text-sm font-bold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white sm:flex-none sm:px-5 ${active ? "bg-white text-[#102a43]" : "text-white/70 hover:bg-white/10 hover:text-white"}`} {...props}>{children}</button>;
}

function AccountMenu({ active, profile, onOpenSettings }: { active: boolean; profile: Profile; onOpenSettings: () => void }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const accountName = profile.displayName ?? profile.name ?? "Account";

  useEffect(() => {
    function closeOnOutsideClick(event: MouseEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  return <div ref={menuRef} className="relative flex flex-1 border-l border-white/15 pl-1 sm:ml-1 sm:flex-none">
    <button type="button" onClick={() => setOpen((current) => !current)} aria-expanded={open} aria-haspopup="menu" className={`min-w-0 flex-1 px-3 py-2 text-sm font-bold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white sm:flex-none sm:text-left ${active ? "bg-white text-[#102a43]" : "text-white hover:bg-white/10"}`}>
      <span className="hidden sm:inline">{accountName} · {profile.role}</span>
      <span className="sm:hidden">Settings</span>
      <span className={`ml-1 hidden sm:inline ${active ? "text-[#102a43]/60" : "text-white/60"}`} aria-hidden="true">⌄</span>
    </button>
    {open && <div role="menu" className="absolute bottom-[calc(100%+0.75rem)] right-0 z-20 w-64 overflow-hidden border border-white/60 bg-[#00022e] shadow-[0_1.5rem_3rem_rgb(0_0_46_/_60%)] sm:bottom-auto sm:top-[calc(100%+0.75rem)] sm:border-white/80">
      <div className="border-b border-white/50 px-4 py-3">
        <p className="truncate text-sm font-semibold text-white">{accountName}</p>
        <p className="mt-0.5 text-xs font-semibold uppercase tracking-wide text-white/60">{profile.role}</p>
      </div>
      <button type="button" role="menuitem" onClick={() => { setOpen(false); onOpenSettings(); }} className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm font-semibold text-white transition hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-white">
        Settings
      </button>
      <SignOutButton className="flex w-full items-center gap-3 border-t border-white/50 px-4 py-3 text-left text-sm font-semibold text-white transition hover:bg-white/10 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-white" />
    </div>}
  </div>;
}

function InlineProfileField({ id, label, value, placeholder, autoComplete, onChange }: { id: string; label: string; value: string; placeholder: string; autoComplete?: string; onChange: (value: string) => void }) {
  return <div>
    <label htmlFor={id} className="text-sm font-semibold text-white/70">{label}</label>
    <div className="relative mt-1 -ml-2 max-w-md">
      <input id={id} type="text" autoComplete={autoComplete} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} className="w-full bg-black/15 px-3 py-2 text-lg font-medium text-white transition placeholder:text-white/40 hover:bg-black/25 focus:bg-black/25 focus:outline-2 focus:outline-white/80" />
    </div>
  </div>;
}

function RiddlePlaceholder() {
  return <section className="mx-auto flex w-full max-w-4xl flex-col gap-3 px-4 py-8 sm:px-8 sm:py-12">
    <h2 className="text-3xl font-semibold tracking-tight">Riddle</h2>
    <div className="border border-white/80 bg-black/10 px-6 py-14 text-center">
      <p className="font-semibold">Today’s riddle is coming soon.</p>
    </div>
  </section>;
}

function SettingsPage({ profile, isAdmin, tab, onTabChange }: { profile: Profile; isAdmin: boolean; tab: SettingsTab; onTabChange: (tab: SettingsTab) => void }) {
  const initials = (profile.name ?? profile.displayName ?? "?").slice(0, 2).toUpperCase();

  return <section className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-8 sm:py-12">
    <h2 className="text-3xl font-semibold tracking-tight">Settings</h2>
    <div className="mt-10 grid gap-8 md:grid-cols-[12rem_1fr]">
      <div className="flex gap-2 md:flex-col" role="tablist" aria-label="Settings sections">
        <SettingsButton active={tab === "general"} onClick={() => onTabChange("general")}>General</SettingsButton>
        {isAdmin && <SettingsButton active={tab === "invitations"} onClick={() => onTabChange("invitations")}>Invitations</SettingsButton>}
        {isAdmin && <SettingsButton active={tab === "users"} onClick={() => onTabChange("users")}>Users</SettingsButton>}
      </div>
      <div>
        <div hidden={tab !== "general"}><ProfilePanel profile={profile} initials={initials} /></div>
        {isAdmin && <div hidden={tab !== "invitations"}><InvitePanel /></div>}
        {isAdmin && <div hidden={tab !== "users"}><UserAccountsPanel currentUserId={profile.id} /></div>}
      </div>
    </div>
  </section>;
}

function SettingsButton({ active, children, onClick }: { active: boolean; children: ReactNode; onClick: () => void }) {
  return <button type="button" role="tab" aria-selected={active} onClick={onClick} className={`border border-white/80 px-4 py-3 text-left text-sm font-semibold transition focus-visible:outline-2 focus-visible:outline-white ${active ? "bg-white text-[#102a43]" : "bg-black/10 text-white/70 hover:bg-white/10 hover:text-white"}`}>{children}</button>;
}

function ProfilePanel({ profile, initials }: { profile: Profile; initials: string }) {
  const router = useRouter();
  const spectatorAccount = profile.role === "spectator";
  const [name, setName] = useState(profile.name ?? "");
  const [savedName, setSavedName] = useState(profile.name ?? "");
  const [savedAvatarUrl, setSavedAvatarUrl] = useState(profile.avatarUrl);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [avatarNotice, setAvatarNotice] = useState<string | null>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const hasTextEdits = name.trim() !== savedName;

  async function saveProfile(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);

    const body: Record<string, string | null> = {
      name: name.trim() || null,
    };

    try {
      const response = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(result.error ?? "Could not save your profile.");
        return;
      }

      setName(result.name ?? "");
      setSavedName(result.name ?? "");
      setSavedAvatarUrl(result.avatarUrl ?? null);
      setSaved(true);
      router.refresh();
    } catch {
      setError("Could not save your profile.");
    } finally {
      setBusy(false);
    }
  }

  async function uploadAvatar(avatarFile: File) {
    setAvatarBusy(true);
    setAvatarError(null);
    setAvatarNotice(null);
    const formData = new FormData();
    formData.set("file", avatarFile);

    try {
      const response = await fetch("/api/profile/avatar", { method: "POST", body: formData });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        setAvatarError(result.error ?? "Could not upload your profile picture.");
        return;
      }

      setSavedAvatarUrl(result.avatarUrl ?? null);
      setAvatarNotice("Profile picture updated.");
      router.refresh();
    } catch {
      setAvatarError("Could not upload your profile picture.");
    } finally {
      setAvatarBusy(false);
    }
  }

  async function deleteAvatar() {
    setAvatarBusy(true);
    setAvatarError(null);
    setAvatarNotice(null);

    try {
      const response = await fetch("/api/profile/avatar", { method: "DELETE" });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        setAvatarError(result.error ?? "Could not remove your profile picture.");
        return;
      }

      setSavedAvatarUrl(null);
      setAvatarNotice("Profile picture removed.");
      router.refresh();
    } catch {
      setAvatarError("Could not remove your profile picture.");
    } finally {
      setAvatarBusy(false);
    }
  }

  return <div className="max-w-xl">
    <h3 className="text-2xl font-semibold">Profile</h3>
    <div className="mt-8 flex items-center gap-4">
      <div className="group relative h-20 w-20 shrink-0">
        <div className="relative h-full w-full overflow-hidden rounded-full border border-white/80">
          {savedAvatarUrl ? (
            // Avatar URLs are validated server-side before being stored.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={savedAvatarUrl} alt="" className="h-full w-full object-cover transition group-hover:brightness-50 group-focus-within:brightness-50" />
          ) : (
            <span className="flex h-full w-full items-center justify-center bg-white/15 text-2xl font-semibold transition group-hover:bg-black/25 group-focus-within:bg-black/25" aria-hidden="true">{initials}</span>
          )}
          {!spectatorAccount && <button type="button" disabled={avatarBusy} onClick={() => avatarInputRef.current?.click()} className="absolute inset-0 flex cursor-pointer items-center justify-center bg-black/45 px-2 text-center text-xs font-semibold text-white opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-white disabled:cursor-wait">
            {avatarBusy ? "Working…" : "Change"}
          </button>}
        </div>
        {!spectatorAccount && savedAvatarUrl && <button type="button" disabled={avatarBusy} onClick={() => void deleteAvatar()} aria-label="Remove profile picture" title="Remove profile picture" className="absolute -right-1 -top-1 z-10 flex h-6 w-6 cursor-pointer items-center justify-center rounded-full bg-[#9f3f42] text-base font-medium leading-none text-white shadow-sm transition hover:bg-[#b94b4f] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:cursor-wait">
          ×
        </button>}
      </div>
      {!spectatorAccount && <input ref={avatarInputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="sr-only" tabIndex={-1} onChange={(event) => {
        const avatarFile = event.currentTarget.files?.[0];
        event.currentTarget.value = "";
        if (avatarFile) void uploadAvatar(avatarFile);
      }} />}
      <div>
        <p className="text-sm text-white/60">Signed in as</p>
        <p className="mt-1 text-lg font-medium">{profile.displayName ?? profile.name ?? "Member"}</p>
        <p className="mt-1 text-sm font-semibold uppercase tracking-wide text-white/60">{profile.role}</p>
      </div>
    </div>

    <p className="mt-3 text-xs text-white/60">{spectatorAccount ? "Profile pictures are disabled for spectator accounts." : "Click the profile picture to upload a PNG, JPEG, WebP, or GIF up to 5 MiB."}</p>
    {avatarError && <p role="alert" className="mt-3 border border-white bg-black/15 px-4 py-3 text-sm text-white">{avatarError}</p>}
    {avatarNotice && <p aria-live="polite" className="mt-3 text-sm font-medium text-white/80">{avatarNotice}</p>}

    <form onSubmit={saveProfile} className="mt-8 flex flex-col gap-5">
      {spectatorAccount ? <div><p className="text-sm font-semibold text-white/70">Name</p><p className="mt-1 text-lg font-medium">{profile.name ?? "blank"}</p></div> : <InlineProfileField id="profile-name" label="Name" value={name} placeholder="Your name" autoComplete="name" onChange={(value) => { setName(value); setSaved(false); }} />}
      {profile.displayName && <div>
        <p className="text-sm text-white/60">Username</p>
        <p className="mt-1 font-medium">{profile.displayName}</p>
      </div>}
      {error && <p role="alert" className="border border-white bg-black/15 px-4 py-3 text-sm text-white">{error}</p>}
      {saved && <p aria-live="polite" className="text-sm font-medium text-white/80">Profile saved.</p>}
      {hasTextEdits && <button type="submit" disabled={busy} className="w-full border border-white bg-white px-4 py-3 font-semibold text-[#102a43] transition hover:bg-transparent hover:text-white disabled:cursor-not-allowed disabled:opacity-50 sm:w-fit">
        {busy ? "Saving..." : "Save profile"}
      </button>}
    </form>
  </div>;
}
