import { describe, expect, it } from "vitest";
import { pool } from "@/lib/db";
import { createAuthUser } from "@/server/test/fixtures";

describe("point transaction retention", () => {
  it("permits deleting a row but still rejects updates", async () => {
    const playerId = await createAuthUser();
    const adminId = await createAuthUser();
    await pool.query(
      "insert into profiles (id, display_name, role) values ($1, 'Player', 'player'), ($2, 'Admin', 'admin')",
      [playerId, adminId],
    );
    const { rows } = await pool.query(
      `insert into point_transactions (user_id, amount, kind, reason, created_by, operation_key)
       values ($1, 10, 'manual_adjustment', 'Deletion test', $2, $3)
       returning id`,
      [playerId, adminId, `deletion-test:${playerId}`],
    );
    const pointId = rows[0].id as string;

    await expect(
      pool.query("update point_transactions set amount = 20 where id = $1", [pointId]),
    ).rejects.toThrow();

    const deleted = await pool.query("delete from point_transactions where id = $1 returning id", [
      pointId,
    ]);
    expect(deleted.rows).toEqual([{ id: pointId }]);
  });

  it("grants the runtime database role DELETE permission", async () => {
    const { rows } = await pool.query(
      "select has_table_privilege(current_user, 'public.point_transactions', 'DELETE') as can_delete",
    );
    expect(rows[0].can_delete).toBe(true);
  });
});
