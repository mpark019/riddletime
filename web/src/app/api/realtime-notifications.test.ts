import { beforeEach, describe, expect, it, vi } from "vitest";

const { announceLeaderboardChanged, deleteSchedule, createManualAdjustment, createManualAdjustmentForAllPlayers, createManualAdjustmentForPlayers, deletePointTransaction, finalizeOverdueSessions, getChallengeSession, loadTodayChallenge, submitChallenge } = vi.hoisted(() => ({
  announceLeaderboardChanged: vi.fn(),
  deleteSchedule: vi.fn(),
  finalizeOverdueSessions: vi.fn(),
  getChallengeSession: vi.fn(),
  loadTodayChallenge: vi.fn(),
  createManualAdjustment: vi.fn(),
  createManualAdjustmentForAllPlayers: vi.fn(),
  createManualAdjustmentForPlayers: vi.fn(),
  deletePointTransaction: vi.fn(),
  submitChallenge: vi.fn(),
}));

const afterCallbacks: Array<() => unknown> = vi.hoisted(() => []);
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (callback: () => unknown) => { afterCallbacks.push(callback); },
}));
const runAfterCallbacks = async () => { for (const callback of afterCallbacks.splice(0)) await callback(); };

vi.mock("@/server/realtime/leaderboard", () => ({ announceLeaderboardChanged }));
vi.mock("@/server/points/points", () => ({
  createManualAdjustment,
  createManualAdjustmentForAllPlayers,
  createManualAdjustmentForPlayers,
  deletePointTransaction,
  manualAdjustmentInput: { parse: vi.fn((input) => input) },
}));
vi.mock("@/server/schedules/schedules", () => ({ deleteSchedule, getScheduleDetail: vi.fn() }));
vi.mock("@/server/challenges/challenges", () => ({
  finalizeOverdueSessions,
  getChallengeSession,
  loadTodayChallenge,
  submitChallenge,
}));

const { POST: createAdjustment } = await import("./admin/point-transactions/route");
const { DELETE: deleteAdjustment } = await import("./admin/point-transactions/[id]/route");
const { POST: submit } = await import("./challenge/[id]/submit/route");
const { GET: loadToday } = await import("./challenge/today/route");
const { DELETE: deleteRiddle } = await import("./admin/challenges/[id]/route");
const { GET: loadSession } = await import("./challenge/[id]/route");

const id = "9ebc4332-4cbe-4c1f-b11e-d1b2e4e2e8f0";

beforeEach(() => {
  announceLeaderboardChanged.mockReset();
  createManualAdjustment.mockReset();
  createManualAdjustmentForAllPlayers.mockReset();
  createManualAdjustmentForPlayers.mockReset();
  deletePointTransaction.mockReset();
  submitChallenge.mockReset();
  finalizeOverdueSessions.mockReset();
  deleteSchedule.mockReset();
  loadTodayChallenge.mockReset();
  getChallengeSession.mockReset();
});

