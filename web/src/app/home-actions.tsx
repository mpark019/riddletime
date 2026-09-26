"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import type { PendingInvitation } from "@/server/invitations/invitations";

type Role = "spectator" | "player" | "admin";
type ProvisionableRole = Exclude<Role, "admin">;

const roleOptions: Array<{ value: ProvisionableRole; label: string }> = [
  { value: "spectator", label: "Spectator" },
  { value: "player", label: "Player" },
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
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<ProvisionableRole>("player");
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

    const body: Record<string, unknown> = {
      displayName,
      password,
      role,
      ...(name.trim() ? { name } : {}),
      ...(role === "player" ? { initialScore: Number(initialScore) } : {}),
    };

    const response = await fetch("/api/admin/players", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      setFormError(data.error ?? "Could not create this member.");
      setSubmitting(false);
      return;
    }

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
          <label className="flex flex-col gap-1 text-sm">
            Name (optional)
            <input
              type="text"
              autoComplete="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="border border-white/80 bg-black/10 px-4 py-3 text-white focus:outline-2 focus:outline-white"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Username
            <input
              type="text"
              required
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              pattern="[A-Za-z0-9][A-Za-z0-9_-]{2,31}"
              title="Use 3–32 letters, numbers, underscores, or hyphens."
              className="border border-white/80 bg-black/10 px-4 py-3 text-white focus:outline-2 focus:outline-white"
            />
          </label>
          <div className="flex flex-col gap-1 text-sm">
            <span className="font-semibold">Role</span>
            <RolePicker value={role} onChange={setRole} />
          </div>
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
          {role === "player" && (
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
          )}
          {formError && <p className="border border-white bg-black/15 px-4 py-3 text-sm text-white">{formError}</p>}
          <button
            type="submit"
            disabled={submitting}
            className="border border-white bg-white px-4 py-3 font-semibold text-[#102a43] transition hover:bg-transparent hover:text-white disabled:opacity-50"
          >
            {submitting ? "Creating..." : "Create member"}
          </button>
      </form>

      {/* <div className="flex flex-col gap-3 border-t border-white/50 pt-4">
        <h3 className="text-sm text-white/60">Pending invitations</h3>
        {listLoading && <p className="text-sm text-white/60">Loading...</p>}
        {!listLoading && pending.length === 0 && (
          <p className="text-sm text-white/60">None pending.</p>
        )}
        {pending.map((invitation) => (
          <PendingRow key={invitation.id} invitation={invitation} onChanged={refreshPending} />
        ))}
      </div> */}
    </section>
  );
}

type ManagedAccountRole = "spectator" | "player" | "admin";
type ManagedAccount = { id: string; name: string | null; displayName: string | null; role: ManagedAccountRole };

const managedAccountTabs: Array<{ role: ManagedAccountRole; label: string }> = [
  { role: "player", label: "Players" },
  { role: "spectator", label: "Spectators" },
  { role: "admin", label: "Admins" },
];

