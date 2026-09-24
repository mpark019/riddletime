"use client";

import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Profile } from "@/server/identity/identity";
import type { LeaderboardEntry } from "@/server/points/points";
import { InvitePanel, SignOutButton } from "./home-actions";
import { PointsDesk, Scoreboard } from "./scoreboard";

type WorkspaceView = "home" | "riddle" | "points" | "settings";
type SettingsTab = "general" | "invitations";

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
  const router = useRouter();
  const canManagePoints = profile.role === "admin" || profile.role === "spectator";

  function selectView(nextView: WorkspaceView) {
    setView(nextView);
    if (nextView === "settings") setSettingsTab("general");
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex flex-col items-center gap-4 border-b border-white/10 bg-slate-950/30 px-4 py-5 backdrop-blur-sm sm:flex-row sm:justify-between sm:px-8 sm:py-6">
        {children}
        <div className="flex flex-wrap items-center justify-center gap-3 sm:justify-end">
          <nav className="flex items-center rounded-full border border-white/20 bg-slate-950/45 p-1 shadow-lg shadow-black/20" aria-label="Workspace">
            <PillButton active={view === "home"} onClick={() => selectView("home")}>Home</PillButton>
            <PillButton active={view === "riddle"} onClick={() => selectView("riddle")}>Riddle</PillButton>
            {canManagePoints && <PillButton active={view === "points"} onClick={() => selectView("points")}>Points</PillButton>}
            <AccountMenu profile={profile} onOpenSettings={() => selectView("settings")} />
          </nav>
        </div>
      </header>

      {view === "home" && <Scoreboard initialEntries={leaderboard} />}
      {view === "riddle" && <RiddlePlaceholder />}
      {view === "points" && canManagePoints && <PointsDesk players={leaderboard} onChanged={async () => router.refresh()} />}
      {view === "settings" && <SettingsPage profile={profile} isAdmin={profile.role === "admin"} tab={settingsTab} onTabChange={setSettingsTab} />}
    </div>
  );
}

function PillButton({ active, children, onClick, ...props }: { active: boolean; children: ReactNode; onClick: () => void; "aria-label"?: string }) {
  return <button type="button" onClick={onClick} aria-pressed={active} className={`rounded-full px-4 py-2 text-sm font-bold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-200 sm:px-5 ${active ? "bg-white text-slate-950 shadow-sm" : "text-white/70 hover:bg-white/10 hover:text-white"}`} {...props}>{children}</button>;
}

function AccountMenu({ profile, onOpenSettings }: { profile: Profile; onOpenSettings: () => void }) {
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

  return <div ref={menuRef} className="relative ml-1 border-l border-white/15 pl-1">
    <button type="button" onClick={() => setOpen((current) => !current)} aria-expanded={open} aria-haspopup="menu" className="rounded-full px-3 py-2 text-left text-sm font-bold text-white transition hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-200">
      <span className="hidden sm:inline">{accountName} · {profile.role}</span>
      <span className="sm:hidden" aria-label="Account settings">⚙</span>
      <span className="ml-1 text-white/60" aria-hidden="true">⌄</span>
    </button>
    {open && <div role="menu" className="absolute right-0 top-[calc(100%+0.75rem)] z-20 w-64 overflow-hidden rounded-2xl border border-white/20 bg-slate-950 p-2 shadow-2xl shadow-black/40">
      <div className="border-b border-white/15 px-3 py-2.5">
        <p className="truncate text-sm font-semibold text-white">{accountName}</p>
        <p className="mt-0.5 text-xs font-semibold uppercase tracking-wide text-white/60">{profile.role}</p>
      </div>
      <button type="button" role="menuitem" onClick={() => { setOpen(false); onOpenSettings(); }} className="mt-1 flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-semibold text-white transition hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-cyan-200">
        Settings
      </button>
      <div className="my-1 border-t border-white/15" />
      <SignOutButton className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-semibold text-white transition hover:bg-white/10 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-cyan-200" />
    </div>}
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
      </div>
      <div>
        <div hidden={tab !== "general"}><ProfilePanel profile={profile} initials={initials} /></div>
        {isAdmin && <div hidden={tab !== "invitations"}><InvitePanel /></div>}
      </div>
    </div>
  </section>;
}

function SettingsButton({ active, children, onClick }: { active: boolean; children: ReactNode; onClick: () => void }) {
  return <button type="button" role="tab" aria-selected={active} onClick={onClick} className={`rounded-xl px-4 py-3 text-left text-sm font-semibold transition ${active ? "bg-white text-slate-950" : "text-white/70 hover:bg-white/10 hover:text-white"}`}>{children}</button>;
}

function ProfilePanel({ profile, initials }: { profile: Profile; initials: string }) {
  return <div className="max-w-xl">
    <h3 className="text-2xl font-semibold">Profile</h3>
    <div className="mt-8 flex items-center gap-4">
      <span className="flex h-20 w-20 items-center justify-center rounded-full bg-white/15 text-2xl font-semibold">{initials}</span>
      <div>
        <p className="text-sm text-white/60">Full name</p>
        <p className="mt-1 text-lg font-medium">{profile.name ?? profile.displayName ?? "Not provided"}</p>
      </div>
    </div>
    <dl className="mt-8 grid gap-6 text-base">
      {profile.email && <div><dt className="text-sm text-white/60">Email</dt><dd className="mt-1 font-medium">{profile.email}</dd></div>}
      <div><dt className="text-sm text-white/60">Role</dt><dd className="mt-1 font-medium uppercase">{profile.role}</dd></div>
    </dl>
  </div>;
}
