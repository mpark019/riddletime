"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import type { PendingInvitation } from "@/server/invitations/invitations";

type Role = "spectator" | "player" | "admin";

const roleOptions: Array<{ value: Role; label: string }> = [
  { value: "spectator", label: "Spectator" },
  { value: "player", label: "Player" },
  { value: "admin", label: "Admin" },
];

export function SignOutButton({ className }: { className?: string }) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);

  async function handleClick() {
    setSubmitting(true);
    const supabase = createSupabaseBrowserClient();
    await supabase.auth.signOut();
    router.push("/");
    router.refresh();
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={submitting}
      className={className ?? "rounded-xl border border-white/20 bg-white/5 px-4 py-2 text-sm font-bold text-white transition hover:bg-white/10 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-200"}
    >
      {submitting ? "Signing out..." : "Sign out"}
    </button>
  );
}

export function InvitePanel() {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("player");
  const [initialScore, setInitialScore] = useState("0");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [pending, setPending] = useState<PendingInvitation[]>([]);
  const [listLoading, setListLoading] = useState(true);

  async function refreshPending() {
    const response = await fetch("/api/admin/invitations");
    if (response.ok) {
      setPending(await response.json());
    }
    setListLoading(false);
  }

  useEffect(() => {
    let ignore = false;
    fetch("/api/admin/invitations").then(async (response) => {
      if (ignore) return;
      if (response.ok) {
        setPending(await response.json());
      }
      setListLoading(false);
    });
    return () => {
      ignore = true;
    };
  }, []);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setFormError(null);

    const body: Record<string, unknown> = role === "player"
      ? { displayName, password, initialScore: Number(initialScore), ...(name.trim() ? { name } : {}) }
      : { email, role, ...(displayName.trim() ? { displayName } : {}) };

    const response = await fetch(role === "player" ? "/api/admin/players" : "/api/admin/invitations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      setFormError(data.error ?? (role === "player" ? "Could not create this player." : "Could not send this invitation."));
      setSubmitting(false);
      return;
    }

    setEmail("");
    setName("");
    setDisplayName("");
    setPassword("");
    setSubmitting(false);
    await refreshPending();
  }

  return (
    <section className="flex w-full max-w-2xl flex-col gap-6">
      <div>
        <h2 className="text-2xl font-semibold">Add member</h2>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {role !== "player" && <label className="flex flex-col gap-1 text-sm">
            Email
            <input
              type="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="border border-white/80 bg-black/10 px-4 py-3 text-white focus:outline-2 focus:outline-white"
            />
          </label>}
          {role === "player" && <label className="flex flex-col gap-1 text-sm">
            Name (optional)
            <input
              type="text"
              autoComplete="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="border border-white/80 bg-black/10 px-4 py-3 text-white focus:outline-2 focus:outline-white"
            />
          </label>}
          <label className="flex flex-col gap-1 text-sm">
            {role === "player" ? "Display name / username" : "Display name (optional)"}
            <input
              type="text"
              required={role === "player"}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              pattern={role === "player" ? "[A-Za-z0-9][A-Za-z0-9_-]{2,31}" : undefined}
              title={role === "player" ? "Use 3–32 letters, numbers, underscores, or hyphens." : undefined}
              className="border border-white/80 bg-black/10 px-4 py-3 text-white focus:outline-2 focus:outline-white"
            />
          </label>
          <div className="flex flex-col gap-1 text-sm">
            <span className="font-semibold">Role</span>
            <RolePicker value={role} onChange={setRole} />
          </div>
          {role === "player" && (
            <>
            <label className="flex flex-col gap-1 text-sm">
              Initial password
              <input
                type="password"
                required
                minLength={12}
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="border border-white/80 bg-black/10 px-4 py-3 text-white focus:outline-2 focus:outline-white"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Initial score
              <input
                type="number"
                min={0}
                required
                value={initialScore}
                onChange={(event) => setInitialScore(event.target.value)}
                className="number-field border border-white/80 bg-black/10 px-4 py-3 text-white focus:outline-2 focus:outline-white"
              />
            </label>
            </>
          )}
          {formError && <p className="border border-white bg-black/15 px-4 py-3 text-sm text-white">{formError}</p>}
          <button
            type="submit"
            disabled={submitting}
            className="border border-white bg-white px-4 py-3 font-semibold text-[#4169e1] transition hover:bg-transparent hover:text-white disabled:opacity-50"
          >
            {submitting ? (role === "player" ? "Creating..." : "Sending...") : (role === "player" ? "Create player" : "Send invite")}
          </button>
      </form>

      <div className="flex flex-col gap-3 border-t border-white/50 pt-4">
        <h3 className="text-sm text-white/60">Pending invitations</h3>
        {listLoading && <p className="text-sm text-white/60">Loading...</p>}
        {!listLoading && pending.length === 0 && (
          <p className="text-sm text-white/60">None pending.</p>
        )}
        {pending.map((invitation) => (
          <PendingRow key={invitation.id} invitation={invitation} onChanged={refreshPending} />
        ))}
      </div>
    </section>
  );
}

