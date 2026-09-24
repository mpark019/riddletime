"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

type Status = "waiting" | "ready" | "no-session" | "submitting";

function AcceptForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const invitationId = searchParams.get("invitationId");
  const [status, setStatus] = useState<Status>("waiting");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [supabase] = useState(() => createSupabaseBrowserClient());

  useEffect(() => {
    if (!invitationId) return;

    let cancelled = false;

    async function establishSession() {
      const { data: existing } = await supabase.auth.getSession();
      if (existing.session) {
        if (!cancelled) setStatus("ready");
        return;
      }

      // Parsed manually rather than via detectSessionInUrl, which proved unreliable for this one-time hash.
      const rawHash = window.location.hash;
      const hash = rawHash.startsWith("#") ? rawHash.slice(1) : rawHash;
      if (hash) {
        const hashParams = new URLSearchParams(hash);
        const accessToken = hashParams.get("access_token");
        const refreshToken = hashParams.get("refresh_token");
        if (accessToken && refreshToken) {
          const { error: sessionError } = await supabase.auth.setSession({
            access_token: accessToken,
            refresh_token: refreshToken,
          });
          window.history.replaceState(null, "", window.location.pathname + window.location.search);
          if (!sessionError) {
            if (!cancelled) setStatus("ready");
            return;
          }
        }
      }

      // Legacy link format: tokens arrive as token_hash+type query params instead of a URL hash.
      const tokenHash = searchParams.get("token_hash");
      const otpType = searchParams.get("type");
      if (tokenHash && otpType) {
        const { error: verifyError } = await supabase.auth.verifyOtp({
          token_hash: tokenHash,
          type: otpType,
        });
        if (!verifyError) {
          if (!cancelled) setStatus("ready");
          return;
        }
      }

      if (!cancelled) setStatus("no-session");
    }

    establishSession();

    return () => {
      cancelled = true;
    };
  }, [invitationId, searchParams, supabase]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setStatus("submitting");
    setError(null);

    const { error: passwordError } = await supabase.auth.updateUser({ password });
    if (passwordError) {
      setError(passwordError.message);
      setStatus("ready");
      return;
    }

    const response = await fetch(`/api/invitations/${invitationId}/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(name.trim() ? { name } : {}),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "Could not accept this invitation.");
      setStatus("ready");
      return;
    }

    router.push("/");
    router.refresh();
  }

  if (!invitationId || status === "no-session") {
    return (
      <p className="text-sm text-red-400">
        This invite link is invalid or has expired. Ask an admin to resend it.
      </p>
    );
  }

  if (status === "waiting") {
    return <p>Verifying your invite...</p>;
  }

  return (
    <form onSubmit={handleSubmit} className="flex w-full max-w-sm flex-col gap-4 p-8">
      <h1 className="text-xl font-normal">Set your password</h1>
      <label className="flex flex-col gap-1">
        Name <span className="text-sm text-white/60">(optional)</span>
        <input
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="rounded border border-white/20 bg-black px-3 py-2 text-white"
        />
      </label>
      <label className="flex flex-col gap-1">
        Password
        <input
          type="password"
          required
          minLength={8}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="rounded border border-white/20 bg-black px-3 py-2 text-white"
        />
      </label>
      {error && <p className="text-sm text-red-400">{error}</p>}
      <button
        type="submit"
        disabled={status === "submitting"}
        className="rounded bg-white px-4 py-2 text-black disabled:opacity-50"
      >
        {status === "submitting" ? "Saving..." : "Accept invitation"}
      </button>
    </form>
  );
}

export default function AcceptInvitePage() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <Suspense fallback={<p>Loading...</p>}>
        <AcceptForm />
      </Suspense>
    </div>
  );
}
