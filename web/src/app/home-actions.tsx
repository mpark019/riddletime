"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import type { PendingInvitation } from "@/server/invitations/invitations";

type Role = "spectator" | "player" | "admin";

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
              className="rounded border border-white/20 bg-black px-3 py-2 text-white"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Display name {role === "player" ? "(required)" : "(optional)"}
            <input
              type="text"
              required={role === "player"}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              className="rounded border border-white/20 bg-black px-3 py-2 text-white"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Role
            <select
              value={role}
              onChange={(event) => setRole(event.target.value as Role)}
              className="rounded border border-white/20 bg-black px-3 py-2 text-white"
            >
              <option value="spectator">Spectator</option>
              <option value="player">Player</option>
              <option value="admin">Admin</option>
            </select>
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
                className="rounded border border-white/20 bg-black px-3 py-2 text-white"
              />
            </label>
          )}
          {formError && <p className="text-sm text-red-400">{formError}</p>}
          <button
            type="submit"
            disabled={submitting}
            className="rounded bg-white px-4 py-2 text-black disabled:opacity-50"
          >
            {submitting ? "Sending..." : "Send invite"}
          </button>
      </form>

      <div className="flex flex-col gap-3 border-t border-white/20 pt-4">
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
    <div className="flex flex-col gap-1 rounded border border-white/10 p-3 text-sm">
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
            className="rounded border border-white/40 px-3 py-1 text-white disabled:opacity-50"
          >
            {busy === "resend" ? "..." : "Resend"}
          </button>
          <button
            type="button"
            onClick={deleteInvite}
            disabled={busy !== null}
            className="rounded border border-red-400/60 px-3 py-1 text-red-400 disabled:opacity-50"
          >
            {busy === "delete" ? "..." : "Delete"}
          </button>
        </div>
      </div>
      {error && <p className="text-red-400">{error}</p>}
    </div>
  );
}
