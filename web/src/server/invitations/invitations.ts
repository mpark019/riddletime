import "server-only";
import { z } from "zod";
import { Resend } from "resend";
import { pool, withTransaction } from "@/lib/db";
import { requireAdmin, requireUser } from "@/server/identity/identity";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { ConflictError, ForbiddenError, NotFoundError } from "@/server/http/errors";
import { env } from "@/lib/env";

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
  sendInvite(
    email: string,
    invitationId: string,
  ): Promise<{ authUserId: string | null }>;
}

// generateLink + our own send, not Supabase's inviteUserByEmail: one link-generation path for both create and resend, and full control over the email itself.
function defaultInviteSender(): InviteEmailSender {
  const admin = createSupabaseAdminClient();
  const resend = new Resend(env.RESEND_API_KEY);
  return {
    async sendInvite(email, invitationId) {
      const { data, error } = await admin.auth.admin.generateLink({
        type: "invite",
        email,
        options: {
          redirectTo: `${env.SITE_URL}/invite/accept?invitationId=${invitationId}`,
        },
      });
      if (error) {
        throw new Error(`Supabase link generation failed: ${error.message}`);
      }

      const { error: sendError } = await resend.emails.send({
        from: env.RESEND_FROM_EMAIL,
        to: email,
        subject: "You're invited to riddletime",
        html: `<p>You've been invited to riddletime.</p><p><a href="${data.properties.action_link}">Accept your invitation</a></p>`,
      });
      if (sendError) {
        throw new Error(`Resend delivery failed: ${sendError.message}`);
      }

      return { authUserId: data.user?.id ?? null };
    },
  };
}

export interface AuthUserAdmin {
  deleteAuthUser(authUserId: string): Promise<void>;
}

function defaultAuthUserAdmin(): AuthUserAdmin {
  const admin = createSupabaseAdminClient();
  return {
    async deleteAuthUser(authUserId) {
      const { error } = await admin.auth.admin.deleteUser(authUserId);
      if (error) {
        throw new Error(`Supabase user deletion failed: ${error.message}`);
      }
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

// Never forward a raw Postgres/trigger message to the client; it can leak constraint or schema details.
function toSafeConflict(err: { message: string }): ConflictError {
  console.error("Constraint violation on write:", err.message);
  return new ConflictError("This request conflicts with existing data");
}

// Commits before the provider call, so a delivery failure never rolls back the saved invitation.
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
    const { authUserId } = await sender.sendInvite(email, invitationId);
    await pool.query(
      `update invitations
       set auth_user_id = $1, delivery_status = 'sent', last_sent_at = clock_timestamp()
       where id = $2`,
      [authUserId, invitationId],
    );
  } catch (err) {
    await pool.query(
      "update invitations set delivery_status = 'failed' where id = $1",
      [invitationId],
    );
    console.error("Invite delivery failed:", err);
  }

  return { id: invitationId };
}

// The one onboarding path that runs before a profile exists, so it needs a verified session but not one.
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

// Delete and reissue rather than rebind: Supabase rejects a second invite to an already-invited email.
export async function resendInvitation(
  invitationId: string,
  deps: { inviteSender?: InviteEmailSender; authAdmin?: AuthUserAdmin } = {},
) {
  const deleted = await withTransaction(async (client) => {
    await requireAdmin(client);
    const { rows } = await client.query(
      `delete from invitations where id = $1 and status = 'pending'
       returning email, display_name, role, opening_amount, auth_user_id`,
      [invitationId],
    );
    if (rows[0]) {
      return rows[0] as {
        email: string;
        display_name: string;
        role: "spectator" | "player" | "admin";
        opening_amount: number | null;
        auth_user_id: string | null;
      };
    }

    const { rows: existing } = await client.query(
      "select id from invitations where id = $1",
      [invitationId],
    );
    if (!existing[0]) throw new NotFoundError("Invitation not found");
    throw new ConflictError("Only a pending invitation can be resent");
  });

  if (deleted.auth_user_id) {
    const authAdmin = deps.authAdmin ?? defaultAuthUserAdmin();
    try {
      await authAdmin.deleteAuthUser(deleted.auth_user_id);
    } catch (err) {
      console.error("Failed to delete stale invited auth user before resend:", err);
      throw new Error("Could not prepare this invitation for resend");
    }
  }

  return createInvitation(
    {
      email: deleted.email,
      displayName: deleted.display_name,
      role: deleted.role,
      ...(deleted.role === "player" ? { openingAmount: deleted.opening_amount ?? 0 } : {}),
    },
    { inviteSender: deps.inviteSender },
  );
}

// Unlike cancel, this permanently removes the record, which frees its FK-restricted Supabase auth user.
export async function deleteInvitation(
  invitationId: string,
  deps: { authAdmin?: AuthUserAdmin } = {},
) {
  const deleted = await withTransaction(async (client) => {
    await requireAdmin(client);
    const { rows } = await client.query(
      "delete from invitations where id = $1 returning auth_user_id",
      [invitationId],
    );
    if (!rows[0]) throw new NotFoundError("Invitation not found");
    return rows[0] as { auth_user_id: string | null };
  });

  if (deleted.auth_user_id) {
    const authAdmin = deps.authAdmin ?? defaultAuthUserAdmin();
    try {
      await authAdmin.deleteAuthUser(deleted.auth_user_id);
    } catch (err) {
      console.error("Failed to delete invited auth user on invitation delete:", err);
    }
  }

  return { id: invitationId };
}

export interface PendingInvitation {
  id: string;
  email: string;
  displayName: string;
  role: "spectator" | "player" | "admin";
  deliveryStatus: string;
  createdAt: string;
}

export async function listPendingInvitations(): Promise<PendingInvitation[]> {
  return withTransaction(async (client) => {
    await requireAdmin(client);
    const { rows } = await client.query(
      `select id, email, display_name, role, delivery_status, created_at
       from invitations
       where status = 'pending'
       order by created_at desc`,
    );
    return rows.map((row) => ({
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
      deliveryStatus: row.delivery_status,
      createdAt: row.created_at,
    }));
  });
}
