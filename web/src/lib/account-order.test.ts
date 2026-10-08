import { describe, expect, it } from "vitest";
import { compareByName } from "./account-order";

const sort = (accounts: { name: string | null; displayName: string | null }[]) => [...accounts].sort(compareByName);

describe("compareByName", () => {
  it("orders by name ignoring case", () => {
    const names = sort([
      { name: "tim", displayName: "KS11" },
      { name: "Adam", displayName: "KS6" },
      { name: "Brooklyn", displayName: "KS10" },
    ]).map((account) => account.name);

    expect(names).toEqual(["Adam", "Brooklyn", "tim"]);
  });

  it("puts accounts without a name last, ordered by username", () => {
    const usernames = sort([
      { name: null, displayName: "zed" },
      { name: "Adam", displayName: "KS6" },
      { name: null, displayName: "test" },
    ]).map((account) => account.displayName);

    expect(usernames).toEqual(["KS6", "test", "zed"]);
  });

  it("breaks name ties by username", () => {
    const usernames = sort([
      { name: "Sam", displayName: "KS9" },
      { name: "Sam", displayName: "KS2" },
    ]).map((account) => account.displayName);

    expect(usernames).toEqual(["KS2", "KS9"]);
  });
});
