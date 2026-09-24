import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { getUser, createServerClient } = vi.hoisted(() => ({
  getUser: vi.fn(),
  createServerClient: vi.fn(),
}));
vi.mock("@supabase/ssr", () => ({ createServerClient }));

const { proxy } = await import("../proxy");

beforeEach(() => {
  getUser.mockReset();
  createServerClient.mockReset();
  createServerClient.mockReturnValue({ auth: { getUser } });
});

function request(method: string, origin?: string) {
  return new NextRequest("https://riddletime.example/api/admin/point-transactions", {
    method,
    headers: origin ? { origin } : undefined,
  });
}

describe("proxy unsafe request origin enforcement", () => {
  it("allows a same-origin POST", async () => {
    const response = await proxy(request("POST", "https://riddletime.example"));
    expect(response.status).toBe(200);
    expect(getUser).toHaveBeenCalledOnce();
  });

  it.each([undefined, "https://attacker.example"])(
    "rejects an unsafe request from %s before session refresh",
    async (origin) => {
      const response = await proxy(request("DELETE", origin));
      expect(response.status).toBe(403);
      expect(getUser).not.toHaveBeenCalled();
    },
  );

  it("allows a safe request without an Origin header", async () => {
    const response = await proxy(request("GET"));
    expect(response.status).toBe(200);
    expect(getUser).toHaveBeenCalledOnce();
  });
});
