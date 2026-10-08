import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTrailingCoalescer } from "./coalesce";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("createTrailingCoalescer", () => {
  it("runs once after a burst of calls settles", () => {
    const run = vi.fn();
    const coalesced = createTrailingCoalescer(run, 250);

    coalesced.call();
    vi.advanceTimersByTime(100);
    coalesced.call();
    vi.advanceTimersByTime(249);
    expect(run).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("runs again for a later burst", () => {
    const run = vi.fn();
    const coalesced = createTrailingCoalescer(run, 250);

    coalesced.call();
    vi.advanceTimersByTime(250);
    coalesced.call();
    vi.advanceTimersByTime(250);

    expect(run).toHaveBeenCalledTimes(2);
  });

  it("drops a pending run when cancelled", () => {
    const run = vi.fn();
    const coalesced = createTrailingCoalescer(run, 250);

    coalesced.call();
    coalesced.cancel();
    vi.advanceTimersByTime(500);

    expect(run).not.toHaveBeenCalled();
  });
});
