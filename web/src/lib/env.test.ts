import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function loadEnv() {
  vi.resetModules();
  return (await import("./env")).env;
}

describe("env", () => {
  it("loads without the email settings", async () => {
    vi.stubEnv("RESEND_API_KEY", undefined);
    vi.stubEnv("RESEND_FROM_EMAIL", undefined);

    const env = await loadEnv();

    expect(env.RESEND_API_KEY).toBeUndefined();
    expect(env.RESEND_FROM_EMAIL).toBeUndefined();
  });

  it("treats blank email settings as unset", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("RESEND_FROM_EMAIL", "");

    const env = await loadEnv();

    expect(env.RESEND_API_KEY).toBeUndefined();
    expect(env.RESEND_FROM_EMAIL).toBeUndefined();
  });

  it("still requires the database settings", async () => {
    vi.stubEnv("DATABASE_URL", undefined);

    await expect(loadEnv()).rejects.toThrow("Invalid environment configuration");
  });
});
