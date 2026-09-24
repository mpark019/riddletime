import { createBrowserClient } from "@supabase/ssr";

// Can't reuse env.ts: NEXT_PUBLIC_ vars must be literal process.env.X access for Next to inline them client-side.
let client: ReturnType<typeof createBrowserClient> | undefined;

// A module-level singleton, not one per call: multiple GoTrueClient instances race over the same storage.
export function createSupabaseBrowserClient() {
  if (!client) {
    client = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      // The invite-accept page parses the URL itself; automatic detection raced it and lost.
      { auth: { detectSessionInUrl: false } },
    );
  }
  return client;
}
