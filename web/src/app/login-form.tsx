"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { playerUsernameEmail } from "@/lib/player-username";

export function LoginForm() {
  const router = useRouter();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    let email = identifier.trim();
    if (!email.includes("@")) {
      try {
        email = playerUsernameEmail(email);
      } catch {
        setError("Enter a valid email address or player username.");
        setSubmitting(false);
        return;
      }
    }

    const supabase = createSupabaseBrowserClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (signInError) {
      setError(signInError.message);
      setSubmitting(false);
      return;
    }

    router.push("/");
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="flex w-full max-w-xl flex-col gap-5">
      <label className="flex flex-col gap-2 text-lg">
        Username
        <input
          type="text"
          required
          autoComplete="username"
          value={identifier}
          onChange={(event) => setIdentifier(event.target.value)}
          className="border border-white/80 bg-black/10 px-4 py-3 text-white placeholder:text-white/50 focus:outline-2 focus:outline-white"
        />
      </label>
      <label className="flex flex-col gap-2 text-lg">
        Password
        <input
          type="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="border border-white/80 bg-black/10 px-4 py-3 text-white placeholder:text-white/50 focus:outline-2 focus:outline-white"
        />
      </label>
      {error && <p className="border border-white bg-black/15 px-4 py-3 text-sm text-white">{error}</p>}
      <button
        type="submit"
        disabled={submitting}
        className="border border-white bg-white px-4 py-3 font-semibold text-[#4169e1] transition hover:bg-transparent hover:text-white disabled:opacity-50"
      >
        {submitting ? "Signing in..." : "Continue"}
      </button>
    </form>
  );
}
