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

  it("accepts a name-only edit and treats a blank name as clearing it", () => {
    expect(updatePlayerAccountInput.parse({ name: "  Brooklyn  " })).toEqual({ name: "Brooklyn" });
    expect(updatePlayerAccountInput.parse({ name: "   " })).toEqual({ name: null });
  });

  it("rejects a name longer than 100 characters and an empty edit", () => {
    expect(() => updatePlayerAccountInput.parse({ name: "x".repeat(101) })).toThrow();
    expect(() => updatePlayerAccountInput.parse({})).toThrow();
  });
});
