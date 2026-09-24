"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

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
        Email
        <input
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className="rounded border border-white bg-white px-4 py-3 text-slate-950 placeholder:text-slate-500 focus:outline-2 focus:outline-offset-2 focus:outline-white"
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
          className="rounded border border-white bg-white px-4 py-3 text-slate-950 placeholder:text-slate-500 focus:outline-2 focus:outline-offset-2 focus:outline-white"
        />
      </label>
      {error && <p className="text-sm text-red-400">{error}</p>}
      <button
        type="submit"
        disabled={submitting}
        className="rounded bg-white px-4 py-3 text-black disabled:opacity-50"
      >
        {submitting ? "Signing in..." : "Continue"}
      </button>
    </form>
  );
}
