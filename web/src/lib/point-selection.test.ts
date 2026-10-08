import { describe, expect, it } from "vitest";
import { pruneSelection } from "./point-selection";

const players = [{ userId: "a" }, { userId: "b" }, { userId: "c" }];

describe("pruneSelection", () => {
  it("keeps only ids that are still players, in selection order", () => {
    expect(pruneSelection(["c", "gone", "a"], players)).toEqual(["c", "a"]);
  });

  it("returns the same array when nothing is stale", () => {
    const selected = ["a", "b"];
    expect(pruneSelection(selected, players)).toBe(selected);
  });
});
