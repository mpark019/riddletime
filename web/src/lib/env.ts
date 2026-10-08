import { z } from "zod";

// A blank value counts as unset, so an empty hosting-dashboard field does not break the build.
const optionalSetting = z.string().optional().transform((value) => value || undefined);

const envSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  APP_TIMEZONE: z.string().min(1).default("UTC"),
  SITE_URL: z.url(),
  RESEND_API_KEY: optionalSetting,
  RESEND_FROM_EMAIL: optionalSetting,
  // Test-only: lets fixtures write auth.users as the database owner.
  TEST_ADMIN_DATABASE_URL: z.string().min(1).optional(),
});

function loadEnv() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      `Invalid environment configuration:\n${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

export const env = loadEnv();
