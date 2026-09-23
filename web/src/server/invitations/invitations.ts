import "server-only";
import { z } from "zod";
import { pool, withTransaction } from "@/lib/db";
import { requireAdmin, requireUser } from "@/server/identity/identity";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { ConflictError, ForbiddenError, NotFoundError } from "@/server/http/errors";

export const createInvitationInput = z
  .object({
    email: z.email(),
    displayName: z.string().trim().min(1),
    role: z.enum(["spectator", "player", "admin"]),
    openingAmount: z.number().int().nonnegative().optional(),
  })
  .refine(
    (v) => (v.role === "player" ? v.openingAmount !== undefined : v.openingAmount === undefined),
    {
      message:
        "openingAmount is required for role 'player' and must be omitted otherwise",
      path: ["openingAmount"],
    },
  );
export type CreateInvitationInput = z.infer<typeof createInvitationInput>;

// Narrow on purpose so tests can inject a fake instead of a real Supabase client.
export interface InviteEmailSender {
  inviteUserByEmail(email: string): Promise<{ authUserId: string | null }>;
}

function defaultInviteSender(): InviteEmailSender {
  const admin = createSupabaseAdminClient();
  return {
    async inviteUserByEmail(email) {
      const { data, error } = await admin.auth.admin.inviteUserByEmail(email);
      if (error) {
        throw new Error(`Supabase invite delivery failed: ${error.message}`);
      }
      return { authUserId: data.user?.id ?? null };
    },
  };
}

const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";

function isConstraintViolation(err: unknown): err is { code: string; message: string } {
  if (typeof err !== "object" || err === null || !("code" in err)) return false;
  const code = (err as { code: unknown }).code;
  return code === CHECK_VIOLATION || code === UNIQUE_VIOLATION;
}

// Never forward a raw Postgres/trigger message to the client — it can
// include constraint or schema details not meant for end users. Log it
// server-side and return a fixed, generic conflict instead.
function toSafeConflict(err: { message: string }): ConflictError {
  console.error("Constraint violation on write:", err.message);
  return new ConflictError("This request conflicts with existing data");
}

// The pending row commits on its own, before the provider call, so a
// delivery failure never rolls back the saved invitation.
export async function createInvitation(
  input: CreateInvitationInput,
  deps: { inviteSender?: InviteEmailSender } = {},
) {
  const parsed = createInvitationInput.parse(input);
  const email = parsed.email.trim().toLowerCase();

  const invitationId = await withTransaction(async (client) => {
    const admin = await requireAdmin(client);

    const { rows: existing } = await client.query(
      "select id from invitations where email = $1 and status = 'pending'",
      [email],
    );
    if (existing[0]) {
      throw new ConflictError("A pending invitation already exists for this email", {
        invitationId: existing[0].id,
      });
    }

    try {
      const { rows } = await client.query(
        `insert into invitations (email, display_name, role, opening_amount, invited_by)
         values ($1, $2, $3, $4, $5)
         returning id`,
        [email, parsed.displayName, parsed.role, parsed.openingAmount ?? null, admin.id],
      );
      return rows[0].id as string;
    } catch (err) {
      if (isConstraintViolation(err)) throw toSafeConflict(err);
      throw err;
    }
  });

  const sender = deps.inviteSender ?? defaultInviteSender();
  try {
    const { authUserId } = await sender.inviteUserByEmail(email);
    await pool.query(
      `update invitations
       set auth_user_id = $1, delivery_status = 'sent', last_sent_at = clock_timestamp()
       where id = $2`,
      [authUserId, invitationId],
    );
  } catch {
    await pool.query(
      "update invitations set delivery_status = 'failed' where id = $1",
      [invitationId],
    );
  }

  return { id: invitationId };
}

// Needs a verified session but not an existing profile — this is the one
// onboarding path that runs before a profile exists.
export async function acceptInvitation(invitationId: string) {
  const user = await requireUser();
  const userEmail = user.email?.toLowerCase();
  if (!user.email_confirmed_at) {
    throw new ForbiddenError("Account email must be confirmed before accepting an invitation");
  }

  try {
    return await withTransaction(async (client) => {
      const { rows } = await client.query(
        "select * from invitations where id = $1 for update",
        [invitationId],
      );
      const invitation = rows[0];
      if (!invitation) throw new NotFoundError("Invitation not found");

      if (invitation.status === "accepted") {
        if (invitation.auth_user_id !== user.id) {
          throw new ForbiddenError(
            "Only the bound recipient may repeat this invitation",
          );
        }
        const { rows: profileRows } = await client.query(
          "select id, display_name, role from profiles where id = $1",
          [user.id],
        );
        return {
          invitationId: invitation.id,
          alreadyAccepted: true,
          profile: profileRows[0],
        };
      }
      if (invitation.status === "cancelled") {
        throw new ConflictError("This invitation was cancelled");
      }

      if (invitation.auth_user_id && invitation.auth_user_id !== user.id) {
        throw new ForbiddenError("This invitation is bound to a different account");
      }
      if (!userEmail || userEmail !== invitation.email) {
        throw new ForbiddenError(
          "Verified account email does not match the invitation",
        );
      }

      const { rows: existingProfile } = await client.query(
        "select id from profiles where id = $1",
        [user.id],
      );
      if (existingProfile[0]) {
        throw new ConflictError(
          "Account already has a profile; this requires admin recovery",
        );
      }

      await client.query(
        `update invitations
         set auth_user_id = $1, status = 'accepted', accepted_at = clock_timestamp()
         where id = $2`,
        [user.id, invitationId],
      );
      await client.query(
        "insert into profiles (id, display_name, role) values ($1, $2, $3)",
        [user.id, invitation.display_name, invitation.role],
      );
      if (invitation.role === "player") {
        await client.query(
          `insert into point_transactions (user_id, amount, kind, reason, operation_key)
           values ($1, $2, 'opening_balance', 'Opening balance', $3)`,
          [user.id, invitation.opening_amount, `opening:${user.id}`],
        );
      }

      return {
        invitationId,
        alreadyAccepted: false,
        profile: { id: user.id, display_name: invitation.display_name, role: invitation.role },
      };
    });
  } catch (err) {
    if (isConstraintViolation(err)) throw toSafeConflict(err);
    throw err;
  }
}
