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
  const [displayName, setDisplayName] = useState("");
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

    const body: Record<string, unknown> = { email, role };
    if (displayName.trim()) body.displayName = displayName;
    if (role === "player") body.initialScore = Number(initialScore);

    const response = await fetch("/api/admin/invitations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      setFormError(data.error ?? "Could not send this invitation.");
      setSubmitting(false);
      return;
    }

    setEmail("");
    setDisplayName("");
    setSubmitting(false);
    await refreshPending();
  }

  return (
    <section className="flex w-full max-w-2xl flex-col gap-6">
      <div>
        <h2 className="text-2xl font-semibold">Invite someone</h2>
        <p className="mt-1 text-sm text-white/70">Choose their role and starting score before sending the invitation.</p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <label className="flex flex-col gap-1 text-sm">
            Email
            <input
              type="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="border border-white/80 bg-black/10 px-4 py-3 text-white focus:outline-2 focus:outline-white"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Display name {role === "player" ? "(required)" : "(optional)"}
            <input
              type="text"
              required={role === "player"}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              className="border border-white/80 bg-black/10 px-4 py-3 text-white focus:outline-2 focus:outline-white"
            />
          </label>
          <div className="flex flex-col gap-1 text-sm">
            <span className="font-semibold">Role</span>
            <RolePicker value={role} onChange={setRole} />
          </div>
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
            className="border border-white bg-white px-4 py-3 font-semibold text-[#4169e1] transition hover:bg-transparent hover:text-white disabled:opacity-50"
          >
            {submitting ? "Sending..." : "Send invite"}
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
    {open && <div role="listbox" aria-label="Invitation role" className="absolute z-10 mt-2 w-full border border-white bg-[#4169e1] p-1">
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
