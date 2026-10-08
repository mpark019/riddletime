import { describe, expect, it } from "vitest";
import { manualAdjustmentInput } from "@/server/points/points";
import { createPlayerAccountInput } from "@/server/players/players";
import { acceptInvitationInput, createInvitationInput } from "@/server/invitations/invitations";

const long = (length: number) => "x".repeat(length);

describe("input size limits", () => {
  it("rejects oversized point adjustment text", () => {
    const base = { userId: crypto.randomUUID(), amount: 1, reason: "ok", operationKey: "k" };
    expect(manualAdjustmentInput.safeParse(base).success).toBe(true);
    expect(manualAdjustmentInput.safeParse({ ...base, reason: long(501) }).success).toBe(false);
    expect(manualAdjustmentInput.safeParse({ ...base, operationKey: long(201) }).success).toBe(false);
  });

  it("rejects oversized names", () => {
    expect(createPlayerAccountInput.safeParse({ displayName: long(101), password: "pw" }).success).toBe(false);
    expect(acceptInvitationInput.safeParse({ name: long(101) }).success).toBe(false);
    expect(
      createInvitationInput.safeParse({ email: "a@b.co", displayName: long(101), role: "spectator" }).success,
    ).toBe(false);
  });
});
