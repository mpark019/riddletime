import { afterEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const { announceLeaderboardChanged } = await import("./leaderboard");

afterEach(() => {
  fetchMock.mockReset();
  vi.restoreAllMocks();
});

describe("announceLeaderboardChanged", () => {
  it("broadcasts only the fixed leaderboard event through the private server endpoint", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 202 }));
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(new AbortController().signal);

    await announceLeaderboardChanged();

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/realtime\/v1\/api\/broadcast\/riddletime%3Aleaderboard\/events\/leaderboard_changed\?private=true$/),
      expect.objectContaining({
        method: "POST",
        cache: "no-store",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          apikey: expect.any(String),
          Authorization: expect.stringMatching(/^Bearer /),
        }),
        body: "{}",
      }),
    );
    expect(timeout).toHaveBeenCalledWith(1_500);
  });

  it("keeps the completed mutation successful when Realtime is unavailable", async () => {
    fetchMock.mockRejectedValue(new Error("network unavailable"));

    await expect(announceLeaderboardChanged()).resolves.toBeUndefined();
  });
});
