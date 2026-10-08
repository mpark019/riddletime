"use client";

import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Profile } from "@/server/identity/identity";
import type { LeaderboardEntry } from "@/server/points/points";
import { createTrailingCoalescer } from "@/lib/coalesce";
import { FloatingQuestionMarks } from "./floating-question-marks";
import { PrimaryButton } from "./primary-button";
import { InvitePanel, SignOutButton, UserAccountsPanel } from "./home-actions";
import { LeaderboardRealtime } from "./leaderboard-realtime";
import { PointsDesk, Scoreboard } from "./scoreboard";
import { RiddleGame } from "./riddle-game";
import { AdminRiddleScheduler } from "./admin-riddle-scheduler";

type WorkspaceView = "home" | "riddle" | "schedule" | "points" | "settings";
type SettingsTab = "general" | "invitations" | "users";

const REFRESH_COALESCE_MS = 250;

export function HomeWorkspace({
  children,
  profile,
  leaderboard,
  appDateContext,
}: {
  children: ReactNode;
  profile: Profile;
  leaderboard: LeaderboardEntry[];
  appDateContext: { today: string; timezone: string };
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

  const refreshCoalescer = useMemo(() => createTrailingCoalescer(() => {
    setRealtimeRefreshVersion((version) => version + 1);
    router.refresh();
  }, REFRESH_COALESCE_MS), [router]);
  useEffect(() => refreshCoalescer.cancel, [refreshCoalescer]);
  const refreshRealtimeData = refreshCoalescer.call;

  return (
    <div className={`light-surface flex min-h-screen flex-col ${view === "points" ? "max-sm:h-dvh max-sm:min-h-0" : ""}`}>
      <LeaderboardRealtime onChanged={refreshRealtimeData} />
      <header className="app-header relative z-40 mx-4 mt-4 flex flex-col items-center gap-4 rounded-md px-4 py-4 shadow-[0_0.5rem_1.5rem_rgb(0_2_46_/_25%)] sm:sticky sm:top-4 sm:mx-auto sm:grid sm:w-[calc(100%-2rem)] sm:max-w-[1280px] sm:grid-cols-[1fr_auto_auto] sm:gap-x-3 sm:px-8 sm:py-[15.5px]">
        <FloatingQuestionMarks contained />
        <div className="relative z-10 justify-self-start">{children}</div>
        <nav className="fixed inset-x-0 bottom-0 z-50 flex items-center border-t border-white/20 bg-surface-solid px-2 pb-[env(safe-area-inset-bottom)] sm:contents" aria-label="Workspace">
          <div className="contents sm:relative sm:z-10 sm:flex">
          <PillButton active={view === "home"} onClick={() => selectView("home")}>Home</PillButton>
          <PillButton active={view === "riddle"} onClick={() => selectView("riddle")}>Riddle</PillButton>
          {profile.role === "admin" && <PillButton active={view === "schedule"} onClick={() => selectView("schedule")}>Schedule</PillButton>}
          {canManagePoints && <PillButton active={view === "points"} onClick={() => selectView("points")}>Points</PillButton>}
          </div>
          <AccountMenu active={view === "settings"} profile={profile} onOpenSettings={() => selectView("settings")} />
        </nav>
      </header>

      <main className={`flex-1 sm:pb-0 ${view === "points" ? "pb-[calc(3.5rem+env(safe-area-inset-bottom))] max-sm:flex max-sm:min-h-0 max-sm:flex-col max-sm:overflow-y-auto" : "pb-[calc(5rem+env(safe-area-inset-bottom))]"}`}>
        {view === "home" && <Scoreboard initialEntries={leaderboard} />}
        {view === "riddle" && <RiddleGame playerId={profile.id} role={profile.role} onCompleted={refreshRealtimeData} />}
        {view === "schedule" && profile.role === "admin" && <AdminRiddleScheduler appTimezone={appDateContext.timezone} today={appDateContext.today} />}
        {view === "points" && canManagePoints && <PointsDesk players={leaderboard} canViewAudit={profile.role === "admin"} onChanged={async () => refreshRealtimeData()} refreshVersion={realtimeRefreshVersion} />}
        {view === "settings" && <SettingsPage profile={profile} isAdmin={profile.role === "admin"} tab={settingsTab} onTabChange={setSettingsTab} />}
      </main>
    </div>
  );
}

function PillButton({ active, children, onClick, ...props }: { active: boolean; children: ReactNode; onClick: () => void; "aria-label"?: string }) {
  return <button type="button" onClick={onClick} aria-pressed={active} className={`min-w-0 flex-1 border-b-2 px-3 py-3 text-sm font-semibold sm:text-base transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white sm:flex-none sm:px-5 ${active ? "border-white text-white" : "border-transparent text-white hover:text-white"}`} {...props}>{children}</button>;
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

  return <div ref={menuRef} className="relative z-10 flex flex-1 sm:flex-none sm:justify-self-end">
    <button type="button" onClick={() => setOpen((current) => !current)} aria-expanded={open} aria-haspopup="menu" className={`min-w-0 flex-1 border-b-2 px-3 py-3 text-sm font-semibold sm:text-base transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white sm:flex-none sm:text-left ${active ? "border-white text-white" : "border-transparent text-white hover:text-white"}`}>
      <span className="hidden sm:inline">{accountName} · {profile.role}</span>
      <span className="sm:hidden">Settings</span>
      <span className="ml-1 hidden text-white sm:inline" aria-hidden="true">⌄</span>
    </button>
    {open && <div role="menu" className="navy-surface absolute bottom-[calc(100%+0.75rem)] right-0 z-20 isolate w-64 overflow-hidden rounded-md border border-white/20 shadow-[0_1rem_2rem_rgb(0_2_46_/_30%)] sm:bottom-auto sm:top-[calc(100%+0.75rem)]">
      <FloatingQuestionMarks contained compact start={20} />
      <div className="flex flex-col gap-0.5 p-1.5">
        <button type="button" role="menuitem" onClick={() => { setOpen(false); onOpenSettings(); }} className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm font-semibold transition hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-white">
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 shrink-0"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></svg>
          Settings
        </button>
        <SignOutButton className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm font-semibold transition hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-white disabled:opacity-50" icon={<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 shrink-0"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5" /><path d="M21 12H9" /></svg>} />
      </div>
    </div>}
  </div>;
}

function InlineProfileField({ id, label, value, placeholder, autoComplete, onChange }: { id: string; label: string; value: string; placeholder: string; autoComplete?: string; onChange: (value: string) => void }) {
  return <div>
    <label htmlFor={id} className="text-sm font-semibold text-white">{label}</label>
    <div className="relative mt-1 -ml-2 max-w-md">
      <input id={id} type="text" autoComplete={autoComplete} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} className="w-full bg-black/[0.06] px-3 py-2 text-lg font-medium text-white transition placeholder:text-white hover:bg-black/25 focus:bg-black/25 focus:outline-2 focus:outline-white/80" />
    </div>
  </div>;
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
  return <button type="button" role="tab" aria-selected={active} onClick={onClick} className={`rounded-md border border-white/80 px-4 py-3 text-left text-sm font-semibold transition focus-visible:outline-2 focus-visible:outline-white ${active ? "navy-surface relative isolate overflow-hidden" : "bg-black/[0.04] text-white hover:bg-white/10 hover:text-white"}`}>{active && <FloatingQuestionMarks contained compact start={6} />}{children}</button>;
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
        <p className="text-sm text-white">Signed in as</p>
        <p className="mt-1 text-lg font-medium">{profile.displayName ?? profile.name ?? "Member"}</p>
        <p className="mt-1 text-sm font-semibold uppercase tracking-wide text-white">{profile.role}</p>
      </div>
    </div>

    <p className="mt-3 text-xs text-white">{spectatorAccount ? "Profile pictures are disabled for spectator accounts." : "Click the profile picture to upload a PNG, JPEG, WebP, or GIF up to 5 MiB."}</p>
    {avatarError && <p role="alert" className="mt-3 rounded-md border border-white bg-black/[0.06] px-4 py-3 text-sm text-white">{avatarError}</p>}
    {avatarNotice && <p aria-live="polite" className="mt-3 text-sm font-medium text-white">{avatarNotice}</p>}

    <form onSubmit={saveProfile} className="mt-8 flex flex-col gap-5">
      {spectatorAccount ? <div><p className="text-sm font-semibold text-white">Name</p><p className="mt-1 text-lg font-medium">{profile.name ?? "blank"}</p></div> : <InlineProfileField id="profile-name" label="Name" value={name} placeholder="Your name" autoComplete="name" onChange={(value) => { setName(value); setSaved(false); }} />}
      {profile.displayName && <div>
        <p className="text-sm text-white">Username</p>
        <p className="mt-1 font-medium">{profile.displayName}</p>
      </div>}
      {error && <p role="alert" className="rounded-md border border-white bg-black/[0.06] px-4 py-3 text-sm text-white">{error}</p>}
      {saved && <p aria-live="polite" className="text-sm font-medium text-white">Profile saved.</p>}
      {hasTextEdits && <PrimaryButton type="submit" disabled={busy} markStart={16} className="w-full px-4 py-3 sm:w-fit">
        {busy ? "Saving..." : "Save profile"}
      </PrimaryButton>}
    </form>
  </div>;
}
