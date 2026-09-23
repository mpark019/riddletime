import { randomUUID } from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "@/lib/db";
import { createAuthUser } from "@/server/test/fixtures";

// Rows commit to a persistent database, so emails must stay unique across
// runs to keep the suite re-runnable without a manual reset.
function uniqueEmail(label: string) {
  return `${label}-${randomUUID()}@example.com`;
}

const { getVerifiedUser } = vi.hoisted(() => ({
  getVerifiedUser: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ getVerifiedUser }));

const { createInvitation, acceptInvitation } = await import(
  "./invitations"
);
const { ConflictError, ForbiddenError } = await import("@/server/http/errors");

async function makeAdmin() {
  const id = await createAuthUser();
  await pool.query(
    "insert into profiles (id, display_name, role) values ($1, 'Admin', 'admin')",
    [id],
  );
  return id;
}

// A flat setTimeout can't guarantee the concurrent insert actually reached
// the lock wait before we commit — poll until it's genuinely blocked, so the
// test can't pass for the wrong reason (e.g. the racer's insert simply
// hasn't been attempted yet, or already lost the race by seeing a committed
// row through the ordinary duplicate-pending-email pre-check instead).
// Scoped to a session actively waiting on a lock while running an insert
// into invitations specifically — a plain "any lock waiting anywhere" check
// (e.g. over pg_locks) isn't safe here, since Vitest runs test files in
// parallel and another file's own lock test could satisfy it instead.
async function waitForBlockedInvitationInsert(timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await pool.query(
      `select count(*)::int as waiting from pg_stat_activity
       where state = 'active' and wait_event_type = 'Lock'
         and query ilike '%insert into invitations%'`,
    );
    if (rows[0].waiting > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the concurrent invitations insert to block");
}

const fakeSender = { authUserId: null as string | null };
function inviteSender() {
  return {
    inviteUserByEmail: vi.fn(async () => ({ authUserId: fakeSender.authUserId })),
  };
}

beforeEach(() => {
  getVerifiedUser.mockReset();
  fakeSender.authUserId = null;
});

describe("createInvitation", () => {
  it("saves the pending row, then marks delivery sent from the injected sender", async () => {
    const adminId = await makeAdmin();
    getVerifiedUser.mockResolvedValue({ id: adminId });
    const invitedAuthId = await createAuthUser();
    fakeSender.authUserId = invitedAuthId;
    const sender = inviteSender();
    const email = uniqueEmail("player");

    const { id } = await createInvitation(
      {
        email: email.toUpperCase(),
        displayName: "Player One",
        role: "player",
        openingAmount: 0,
      },
      { inviteSender: sender },
    );

    expect(sender.inviteUserByEmail).toHaveBeenCalledWith(email);
    const { rows } = await pool.query(
      "select email, status, delivery_status, auth_user_id from invitations where id = $1",
      [id],
    );
    expect(rows[0]).toMatchObject({
      email,
      status: "pending",
      delivery_status: "sent",
      auth_user_id: invitedAuthId,
    });
  });

  it("rejects a duplicate pending email with the existing invitation id", async () => {
    const adminId = await makeAdmin();
    getVerifiedUser.mockResolvedValue({ id: adminId });
    const dupEmail = uniqueEmail("dup");
    const first = await createInvitation(
      { email: dupEmail, displayName: "A", role: "spectator" },
      { inviteSender: inviteSender() },
    );

    const attempt = createInvitation(
      { email: dupEmail, displayName: "B", role: "spectator" },
      { inviteSender: inviteSender() },
    );
    await expect(attempt).rejects.toBeInstanceOf(ConflictError);
    await attempt.catch((err) => {
      expect(err.details).toEqual({ invitationId: first.id });
    });
  });

  it("rejects a non-admin actor", async () => {
    const playerId = await createAuthUser();
    await pool.query(
      "insert into profiles (id, display_name, role) values ($1, 'Not Admin', 'player')",
      [playerId],
    );
    getVerifiedUser.mockResolvedValue({ id: playerId });

    await expect(
      createInvitation(
        { email: uniqueEmail("nope"), displayName: "A", role: "spectator" },
        { inviteSender: inviteSender() },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("acceptInvitation", () => {
  async function inviteAndBind(
    role: "player" | "spectator" | "admin",
    openingAmount?: number,
  ) {
    const adminId = await makeAdmin();
    getVerifiedUser.mockResolvedValue({ id: adminId });
    const recipientEmail = uniqueEmail("recipient");
    const recipientAuthId = await createAuthUser(recipientEmail);
    fakeSender.authUserId = recipientAuthId;
    const { id } = await createInvitation(
      {
        email: recipientEmail,
        displayName: "Recipient",
        role,
        ...(openingAmount === undefined ? {} : { openingAmount }),
      },
      { inviteSender: inviteSender() },
    );
    return { invitationId: id, recipientAuthId, recipientEmail };
  }

  it("onboards a player: profile + opening balance in one transaction", async () => {
    const { invitationId, recipientAuthId, recipientEmail } = await inviteAndBind(
      "player",
      100,
    );
    getVerifiedUser.mockResolvedValue({
      id: recipientAuthId,
      email: recipientEmail,
      email_confirmed_at: new Date().toISOString(),
    });

    const result = await acceptInvitation(invitationId);
    expect(result.alreadyAccepted).toBe(false);

    const { rows: profileRows } = await pool.query(
      "select role from profiles where id = $1",
      [recipientAuthId],
    );
    expect(profileRows[0].role).toBe("player");

    const { rows: pointRows } = await pool.query(
      "select amount, kind from point_transactions where user_id = $1",
      [recipientAuthId],
    );
    expect(pointRows).toEqual([{ amount: 100, kind: "opening_balance" }]);
  });

  it("is idempotent for a repeat acceptance by the same bound account", async () => {
    const { invitationId, recipientAuthId, recipientEmail } = await inviteAndBind(
      "spectator",
    );
    getVerifiedUser.mockResolvedValue({
      id: recipientAuthId,
      email: recipientEmail,
      email_confirmed_at: new Date().toISOString(),
    });

    await acceptInvitation(invitationId);
    const second = await acceptInvitation(invitationId);
    expect(second.alreadyAccepted).toBe(true);

    const { rows } = await pool.query(
      "select count(*)::int as count from profiles where id = $1",
      [recipientAuthId],
    );
    expect(rows[0].count).toBe(1);
  });

  it("rejects acceptance from an account whose email does not match", async () => {
    const { invitationId } = await inviteAndBind("spectator");
    const strangerEmail = uniqueEmail("stranger");
    const strangerId = await createAuthUser(strangerEmail);
    getVerifiedUser.mockResolvedValue({
      id: strangerId,
      email: strangerEmail,
    });

    await expect(acceptInvitation(invitationId)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("rejects acceptance when the account's email is unconfirmed (AC-1)", async () => {
    const { invitationId, recipientAuthId, recipientEmail } = await inviteAndBind(
      "admin",
    );
    getVerifiedUser.mockResolvedValue({
      id: recipientAuthId,
      email: recipientEmail,
      email_confirmed_at: null,
    });

    await expect(acceptInvitation(invitationId)).rejects.toBeInstanceOf(
      ForbiddenError,
    );

    const { rows } = await pool.query(
      "select status from invitations where id = $1",
      [invitationId],
    );
    expect(rows[0].status).toBe("pending");
    const { rows: profileRows } = await pool.query(
      "select count(*)::int as count from profiles where id = $1",
      [recipientAuthId],
    );
    expect(profileRows[0].count).toBe(0);
  });
});

describe("createInvitation concurrency", () => {
  it("returns a safe 409, not a raw uncaught error, on a genuine unique-index race (AC-1, AC-2)", async () => {
    // Two distinct admins so client A's insert (its invited_by FK takes an
    // implicit row lock on its inviter) can't incidentally serialize behind
    // client B's own requireAdmin lock on the same profile row — that would
    // hide the intended unique-index race behind ordinary lock contention.
    const adminA = await makeAdmin();
    const adminB = await makeAdmin();
    getVerifiedUser.mockResolvedValue({ id: adminB });
    const email = uniqueEmail("racer");

    const clientA = await pool.connect();
    try {
      await clientA.query("begin");
      await clientA.query(
        `insert into invitations (email, display_name, role, invited_by)
         values ($1, 'A', 'spectator', $2)`,
        [email, adminA],
      );

      const raced = createInvitation(
        { email, displayName: "B", role: "spectator" },
        { inviteSender: inviteSender() },
      );

      await waitForBlockedInvitationInsert();
      await clientA.query("commit");

      await expect(raced).rejects.toBeInstanceOf(ConflictError);
      await raced.catch((err) => {
        expect(err.message).not.toMatch(/duplicate key|constraint|invitations_/i);
      });
    } finally {
      clientA.release();
    }
  });
});