export function UserAccountsPanel({ currentUserId }: { currentUserId: string }) {
  const [role, setRole] = useState<ManagedAccountRole>("player");
  const [accounts, setAccounts] = useState<ManagedAccount[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ManagedAccount | null>(null);
  const refresh = async (selectedRole = role) => { const response = await fetch(`/api/admin/players?role=${selectedRole}`); if (response.ok) setAccounts(await response.json()); else setError("Could not load users."); };
  useEffect(() => { const timer = window.setTimeout(() => { void fetch(`/api/admin/players?role=${role}`).then(async (response) => { if (response.ok) setAccounts(await response.json()); else setError("Could not load users."); }); }, 0); return () => window.clearTimeout(timer); }, [role]);
  async function save(id: string, displayName: string, password: string) {
    const response = await fetch(`/api/admin/players/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ displayName, ...(password ? { password } : {}) }) });
    if (!response.ok) { const body = await response.json().catch(() => ({})); setError(body.error ?? "Could not update user."); return false; }
    await refresh();
    return true;
  }
  async function remove(id: string) {
    const response = await fetch(`/api/admin/players/${id}`, { method: "DELETE" });
    if (!response.ok) { const body = await response.json().catch(() => ({})); setError(body.error ?? "Could not delete user."); return; }
    setPendingDelete(null);
    await refresh();
  }
  return <section className="flex w-full max-w-2xl flex-col gap-4"><div><h2 className="text-2xl font-semibold">Users</h2></div><div className="flex gap-2" role="tablist" aria-label="User roles">{managedAccountTabs.map((tab) => <button key={tab.role} type="button" role="tab" aria-selected={role === tab.role} onClick={() => { setRole(tab.role); setError(null); }} className={`border border-white/80 px-3 py-2 text-sm font-semibold transition focus-visible:outline-2 focus-visible:outline-white ${role === tab.role ? "bg-white text-[#102a43]" : "text-white hover:bg-white/15"}`}>{tab.label}</button>)}</div>{accounts.map((account) => <UserRow key={account.id} account={account} onSave={save} onDelete={setPendingDelete} canDelete={account.id !== currentUserId} />)}{accounts.length === 0 && <p className="text-sm text-white/60">No {managedAccountTabs.find((tab) => tab.role === role)?.label.toLowerCase()} yet.</p>}{error && <p role="alert" className="text-red-300">{error}</p>}{pendingDelete && <DeleteUserDialog account={pendingDelete} onCancel={() => setPendingDelete(null)} onConfirm={() => void remove(pendingDelete.id)} />}</section>;
}

function DeleteUserDialog({ account, onCancel, onConfirm }: { account: ManagedAccount; onCancel: () => void; onConfirm: () => void }) {
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4" role="presentation"><div role="alertdialog" aria-modal="true" aria-labelledby="delete-user-title" aria-describedby="delete-user-description" className="w-full max-w-md border border-red-200/80 bg-[#102a43] p-6 shadow-2xl"><p className="text-xs font-bold uppercase tracking-[0.2em] text-red-100">Permanent action</p><h3 id="delete-user-title" className="mt-2 text-2xl font-semibold">Delete {account.displayName ?? account.name ?? "this account"}?</h3><p id="delete-user-description" className="mt-3 text-white/80">This permanently removes the account and its owned data. It cannot be undone.</p><div className="mt-6 flex justify-end gap-3"><button type="button" onClick={onCancel} className="border border-white/80 px-4 py-2 font-semibold hover:bg-white/10">Cancel</button><button type="button" onClick={onConfirm} className="border border-red-200 bg-red-200 px-4 py-2 font-semibold text-[#102a43] transition hover:bg-transparent hover:text-white">Delete permanently</button></div></div></div>;
}

function UserRow({ account, onSave, onDelete, canDelete }: { account: ManagedAccount; onSave: (id: string, displayName: string, password: string) => Promise<boolean>; onDelete: (account: ManagedAccount) => void; canDelete: boolean }) {
  const [displayName, setDisplayName] = useState(account.displayName ?? ""); const [password, setPassword] = useState(""); const [passwordSaved, setPasswordSaved] = useState(false);
  async function savePlayer() {
    const passwordWasProvided = Boolean(password);
    const saved = await onSave(account.id, displayName, password);
    if (saved && passwordWasProvided) {
      setPassword("");
      setPasswordSaved(true);
    }
  }
  return <div className="flex flex-col gap-3 border border-white/80 p-3"><p className="text-sm text-white/60">{account.name ?? "No name"}</p><label className="flex flex-col gap-1 text-sm"><span>{account.role === "admin" ? "Display name" : "Username"}</span><input aria-label={`${account.role === "admin" ? "Display name" : "Username"} for ${account.displayName ?? account.name ?? "user"}`} value={displayName} onChange={(e) => setDisplayName(e.target.value)} className="border border-white/80 bg-black/10 px-3 py-2" /></label><input aria-label={`New password for ${account.displayName ?? account.name ?? "user"}`} type="password" minLength={12} placeholder="New password (optional)" value={password} onChange={(e) => { setPassword(e.target.value); setPasswordSaved(false); }} className="border border-white/80 bg-black/10 px-3 py-2" />{passwordSaved && <p aria-live="polite" className="text-sm font-medium text-white/80">Password saved successfully.</p>}<div className="flex gap-2"><button type="button" onClick={() => void savePlayer()} className="border border-white bg-white px-3 py-2 font-semibold text-[#102a43] transition hover:bg-transparent hover:text-white focus-visible:outline-2 focus-visible:outline-white">Save</button>{canDelete ? <button type="button" onClick={() => onDelete(account)} className="border border-red-300 bg-red-200 px-3 py-2 font-semibold text-[#102a43] transition hover:bg-transparent hover:text-white focus-visible:outline-2 focus-visible:outline-white">Delete account</button> : <p className="self-center text-sm text-white/60">You cannot delete your own account.</p>}</div></div>;
}

function RolePicker({ value, onChange }: { value: ProvisionableRole; onChange: (role: ProvisionableRole) => void }) {
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
    {open && <div role="listbox" aria-label="Member role" className="absolute z-10 mt-2 w-full border border-white bg-[#102a43] p-1">
      {roleOptions.map((option) => <button key={option.value} type="button" role="option" aria-selected={option.value === value} onClick={() => { onChange(option.value); setOpen(false); }} className={`flex w-full items-center justify-between px-3 py-2.5 text-left font-medium transition focus-visible:outline-2 focus-visible:outline-white ${option.value === value ? "bg-white text-[#102a43]" : "text-white hover:bg-white/15"}`}>
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