export function PlayerAccountsPanel() {
  const [players, setPlayers] = useState<Array<{ id: string; name: string | null; displayName: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; displayName: string } | null>(null);
  const refresh = async () => { const response = await fetch("/api/admin/players"); if (response.ok) setPlayers(await response.json()); else setError("Could not load players."); };
  useEffect(() => { const timer = window.setTimeout(() => { void refresh(); }, 0); return () => window.clearTimeout(timer); }, []);
  async function save(id: string, displayName: string, password: string) {
    const response = await fetch(`/api/admin/players/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ displayName, ...(password ? { password } : {}) }) });
    if (!response.ok) { const body = await response.json().catch(() => ({})); setError(body.error ?? "Could not update player."); return false; }
    await refresh();
    return true;
  }
  async function remove(id: string) {
    const response = await fetch(`/api/admin/players/${id}`, { method: "DELETE" });
    if (!response.ok) { const body = await response.json().catch(() => ({})); setError(body.error ?? "Could not delete player."); return; }
    setPendingDelete(null);
    await refresh();
  }
  return <section className="flex w-full max-w-2xl flex-col gap-4"><div><h2 className="text-2xl font-semibold">Players</h2></div>{players.map((player) => <PlayerRow key={player.id} player={player} onSave={save} onDelete={(id, displayName) => setPendingDelete({ id, displayName })} />)}{players.length === 0 && <p className="text-sm text-white/60">No players yet.</p>}{error && <p className="text-red-300">{error}</p>}{pendingDelete && <DeletePlayerDialog player={pendingDelete} onCancel={() => setPendingDelete(null)} onConfirm={() => void remove(pendingDelete.id)} />}</section>;
}

function DeletePlayerDialog({ player, onCancel, onConfirm }: { player: { id: string; displayName: string }; onCancel: () => void; onConfirm: () => void }) {
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4" role="presentation"><div role="alertdialog" aria-modal="true" aria-labelledby="delete-player-title" aria-describedby="delete-player-description" className="w-full max-w-md border border-red-200/80 bg-[#4169e1] p-6 shadow-2xl"><p className="text-xs font-bold uppercase tracking-[0.2em] text-red-100">Permanent action</p><h3 id="delete-player-title" className="mt-2 text-2xl font-semibold">Delete {player.displayName}?</h3><p id="delete-player-description" className="mt-3 text-white/80">This permanently removes the account and all of its game history. It cannot be undone.</p><div className="mt-6 flex justify-end gap-3"><button type="button" onClick={onCancel} className="border border-white/80 px-4 py-2 font-semibold hover:bg-white/10">Cancel</button><button type="button" onClick={onConfirm} className="border border-red-200 bg-red-200 px-4 py-2 font-semibold text-[#4169e1] hover:bg-transparent hover:text-white">Delete permanently</button></div></div></div>;
}

function PlayerRow({ player, onSave, onDelete }: { player: { id: string; name: string | null; displayName: string }; onSave: (id: string, displayName: string, password: string) => Promise<boolean>; onDelete: (id: string, displayName: string) => void }) {
  const [displayName, setDisplayName] = useState(player.displayName); const [password, setPassword] = useState(""); const [passwordSaved, setPasswordSaved] = useState(false);
  async function savePlayer() {
    const passwordWasProvided = Boolean(password);
    const saved = await onSave(player.id, displayName, password);
    if (saved && passwordWasProvided) {
      setPassword("");
      setPasswordSaved(true);
    }
  }
  return <div className="flex flex-col gap-3 border border-white/80 p-3"><p className="text-sm text-white/60">{player.name ?? "No name"}</p><input aria-label={`Display name for ${player.displayName}`} value={displayName} onChange={(e) => setDisplayName(e.target.value)} className="border border-white/80 bg-black/10 px-3 py-2" /><input aria-label={`New password for ${player.displayName}`} type="password" minLength={12} placeholder="New password (optional)" value={password} onChange={(e) => { setPassword(e.target.value); setPasswordSaved(false); }} className="border border-white/80 bg-black/10 px-3 py-2" />{passwordSaved && <p aria-live="polite" className="text-sm font-medium text-white/80">Password saved successfully.</p>}<div className="flex gap-2"><button type="button" onClick={() => void savePlayer()} className="border border-white bg-white px-3 py-2 font-semibold text-[#4169e1] transition hover:bg-transparent hover:text-white focus-visible:outline-2 focus-visible:outline-white">Save</button><button type="button" onClick={() => void onDelete(player.id, player.displayName)} className="border border-red-300 bg-red-200 px-3 py-2 font-semibold text-[#4169e1] transition hover:bg-transparent hover:text-white focus-visible:outline-2 focus-visible:outline-white">Delete account</button></div></div>;
}

function RolePicker({ value, onChange }: { value: Role; onChange: (role: Role) => void }) {
  const [open, setOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const selected = roleOptions.find((option) => option.value === value)!;

  useEffect(() => {
    function closeOnOutsideClick(event: MouseEvent) {
      if (!pickerRef.current?.contains(event.target as Node)) setOpen(false);
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

  return <div ref={pickerRef} className="relative">
    <button type="button" onClick={() => setOpen((current) => !current)} aria-expanded={open} aria-haspopup="listbox" className="flex w-full items-center justify-between border border-white/80 bg-black/10 px-4 py-3 text-left font-medium text-white transition hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-white">
      <span>{selected.label}</span><span aria-hidden="true">⌄</span>
    </button>
    {open && <div role="listbox" aria-label="Member role" className="absolute z-10 mt-2 w-full border border-white bg-[#4169e1] p-1">
      {roleOptions.map((option) => <button key={option.value} type="button" role="option" aria-selected={option.value === value} onClick={() => { onChange(option.value); setOpen(false); }} className={`flex w-full items-center justify-between px-3 py-2.5 text-left font-medium transition focus-visible:outline-2 focus-visible:outline-white ${option.value === value ? "bg-white text-[#4169e1]" : "text-white hover:bg-white/15"}`}>
        <span>{option.label}</span>{option.value === value && <span aria-hidden="true">✓</span>}
      </button>)}
    </div>}
  </div>;
}

function PendingRow({
  invitation,
  onChanged,
}: {
  invitation: PendingInvitation;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<"resend" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function resend() {
    setBusy("resend");
    setError(null);
    const response = await fetch(`/api/admin/invitations/${invitation.id}/resend`, {
      method: "POST",
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      setError(data.error ?? "Could not resend this invitation.");
      setBusy(null);
      return;
    }
    await onChanged();
  }

  async function deleteInvite() {
    if (!window.confirm(`Delete the invitation for ${invitation.email}? This cannot be undone.`)) {
      return;
    }
    setBusy("delete");
    setError(null);
    const response = await fetch(`/api/admin/invitations/${invitation.id}`, {
      method: "DELETE",
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      setError(data.error ?? "Could not delete this invitation.");
      setBusy(null);
      return;
    }
    await onChanged();
  }

  return (
    <div className="flex flex-col gap-1 border border-white/80 bg-black/10 p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p>{invitation.email}</p>
          <p className="text-white/60">
            {[invitation.displayName, invitation.role, invitation.deliveryStatus]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={resend}
            disabled={busy !== null}
            className="border border-white/80 px-3 py-1 text-white transition hover:bg-white/10 disabled:opacity-50"
          >
            {busy === "resend" ? "..." : "Resend"}
          </button>
          <button
            type="button"
            onClick={deleteInvite}
            disabled={busy !== null}
            className="border border-white/80 px-3 py-1 text-white transition hover:bg-white/10 disabled:opacity-50"
          >
            {busy === "delete" ? "..." : "Delete"}
          </button>
        </div>
      </div>
      {error && <p className="text-red-400">{error}</p>}
    </div>
  );
}
