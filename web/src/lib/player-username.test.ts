import { describe, expect, it } from "vitest";
import { playerUsernameEmail, parsePlayerUsername } from "./player-username";

describe("player usernames", () => {
  it("normalizes a display name and derives a reserved Auth identity", () => {
    expect(parsePlayerUsername("  Riddle_One  ")).toBe("riddle_one");
    expect(playerUsernameEmail("Riddle_One")).toBe("riddle_one@players.riddletime.invalid");
  });

  it("rejects names that cannot safely be used as login identifiers", () => {
    expect(() => parsePlayerUsername("two words")).toThrow();
    expect(() => parsePlayerUsername("email@example.com")).toThrow();
  });
});
