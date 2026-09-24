import { beforeEach, describe, expect, it, vi } from "vitest";

const { announceLeaderboardChanged, createManualAdjustment, deletePointTransaction, submitChallenge } = vi.hoisted(() => ({
  announceLeaderboardChanged: vi.fn(),
  createManualAdjustment: vi.fn(),
  deletePointTransaction: vi.fn(),
  submitChallenge: vi.fn(),
}));

vi.mock("@/server/realtime/leaderboard", () => ({ announceLeaderboardChanged }));
vi.mock("@/server/points/points", () => ({
  createManualAdjustment,
  deletePointTransaction,
  manualAdjustmentInput: { parse: vi.fn((input) => input) },
}));
vi.mock("@/server/challenges/challenges", () => ({ submitChallenge }));

const { POST: createAdjustment } = await import("./admin/point-transactions/route");
const { DELETE: deleteAdjustment } = await import("./admin/point-transactions/[id]/route");
const { POST: submit } = await import("./challenge/[id]/submit/route");

const id = "9ebc4332-4cbe-4c1f-b11e-d1b2e4e2e8f0";

beforeEach(() => {
  announceLeaderboardChanged.mockReset();
  createManualAdjustment.mockReset();
  deletePointTransaction.mockReset();
  submitChallenge.mockReset();
});

describe("realtime notifications after durable point changes", () => {
  it("notifies after creating or deleting a manual adjustment", async () => {
    createManualAdjustment.mockResolvedValue({ entry: { id }, totalPoints: 5, created: true });
    deletePointTransaction.mockResolvedValue({ id });

    await createAdjustment(new Request("https://riddletime.test/api/admin/point-transactions", {
      method: "POST",
      body: JSON.stringify({ user_id: id, amount: 5, operation_key: "test-key" }),
      headers: { "Content-Type": "application/json" },
    }));
    await deleteAdjustment(new Request(`https://riddletime.test/api/admin/point-transactions/${id}`, { method: "DELETE" }), {
      params: Promise.resolve({ id }),
    });

    expect(announceLeaderboardChanged).toHaveBeenCalledTimes(2);
  });

  it("does not notify when an adjustment retry returns its existing ledger row", async () => {
    createManualAdjustment.mockResolvedValue({ entry: { id }, totalPoints: 5, created: false });

    await createAdjustment(new Request("https://riddletime.test/api/admin/point-transactions", {
      method: "POST",
      body: JSON.stringify({ user_id: id, amount: 5, operation_key: "test-key" }),
      headers: { "Content-Type": "application/json" },
    }));

    expect(announceLeaderboardChanged).not.toHaveBeenCalled();
  });

  it("notifies for a newly finalized riddle, but not an idempotent retry", async () => {
    submitChallenge.mockResolvedValueOnce({ finalized: true, alreadyFinalized: false })
      .mockResolvedValueOnce({ finalized: true, alreadyFinalized: true });
    const request = () => new Request(`https://riddletime.test/api/challenge/${id}/submit`, {
      method: "POST",
      body: JSON.stringify({ response: "piano" }),
      headers: { "Content-Type": "application/json" },
    });
    const context = { params: Promise.resolve({ id }) };

    await submit(request(), context);
    await submit(request(), context);

    expect(announceLeaderboardChanged).toHaveBeenCalledTimes(1);
  });
});
