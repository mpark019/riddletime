"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FloatingQuestionMarks } from "./floating-question-marks";
import { PrimaryButton } from "./primary-button";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import type { PendingInvitation } from "@/server/invitations/invitations";

type Role = "spectator" | "player" | "admin";
type ProvisionableRole = Exclude<Role, "admin">;

const roleOptions: Array<{ value: ProvisionableRole; label: string }> = [
  { value: "spectator", label: "Spectator" },
  { value: "player", label: "Player" },
];

export function SignOutButton({ className, icon }: { className?: string; icon?: React.ReactNode }) {
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
      {icon}{submitting ? "Signing out..." : "Sign out"}
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
              className="rounded-md border border-white/80 bg-black/[0.04] px-4 py-3 text-white focus:outline-2 focus:outline-white"
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
              className="rounded-md border border-white/80 bg-black/[0.04] px-4 py-3 text-white focus:outline-2 focus:outline-white"
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
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="rounded-md border border-white/80 bg-black/[0.04] px-4 py-3 text-white focus:outline-2 focus:outline-white"
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
                className="number-field rounded-md border border-white/80 bg-black/[0.04] px-4 py-3 text-white focus:outline-2 focus:outline-white"
              />
            </label>
          )}
          {formError && <p className="rounded-md border border-white bg-black/[0.06] px-4 py-3 text-sm text-white">{formError}</p>}
          <PrimaryButton type="submit" disabled={submitting} markStart={12} className="px-4 py-3">
            {submitting ? "Creating..." : "Create member"}
          </PrimaryButton>
      </form>

      {/* <div className="flex flex-col gap-3 border-t border-white/50 pt-4">
        <h3 className="text-sm text-white">Pending invitations</h3>
        {listLoading && <p className="text-sm text-white">Loading...</p>}
        {!listLoading && pending.length === 0 && (
          <p className="text-sm text-white">None pending.</p>
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

function accountLabel(account?: ManagedAccount | null) {
  return account?.displayName ?? account?.name ?? "user";
}

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
  const [editing, setEditing] = useState<ManagedAccount | null>(null);
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState<{ text: string } | null>(null);
  const refresh = async (selectedRole = role) => { const response = await fetch(`/api/admin/players?role=${selectedRole}`); if (response.ok) setAccounts(await response.json()); else setError("Could not load users."); };
  useEffect(() => { const timer = window.setTimeout(() => { void fetch(`/api/admin/players?role=${role}`).then(async (response) => { if (response.ok) setAccounts(await response.json()); else setError("Could not load users."); }); }, 0); return () => window.clearTimeout(timer); }, [role]);
  async function save(id: string, displayName: string, password: string) {
    const response = await fetch(`/api/admin/players/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ displayName, ...(password ? { password } : {}) }) });
    if (!response.ok) { const body = await response.json().catch(() => ({})); setError(body.error ?? "Could not update user."); return false; }
    await refresh();
    return true;
  }
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  async function remove(id: string) {
    const deletedLabel = accountLabel(accounts.find((account) => account.id === id));
    const response = await fetch(`/api/admin/players/${id}`, { method: "DELETE" });
    if (!response.ok) { const body = await response.json().catch(() => ({})); setError(body.error ?? "Could not delete user."); return; }
    setPendingDelete(null);
    setNotice({ text: `Deleted ${deletedLabel}.` });
    await refresh();
  }
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleAccounts = accounts.filter((account) => !normalizedQuery || account.name?.toLocaleLowerCase().includes(normalizedQuery) || account.displayName?.toLocaleLowerCase().includes(normalizedQuery));
  const roleLabel = managedAccountTabs.find((tab) => tab.role === role)?.label ?? "";
  const nameColumn = role === "admin" ? "Display name" : "Username";
  const iconButton = "flex h-9 w-9 items-center justify-center rounded-md transition hover:bg-black/[0.06] focus-visible:outline-2 focus-visible:outline-white";

  return <section className="flex w-full flex-col gap-4">
    <h2 className="text-2xl font-semibold">Users</h2>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex gap-2" role="tablist" aria-label="User roles">{managedAccountTabs.map((tab) => <button key={tab.role} type="button" role="tab" aria-selected={role === tab.role} onClick={() => { setRole(tab.role); setError(null); setNotice(null); }} className={`rounded-md border border-white/80 px-3 py-2 text-sm font-semibold transition focus-visible:outline-2 focus-visible:outline-white ${role === tab.role ? "navy-surface relative isolate overflow-hidden" : "text-white hover:bg-white/15"}`}>{role === tab.role && <FloatingQuestionMarks contained compact start={8} />}{tab.label}</button>)}</div>
      <label className="flex h-11 w-full items-center rounded-md border border-white/25 bg-black/[0.04] px-3 focus-within:outline-2 focus-within:outline-white sm:max-w-xs"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="mr-2 h-4 w-4 shrink-0"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg><input type="search" aria-label={`Search ${roleLabel.toLowerCase()}`} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search ${roleLabel.toLowerCase()}`} className="min-w-0 flex-1 bg-transparent text-[15px] placeholder:text-white focus:outline-none" /></label>
    </div>
    <div aria-live="polite">{notice && <div className="flex items-center gap-3 rounded-md border-2 border-[#2fbf64] bg-[#c9f2d8] px-4 py-3 text-sm font-medium text-black"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 shrink-0"><path d="m5 12 5 5 9-10" /></svg><span className="min-w-0 flex-1">{notice.text}</span><button type="button" aria-label="Dismiss" onClick={() => setNotice(null)} className="flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-black/10">×</button></div>}</div>
    {error && !editing && <p role="alert" className="text-red-700">{error}</p>}
    {visibleAccounts.length === 0 ? <p className="rounded-md border border-white/25 bg-black/[0.04] px-4 py-10 text-center text-sm">{normalizedQuery ? `No ${roleLabel.toLowerCase()} match “${query.trim()}”.` : `No ${roleLabel.toLowerCase()} yet.`}</p> : <table className="w-full text-left">
      <thead><tr className="bg-black/[0.06] text-sm font-semibold"><th className="rounded-l-md px-4 py-3">Name</th><th className="px-4 py-3">{nameColumn}</th><th className="rounded-r-md px-4 py-3 text-right">Actions</th></tr></thead>
      <tbody>{visibleAccounts.map((account) => <tr key={account.id} className="border-b border-white/15 last:border-0">
        <td className="px-4 py-3 font-semibold">{account.name ?? "No name"}</td>
        <td className="px-4 py-3">{account.displayName ?? "—"}</td>
        <td className="px-2 py-2"><div className="flex justify-end gap-1">
          <button type="button" aria-label={`Edit ${account.displayName ?? account.name ?? "user"}`} title="Edit" onClick={() => { setError(null); setNotice(null); setEditing(account); }} className={iconButton}><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px]"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg></button>
          {account.id !== currentUserId && <button type="button" aria-label={`Delete ${account.displayName ?? account.name ?? "user"}`} title="Delete" onClick={() => setPendingDelete(account)} className={`${iconButton} text-[#c00000]`}><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px]"><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" /><path d="M10 11v6M14 11v6" /></svg></button>}
        </div></td>
      </tr>)}</tbody>
    </table>}
    {editing && <EditUserDialog account={editing} error={error} onCancel={() => { setEditing(null); setError(null); }} onSave={async (displayName, password) => { const saved = await save(editing.id, displayName, password); if (saved) { setEditing(null); setNotice({ text: `Saved ${displayName.trim() || accountLabel(editing)}${password ? " and updated the password" : ""}.` }); } return saved; }} />}
    {pendingDelete && <DeleteUserDialog account={pendingDelete} onCancel={() => setPendingDelete(null)} onConfirm={() => void remove(pendingDelete.id)} />}
  </section>;
}

function DeleteUserDialog({ account, onCancel, onConfirm }: { account: ManagedAccount; onCancel: () => void; onConfirm: () => void }) {
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4" role="presentation"><div role="alertdialog" aria-modal="true" aria-labelledby="delete-user-title" aria-describedby="delete-user-description" className="w-full max-w-md rounded-md border border-red-200/80 bg-surface-solid p-6 shadow-2xl"><p className="text-xs font-bold uppercase tracking-[0.2em] text-red-800">Permanent action</p><h3 id="delete-user-title" className="mt-2 text-2xl font-semibold">Delete {account.displayName ?? account.name ?? "this account"}?</h3><p id="delete-user-description" className="mt-3 text-white">This permanently removes the account and its owned data. It cannot be undone.</p><div className="mt-6 flex justify-end gap-3"><button type="button" onClick={onCancel} className="rounded-md border border-white/80 px-4 py-2 font-semibold hover:bg-white/10">Cancel</button><button type="button" onClick={onConfirm} className="rounded-md border border-[#c00000] bg-[#f00000] px-4 py-2 font-semibold text-on-fill transition hover:bg-[#d60000]">Delete permanently</button></div></div></div>;
}

function EditUserDialog({ account, error, onCancel, onSave }: { account: ManagedAccount; error: string | null; onCancel: () => void; onSave: (displayName: string, password: string) => Promise<boolean> }) {
  const [displayName, setDisplayName] = useState(account.displayName ?? "");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const fieldLabel = account.role === "admin" ? "Display name" : "Username";

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    await onSave(displayName, password);
    setBusy(false);
  }

  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4" role="presentation"><form onSubmit={(event) => void submit(event)} role="dialog" aria-modal="true" aria-labelledby="edit-user-title" className="flex w-full max-w-md flex-col gap-4 rounded-md border border-white bg-surface-solid p-6 shadow-2xl">
    <h3 id="edit-user-title" className="text-xl font-semibold">Edit {account.name ?? account.displayName ?? "user"}</h3>
    <label className="flex flex-col gap-1 text-sm font-medium"><span>{fieldLabel}</span><input autoFocus value={displayName} onChange={(e) => setDisplayName(e.target.value)} className="h-11 w-full rounded-md border border-white/25 bg-black/[0.04] px-3 focus:outline-2 focus:outline-white" /></label>
    <label className="flex flex-col gap-1 text-sm font-medium"><span>New password</span><input type="password" placeholder="Leave blank to keep the current one" value={password} onChange={(e) => setPassword(e.target.value)} className="h-11 w-full rounded-md border border-white/25 bg-black/[0.04] px-3 focus:outline-2 focus:outline-white" /></label>
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    <div className="mt-2 flex justify-end gap-3"><button type="button" onClick={onCancel} className="h-11 rounded-md border border-white/80 px-4 font-semibold hover:bg-white/10">Cancel</button><PrimaryButton type="submit" disabled={busy} markStart={14} className="h-11 px-4">{busy ? "Saving..." : "Save"}</PrimaryButton></div>
  </form></div>;
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
    <button type="button" onClick={() => setOpen((current) => !current)} aria-expanded={open} aria-haspopup="listbox" className="flex w-full items-center justify-between rounded-md border border-white/80 bg-black/[0.04] px-4 py-3 text-left font-medium text-white transition hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-white">
      <span>{selected.label}</span><span aria-hidden="true">⌄</span>
    </button>
    {open && <div role="listbox" aria-label="Member role" className="absolute z-10 mt-2 w-full rounded-md border border-white bg-surface-solid p-1">
      {roleOptions.map((option) => <button key={option.value} type="button" role="option" aria-selected={option.value === value} onClick={() => { onChange(option.value); setOpen(false); }} className={`flex w-full items-center justify-between px-3 py-2.5 text-left font-medium transition focus-visible:outline-2 focus-visible:outline-white ${option.value === value ? "navy-surface relative isolate overflow-hidden" : "text-white hover:bg-white/15"}`}>{option.value === value && <FloatingQuestionMarks contained compact start={10} />}
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
    <div className="flex flex-col gap-1 rounded-md border border-white/80 bg-black/[0.04] p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p>{invitation.email}</p>
          <p className="text-white">
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
            className="rounded-md border border-white/80 px-3 py-1 text-white transition hover:bg-white/10 disabled:opacity-50"
          >
            {busy === "resend" ? "..." : "Resend"}
          </button>
          <button
            type="button"
            onClick={deleteInvite}
            disabled={busy !== null}
            className="rounded-md border border-white/80 px-3 py-1 text-white transition hover:bg-white/10 disabled:opacity-50"
          >
            {busy === "delete" ? "..." : "Delete"}
          </button>
        </div>
      </div>
      {error && <p className="text-red-700">{error}</p>}
    </div>
  );
}
