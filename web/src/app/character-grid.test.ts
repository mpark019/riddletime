import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CharacterBoard, CharacterKeyboard } from "./character-grid";

describe("CharacterBoard", () => {
  it("renders one tile per character, with empty rows for unused tries (AC-9)", () => {
    const html = renderToStaticMarkup(createElement(CharacterBoard, {
      guesses: [{ response: "A1B", feedback: ["correct", "present", "absent"] }],
      length: 3,
      rows: 4,
    }));

    expect(html).toContain("A, correct position");
    expect(html).toContain("1, wrong position");
    expect(html).toContain("B, not in the answer");
    expect((html.match(/aria-label="empty"/g) ?? []).length).toBe(9);
  });

  it("recolors the letter itself and leaves the tile background plain", () => {
    const html = renderToStaticMarkup(createElement(CharacterBoard, {
      guesses: [{ response: "ABC", feedback: ["correct", "present", "absent"] }],
      length: 3,
      rows: 1,
    }));

    expect(html).toContain("filter:hue-rotate(120deg)");
    expect(html).toContain("filter:hue-rotate(67deg)");
    expect(html).toContain("filter:grayscale(1)");
    expect(html).not.toContain("bg-[#538d4e]");
    expect(html).not.toContain("bg-[#b59f3b]");
    expect(html).not.toContain("bg-[#3a3a3c]");
  });

  it("outlines every tile, using the result color on submitted tiles", () => {
    const html = renderToStaticMarkup(createElement(CharacterBoard, {
      guesses: [{ response: "ABC", feedback: ["correct", "present", "absent"] }],
      current: "D",
      length: 3,
      rows: 3,
    }));

    expect(html).toContain("border-[#4cb546]");
    expect(html).toContain("border-[#e0c22e]");
    expect(html).toContain("border-[#787c7e]");
    expect(html).toContain("border-[#878a8c]");
    expect(html).toContain("border-[#d3d6da]");
    expect(html).not.toContain("border-transparent");
  });

  it("leaves a typed, unsubmitted letter in its original color", () => {
    const html = renderToStaticMarkup(createElement(CharacterBoard, {
      guesses: [],
      current: "T",
      length: 2,
      rows: 1,
    }));

    expect(html).toContain("dancing-t.gif");
    expect(html).not.toContain("filter:");
  });

  it("uses theme-independent letter colors, since the page remaps text-white", () => {
    const html = renderToStaticMarkup(createElement(CharacterBoard, {
      guesses: [{ response: "AB", feedback: ["correct", "absent"] }],
      current: "C",
      length: 2,
      rows: 2,
    }));

    expect(html).not.toContain("text-white");
  });

  it("shows the dancing image for every letter and digit", () => {
    const html = renderToStaticMarkup(createElement(CharacterBoard, {
      guesses: [{ response: "RA7", feedback: ["correct", "absent", "present"] }],
      length: 3,
      rows: 1,
    }));

    expect(html).toContain("/images/dancing-alphabet/dancing-r.gif");
    expect(html).toContain("/images/dancing-alphabet/dancing-a.gif");
    expect(html).toContain("/images/dancing-alphabet/dancing-7.gif");
    expect(html).toContain('aria-label="R, correct position"');
    expect(html).toContain('aria-label="7, wrong position"');
  });

  it("shows typed letters as dancing images too", () => {
    const html = renderToStaticMarkup(createElement(CharacterBoard, {
      guesses: [],
      current: "T",
      length: 2,
      rows: 1,
    }));

    expect(html).toContain("/images/dancing-alphabet/dancing-t.gif");
  });

  it("shows typed characters in the first unused row", () => {
    const html = renderToStaticMarkup(createElement(CharacterBoard, {
      guesses: [{ response: "AB", feedback: ["absent", "absent"] }],
      current: "C",
      length: 2,
      rows: 3,
    }));

    expect(html).toContain('aria-label="C"');
    expect((html.match(/aria-label="empty"/g) ?? []).length).toBe(3);
  });

  it("treats a guess with no stored feedback as absent rather than failing", () => {
    const html = renderToStaticMarkup(createElement(CharacterBoard, {
      guesses: [{ response: "AB" }],
      length: 2,
    }));

    expect(html).toContain("A, not in the answer");
  });
});

describe("CharacterKeyboard", () => {
  const noop = () => undefined;

  it("renders only allowed characters and tints keys by best result", () => {
    const html = renderToStaticMarkup(createElement(CharacterKeyboard, {
      characterSet: "ABC1",
      guesses: [{ response: "AB", feedback: ["correct", "absent"] }],
      disabled: false,
      canSubmit: true,
      onCharacter: noop,
      onDelete: noop,
      onEnter: noop,
    }));

    expect(html).toContain('aria-label="A, correct position"');
    expect(html).toContain('aria-label="B, not in the answer"');
    expect(html).toContain('aria-label="C"');
    expect(html).not.toContain('aria-label="Z"');
    expect(html).toContain("Enter");
    expect(html).not.toContain("text-white");
  });

  it("disables Enter until the guess is complete", () => {
    const html = renderToStaticMarkup(createElement(CharacterKeyboard, {
      characterSet: "AB",
      guesses: [],
      disabled: false,
      canSubmit: false,
      onCharacter: noop,
      onDelete: noop,
      onEnter: noop,
    }));

    expect(html).toMatch(/<button[^>]*disabled[^>]*>Enter<\/button>/);
  });
});