describe("realtime notifications after durable point changes", () => {
  it("notifies after creating or deleting a manual adjustment", async () => {
    createManualAdjustment.mockResolvedValue({ entry: { id }, totalPoints: 5, created: true });
    deletePointTransaction.mockResolvedValue({ id });

    await createAdjustment(new Request("https://riddletime.test/api/admin/point-transactions", {
      method: "POST",
      body: JSON.stringify({ user_id: id, amount: 5, reason: "Test reason", operation_key: "test-key" }),
      headers: { "Content-Type": "application/json" },
    }));
    await deleteAdjustment(new Request(`https://riddletime.test/api/admin/point-transactions/${id}`, { method: "DELETE" }), {
      params: Promise.resolve({ id }),
    });

    expect(announceLeaderboardChanged).not.toHaveBeenCalled();
    await runAfterCallbacks();
    expect(announceLeaderboardChanged).toHaveBeenCalledTimes(2);
  });

  it("does not notify when an adjustment retry returns its existing ledger row", async () => {
    createManualAdjustment.mockResolvedValue({ entry: { id }, totalPoints: 5, created: false });

    await createAdjustment(new Request("https://riddletime.test/api/admin/point-transactions", {
      method: "POST",
      body: JSON.stringify({ user_id: id, amount: 5, reason: "Test reason", operation_key: "test-key" }),
      headers: { "Content-Type": "application/json" },
    }));
    await runAfterCallbacks();

    expect(announceLeaderboardChanged).not.toHaveBeenCalled();
  });

  it("notifies for a newly finalized riddle, but not an idempotent retry", async () => {
    const operationKey = "88fd76a3-a596-4b3c-9a42-bfcf0eb194c3";
    submitChallenge.mockResolvedValueOnce({ finalized: true, alreadyFinalized: false })
      .mockResolvedValueOnce({ finalized: true, alreadyFinalized: true });
    const request = () => new Request(`https://riddletime.test/api/challenge/${id}/submit`, {
      method: "POST",
      body: JSON.stringify({ response: "piano", operationKey }),
      headers: { "Content-Type": "application/json" },
    });
    const context = { params: Promise.resolve({ id }) };

    await submit(request(), context);
    await submit(request(), context);

    expect(announceLeaderboardChanged).toHaveBeenCalledTimes(1);
    expect(submitChallenge).toHaveBeenCalledWith(id, "piano", operationKey);
  });

  it("accepts an answerless expiry-finalization request", async () => {
    submitChallenge.mockResolvedValue({ finalized: true, alreadyFinalized: false });
    const request = new Request(`https://riddletime.test/api/challenge/${id}/submit`, {
      method: "POST",
      body: JSON.stringify({ finalizeExpired: true }),
      headers: { "Content-Type": "application/json" },
    });

    const response = await submit(request, { params: Promise.resolve({ id }) });

    expect(response.status).toBe(200);
    expect(submitChallenge).toHaveBeenCalledWith(id, null);
  });

  it("notifies when loading today's riddle or a session finalized overdue games", async () => {
    loadTodayChallenge.mockResolvedValue({ result: { schedule: null }, finalized: 1 });
    finalizeOverdueSessions.mockResolvedValueOnce(2);
    getChallengeSession.mockResolvedValue({ schedule: null });

    await loadToday();
    await loadSession(new Request(`https://riddletime.test/api/challenge/${id}`), {
      params: Promise.resolve({ id }),
    });

    expect(announceLeaderboardChanged).toHaveBeenCalledTimes(2);
    expect(finalizeOverdueSessions).toHaveBeenCalledTimes(1);
    expect(finalizeOverdueSessions.mock.invocationCallOrder[0])
      .toBeLessThan(getChallengeSession.mock.invocationCallOrder[0]);
  });

  it("does not notify on load when no overdue game was finalized (AC-3)", async () => {
    loadTodayChallenge.mockResolvedValue({ result: { schedule: null }, finalized: 0 });

    const response = await loadToday();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ schedule: null });
    expect(finalizeOverdueSessions).not.toHaveBeenCalled();
    expect(announceLeaderboardChanged).not.toHaveBeenCalled();
  });

  it("notifies after deleting a riddle that had results, but not an unplayed one", async () => {
    deleteSchedule.mockResolvedValueOnce({ id, removedResults: 3 })
      .mockResolvedValueOnce({ id, removedResults: 0 });
    const request = () => new Request(`https://riddletime.test/api/admin/challenges/${id}`, { method: "DELETE" });
    const context = { params: Promise.resolve({ id }) };

    const first = await deleteRiddle(request(), context);
    await deleteRiddle(request(), context);

    expect(first.status).toBe(200);
    expect(deleteSchedule).toHaveBeenCalledWith(id);
    expect(announceLeaderboardChanged).toHaveBeenCalledTimes(1);
  });
});
