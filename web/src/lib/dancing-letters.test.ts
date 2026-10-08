import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHARACTER_SET } from "@/server/challenges/character-puzzle";
import { dancingLetterSrc } from "./dancing-letters";

describe("dancingLetterSrc", () => {
  it("returns the animated image for letters and digits, in either case", () => {
    expect(dancingLetterSrc("R")).toBe("/images/dancing-alphabet/dancing-r.gif");
    expect(dancingLetterSrc("t")).toBe("/images/dancing-alphabet/dancing-t.gif");
    expect(dancingLetterSrc("A")).toBe("/images/dancing-alphabet/dancing-a.gif");
    expect(dancingLetterSrc("7")).toBe("/images/dancing-alphabet/dancing-7.gif");
  });

  it("returns null for anything outside A-Z and 0-9", () => {
    expect(dancingLetterSrc("")).toBeNull();
    expect(dancingLetterSrc("?")).toBeNull();
    expect(dancingLetterSrc("AB")).toBeNull();
    expect(dancingLetterSrc("-")).toBeNull();
  });

  it("has an image in the public folder for every playable character", () => {
    for (const character of CHARACTER_SET) {
      const src = dancingLetterSrc(character);
      expect(src, character).not.toBeNull();
      expect(existsSync(path.join(process.cwd(), "public", src as string)), character).toBe(true);
    }
  });
});
