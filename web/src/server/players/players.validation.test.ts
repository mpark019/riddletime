import { describe, expect, it } from "vitest";
import { createPlayerAccountInput, updatePlayerAccountInput } from "./players";

describe("member-account password validation", () => {
  it("accepts nonempty passwords of any length for provisioning and resets", () => {
    expect(() => createPlayerAccountInput.parse({
      displayName: "player_one",
      password: "a",
      role: "player",
      initialScore: 0,
    })).not.toThrow();
    expect(() => updatePlayerAccountInput.parse({ password: "a" })).not.toThrow();
  });

  it("rejects empty passwords", () => {
    expect(() => createPlayerAccountInput.parse({
      displayName: "player_one",
      password: "",
      role: "player",
      initialScore: 0,
    })).toThrow("Password is required.");
    expect(() => updatePlayerAccountInput.parse({ password: "" })).toThrow("Password is required.");
  });
});
