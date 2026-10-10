import { beforeEach, describe, expect, it, vi } from "vitest";

const { recordActivity } = vi.hoisted(() => ({ recordActivity: vi.fn() }));
vi.mock("@/server/challenges/activity", () => ({ recordActivity }));

const { ForbiddenError, NotFoundError } = await import("@/server/http/errors");
const { POST } = await import("./challenge/[id]/activity/route");

const ID = "8d0c3b1e-5f0a-4f55-9a36-0c5f3b6f2a11";

function call(body: unknown, id = ID) {
  return POST(
    new Request("http://localhost/api/challenge/x/activity", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }),
    { params: Promise.resolve({ id }) } as never,
  );
}

beforeEach(() => {
  recordActivity.mockReset();
});

describe("POST /api/challenge/[id]/activity", () => {
  it("passes a valid kind through and returns the recorded flag", async () => {
    recordActivity.mockResolvedValue({ recorded: true });

    const response = await call({ kind: "away" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ recorded: true });
    expect(recordActivity).toHaveBeenCalledWith(ID, "away");
  });

  it("accepts the copy kind (AC-14)", async () => {
    recordActivity.mockResolvedValue({ recorded: true });

    expect((await call({ kind: "copy" })).status).toBe(200);
    expect(recordActivity).toHaveBeenCalledWith(ID, "copy");
  });

  it("accepts the paste kind (AC-15)", async () => {
    recordActivity.mockResolvedValue({ recorded: true });

    expect((await call({ kind: "paste" })).status).toBe(200);
    expect(recordActivity).toHaveBeenCalledWith(ID, "paste");
  });

  it.each([
    ["unknown kind", { kind: "scroll" }],
    ["extra field", { kind: "away", at: 1 }],
    ["missing kind", {}],
    ["malformed JSON", "{"],
  ])("rejects %s with 400 and writes nothing", async (_label, body) => {
    const response = await call(body);

    expect(response.status).toBe(400);
    expect(recordActivity).not.toHaveBeenCalled();
  });

  it("rejects a non-uuid id with 400", async () => {
    expect((await call({ kind: "away" }, "nope")).status).toBe(400);
    expect(recordActivity).not.toHaveBeenCalled();
  });

  it("maps forbidden and missing-session errors", async () => {
    recordActivity.mockRejectedValueOnce(new ForbiddenError("Player role required"));
    expect((await call({ kind: "away" })).status).toBe(403);

    recordActivity.mockRejectedValueOnce(new NotFoundError("No saved session for that challenge"));
    expect((await call({ kind: "away" })).status).toBe(404);
  });
});
