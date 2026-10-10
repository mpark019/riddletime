import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { pool } from "@/lib/db";
import { createAuthUser, insertPuzzle } from "@/server/test/fixtures";

const { getVerifiedUser } = vi.hoisted(() => ({ getVerifiedUser: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ getVerifiedUser }));

const { createPuzzle, deletePuzzle, getPuzzle, listPuzzles, updatePuzzle } = await import("./puzzles");
const { ConflictError, ForbiddenError, NotFoundError } = await import("@/server/http/errors");
const { GET: listRoute, POST: createRoute } = await import("@/app/api/admin/puzzles/route");
const { GET: detailRoute, PATCH: patchRoute, DELETE: deleteRoute } = await import("@/app/api/admin/puzzles/[id]/route");

beforeEach(() => {
  getVerifiedUser.mockReset();
});

async function createProfile(role: "admin" | "player" | "spectator") {
  const id = await createAuthUser();
  await pool.query(
    "insert into profiles (id, display_name, role) values ($1, concat('Bank ', ($1::uuid)::text), $2)",
    [id, role],
  );
  return id;
}

async function asAdmin() {
  const id = await createProfile("admin");
  getVerifiedUser.mockResolvedValue({ id });
  return id;
}

const riddle = (prompt = `Riddle ${randomUUID()}`) => ({
  name: "Test riddle",
  difficulty: "medium",
  puzzle: { type: "riddle", prompt, accepted_answers: ["piano", "a piano"] },
});

async function scheduleOnPersonalDay(adminId: string, puzzleId: string, playerIds: string[]) {
  const offset = 7000 + Math.floor(Math.random() * 1_000_000);
  const { rows } = await pool.query(
    `insert into daily_challenges
       (active_date, mode, allowed_types, difficulty_selection, difficulty_presets, created_by)
     values (current_date + $2::int, 'personal', array['riddle'], 'random_player', '{"easy":{}}'::jsonb, $1)
     returning id`,
    [adminId, offset],
  );
  const challengeIds: string[] = [];
  for (const playerId of playerIds) {
    const { rows: challenge } = await pool.query(
      `insert into challenges
         (daily_challenge_id, mode, assigned_to, type, puzzle_id, difficulty, max_attempts, time_limit_seconds, scoring_policy)
       values ($1, 'personal', $2, 'riddle', $3, 'easy', 1, 60, '{"base_points":1}'::jsonb) returning id`,
      [rows[0].id, playerId, puzzleId],
    );
    challengeIds.push(challenge[0].id);
  }
  return challengeIds;
}

async function play(challengeId: string, playerId: string, outcome: {
  correct?: boolean;
  seconds?: number;
  attempts?: number;
  missed?: boolean;
  finished?: boolean;
}) {
  await pool.query(
    "insert into submissions (challenge_id, challenge_mode, assigned_to, user_id) values ($1, 'personal', $2, $2)",
    [challengeId, playerId],
  );
  if (outcome.finished === false) return;
  const ms = outcome.missed ? 0 : (outcome.seconds ?? 10) * 1000;
  await pool.query(
    `update submissions
     set submitted_at = started_at + ($3 * interval '1 millisecond'), time_taken_ms = $3, correct = $4,
         attempts = $5, scoring_breakdown = $6::jsonb
     where challenge_id = $1 and user_id = $2`,
    [
      challengeId,
      playerId,
      ms,
      outcome.correct ?? false,
      outcome.attempts ?? 1,
      JSON.stringify(outcome.missed ? { total_points: -1, missed: true } : { total_points: 0 }),
    ],
  );
}

describe("puzzle bank service", () => {
  it("creates a draft riddle with trimmed content and a letter puzzle with derived config (AC-2)", async () => {
    await asAdmin();
    const created = await createPuzzle({
      name: "Keys",
      difficulty: "hard",
      puzzle: { type: "riddle", prompt: "  What has keys?  ", accepted_answers: [" piano "] },
    });
    expect(created).toMatchObject({
      type: "riddle", prompt: "What has keys?", acceptedAnswers: ["piano"], difficulty: "hard", status: "draft", timesUsed: 0,
    });

    const letter = await createPuzzle({ name: "Crane", difficulty: "easy", puzzle: { type: "character_puzzle", target: "crane7" } });
    expect(letter).toMatchObject({ type: "character_puzzle", prompt: "Letter game", acceptedAnswers: ["CRANE7"] });
    const { rows } = await pool.query("select config from puzzles where id = $1", [letter.id]);
    expect(rows[0].config).toEqual({ target_length: 6, character_set: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" });
  });

  it("records who made each puzzle and shows their name in the list and detail", async () => {
    const adminId = await asAdmin();
    const byAdmin = await createPuzzle(riddle());
    const spectatorId = await createProfile("spectator");
    getVerifiedUser.mockResolvedValue({ id: spectatorId });
    const bySpectator = await createPuzzle(riddle());

    const name = async (id: string) =>
      (await pool.query("select display_name from profiles where id = $1", [id])).rows[0].display_name;
    expect(byAdmin.createdByName).toBe(await name(adminId));
    expect(bySpectator.createdByName).toBe(await name(spectatorId));

    const listed = await listPuzzles({});
    expect(listed.find((p) => p.id === bySpectator.id)?.createdByName).toBe(await name(spectatorId));
    expect((await getPuzzle(byAdmin.id)).createdByName).toBe(await name(adminId));
  });

  it("falls back to the profile's name, then null, when it has no display name", async () => {
    const named = await createProfile("admin");
    await pool.query("update profiles set display_name = null, name = 'Pat Lee' where id = $1", [named]);
    const anonymous = await createProfile("admin");
    await pool.query("update profiles set display_name = null, name = null where id = $1", [anonymous]);
    const fromNamed = await insertPuzzle(pool, { createdBy: named });
    const fromAnonymous = await insertPuzzle(pool, { createdBy: anonymous });
    await asAdmin();

    expect((await getPuzzle(fromNamed)).createdByName).toBe("Pat Lee");
    expect((await getPuzzle(fromAnonymous)).createdByName).toBe(null);
  });

  it("rejects invalid content and persists nothing (AC-2)", async () => {
    const adminId = await asAdmin();
    const bad = [
      { difficulty: "easy", puzzle: { type: "riddle", prompt: "ok", accepted_answers: ["x"] } },
      { name: "   ", difficulty: "easy", puzzle: { type: "riddle", prompt: "ok", accepted_answers: ["x"] } },
      { name: "N", difficulty: "easy", puzzle: { type: "riddle", prompt: "   ", accepted_answers: ["x"] } },
      { difficulty: "easy", puzzle: { type: "riddle", prompt: "ok", accepted_answers: [] } },
      { difficulty: "easy", puzzle: { type: "riddle", prompt: "ok", accepted_answers: ["Piano", "piano!"] } },
      { difficulty: "easy", puzzle: { type: "character_puzzle", target: "has space" } },
      { difficulty: "", puzzle: { type: "riddle", prompt: "ok", accepted_answers: ["x"] } },
      { name: "N", difficulty: "easy", puzzle: { type: "riddle", prompt: "ok", accepted_answers: ["x"] }, extra: 1 },
    ];
    for (const input of bad) await expect(createPuzzle(input)).rejects.toBeInstanceOf(ZodError);
    const { rowCount } = await pool.query("select 1 from puzzles where created_by = $1", [adminId]);
    expect(rowCount).toBe(0);
  });

  it.each([
    ["an empty answer", "   "],
    ["a space inside", "AB CD"],
    ["punctuation", "AB-CD"],
    ["an accented letter", "CAFÉ"],
    ["more than 25 characters", "A".repeat(26)],
  ])("rejects a letter game with %s and persists nothing (AC-2)", async (_name, target) => {
    const adminId = await asAdmin();
    await expect(createPuzzle({
      name: "Letters", difficulty: "easy", puzzle: { type: "character_puzzle", target },
    })).rejects.toBeInstanceOf(ZodError);
    const { rowCount } = await pool.query("select 1 from puzzles where created_by = $1", [adminId]);
    expect(rowCount).toBe(0);
  });

  it("accepts a 25-character and a single-character letter game (AC-2)", async () => {
    await asAdmin();
    const long = `${"A1".repeat(12)}A`;
    expect(await createPuzzle({ name: "Long", difficulty: "easy", puzzle: { type: "character_puzzle", target: long } }))
      .toMatchObject({ acceptedAnswers: [long] });
    expect(await createPuzzle({ name: "One", difficulty: "easy", puzzle: { type: "character_puzzle", target: "z" } }))
      .toMatchObject({ acceptedAnswers: ["Z"] });
  });

  it("refuses non-admins before validating input and never returns answers to them (AC-3)", async () => {
    const player = await createProfile("player");
    const adminId = await createProfile("admin");
    const puzzleId = await insertPuzzle(pool, { createdBy: adminId, answerData: { accepted: ["secret-answer"] } });

    for (const id of [player]) {
      getVerifiedUser.mockResolvedValue({ id });
      await expect(createPuzzle("not even an object")).rejects.toBeInstanceOf(ForbiddenError);
      await expect(listPuzzles({})).rejects.toBeInstanceOf(ForbiddenError);
      await expect(getPuzzle(puzzleId)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(updatePuzzle(puzzleId, { status: "retired" })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(deletePuzzle(puzzleId)).rejects.toBeInstanceOf(ForbiddenError);

      const response = await listRoute(new Request("https://riddletime.example/api/admin/puzzles"));
      expect(response.status).toBe(403);
      expect(JSON.stringify(await response.json())).not.toContain("secret-answer");
    }
    getVerifiedUser.mockResolvedValue(null);
    expect((await listRoute(new Request("https://riddletime.example/api/admin/puzzles"))).status).toBe(401);
  });

  it("filters the list by type, status, and whether it has been scheduled", async () => {
    const adminId = await asAdmin();
    const unusedRiddle = await insertPuzzle(pool, { createdBy: adminId });
    const retired = await insertPuzzle(pool, { createdBy: adminId, status: "retired" });
    const letter = await insertPuzzle(pool, { createdBy: adminId, type: "character_puzzle" });
    const used = await insertPuzzle(pool, { createdBy: adminId });
    await scheduleOnPersonalDay(adminId, used, [await createProfile("player")]);

    const ids = async (filter: object) => (await listPuzzles(filter)).map((p) => p.id);
    expect(await ids({ type: "character_puzzle" })).toContain(letter);
    expect(await ids({ type: "character_puzzle" })).not.toContain(unusedRiddle);
    expect(await ids({ status: "retired" })).toEqual(expect.arrayContaining([retired]));
    expect(await ids({ status: "retired" })).not.toContain(unusedRiddle);
    expect(await ids({ used: "true" })).toContain(used);
    expect(await ids({ used: "false" })).toEqual(expect.arrayContaining([unusedRiddle, retired, letter]));
    expect(await ids({ used: "false" })).not.toContain(used);
    expect((await listPuzzles({})).find((p) => p.id === used)?.timesUsed).toBe(1);
  });

  it("can hide puzzles that selected players have already had (AC-8)", async () => {
    const adminId = await asAdmin();
    const seenBy = await createProfile("player");
    const other = await createProfile("player");
    const seen = await insertPuzzle(pool, { createdBy: adminId });
    const fresh = await insertPuzzle(pool, { createdBy: adminId });
    await scheduleOnPersonalDay(adminId, seen, [seenBy]);

    const withSeen = (await listPuzzles({ exclude_seen_by: [seenBy] })).map((p) => p.id);
    expect(withSeen).not.toContain(seen);
    expect(withSeen).toContain(fresh);
    expect((await listPuzzles({ exclude_seen_by: [other] })).map((p) => p.id)).toContain(seen);
  });

  it("edits a draft, and freezes content but not status once it is scheduled (AC-4)", async () => {
    const adminId = await asAdmin();
    const puzzleId = await insertPuzzle(pool, { createdBy: adminId, prompt: "Before", status: "draft" });

    const edited = await updatePuzzle(puzzleId, {
      difficulty: "extreme",
      puzzle: { type: "riddle", prompt: "After", accepted_answers: ["x"] },
    });
    expect(edited).toMatchObject({ prompt: "After", difficulty: "extreme", acceptedAnswers: ["x"] });

    await updatePuzzle(puzzleId, { status: "active" });
    await scheduleOnPersonalDay(adminId, puzzleId, [await createProfile("player")]);
    await expect(updatePuzzle(puzzleId, {
      puzzle: { type: "riddle", prompt: "Too late", accepted_answers: ["y"] },
    })).rejects.toBeInstanceOf(ConflictError);
    await expect(updatePuzzle(puzzleId, { difficulty: "easy" })).rejects.toBeInstanceOf(ConflictError);
    expect((await getPuzzle(puzzleId)).prompt).toBe("After");

    expect(await updatePuzzle(puzzleId, { status: "retired" })).toMatchObject({ status: "retired", prompt: "After" });
    expect(await updatePuzzle(puzzleId, { status: "active" })).toMatchObject({ status: "active" });
    await updatePuzzle(puzzleId, { status: "draft" });
    await expect(updatePuzzle(puzzleId, { difficulty: "easy" })).rejects.toBeInstanceOf(ConflictError);
  });

  it("creates puzzles as drafts unless a status is given (AC-6)", async () => {
    await asAdmin();
    expect(await createPuzzle(riddle())).toMatchObject({ status: "draft" });
    expect(await createPuzzle({ ...riddle(), status: "active" })).toMatchObject({ status: "active" });
    await expect(createPuzzle({ ...riddle(), status: "archived" })).rejects.toBeInstanceOf(ZodError);
  });

  it("allows every status transition (AC-5)", async () => {
    const adminId = await asAdmin();
    const statuses = ["draft", "active", "retired"] as const;
    for (const from of statuses) {
      for (const to of statuses) {
        if (from === to) continue;
        const puzzleId = await insertPuzzle(pool, { createdBy: adminId, status: from });
        expect(await updatePuzzle(puzzleId, { status: to })).toMatchObject({ status: to });
      }
    }
  });

  it("freezes an active puzzle's content, including alongside the move to draft (AC-5)", async () => {
    const adminId = await asAdmin();
    const content = { puzzle: { type: "riddle" as const, prompt: "New", accepted_answers: ["n"] } };
    const active = await insertPuzzle(pool, { createdBy: adminId, prompt: "Old", status: "active" });
    await expect(updatePuzzle(active, content)).rejects.toBeInstanceOf(ConflictError);
    await expect(updatePuzzle(active, { ...content, status: "draft" })).rejects.toBeInstanceOf(ConflictError);
    expect(await updatePuzzle(active, { name: "Still renamable" })).toMatchObject({ prompt: "Old", status: "active" });

    const draft = await insertPuzzle(pool, { createdBy: adminId, prompt: "Old", status: "draft" });
    expect(await updatePuzzle(draft, { ...content, status: "active" })).toMatchObject({ prompt: "New", status: "active" });
  });

  it("lists drafts through the status filter (AC-8)", async () => {
    const adminId = await asAdmin();
    const draft = await insertPuzzle(pool, { createdBy: adminId, status: "draft" });
    const active = await insertPuzzle(pool, { createdBy: adminId, status: "active" });
    const ids = (await listPuzzles({ status: "draft" })).map((p) => p.id);
    expect(ids).toContain(draft);
    expect(ids).not.toContain(active);
  });

  it("names a puzzle on create and renames it even after it is scheduled, but never clears the name", async () => {
    const adminId = await asAdmin();
    const created = await createPuzzle({ ...riddle(), name: "  Keys riddle  ", status: "active" });
    expect(created.name).toBe("Keys riddle");
    await expect(createPuzzle({ ...riddle(), name: "x".repeat(81) })).rejects.toBeInstanceOf(ZodError);

    await scheduleOnPersonalDay(adminId, created.id, [await createProfile("player")]);
    expect(await updatePuzzle(created.id, { name: "Renamed" })).toMatchObject({ name: "Renamed", prompt: created.prompt });
    await expect(updatePuzzle(created.id, { name: "  " })).rejects.toBeInstanceOf(ZodError);
    await expect(updatePuzzle(created.id, { name: "Again", difficulty: "easy" })).rejects.toBeInstanceOf(ConflictError);
    expect((await getPuzzle(created.id)).name).toBe("Renamed");
  });

  it("will not change a puzzle's type through an edit", async () => {
    const adminId = await asAdmin();
    const puzzleId = await insertPuzzle(pool, { createdBy: adminId });
    await expect(updatePuzzle(puzzleId, {
      puzzle: { type: "character_puzzle", target: "ABC" },
    })).rejects.toThrow(/type/i);
    expect((await getPuzzle(puzzleId)).type).toBe("riddle");
  });

  it("deletes an unused puzzle and refuses a scheduled one (AC-4)", async () => {
    const adminId = await asAdmin();
    const unused = await insertPuzzle(pool, { createdBy: adminId });
    const scheduled = await insertPuzzle(pool, { createdBy: adminId });
    await scheduleOnPersonalDay(adminId, scheduled, [await createProfile("player")]);

    await deletePuzzle(unused);
    await expect(getPuzzle(unused)).rejects.toBeInstanceOf(NotFoundError);
    await expect(deletePuzzle(scheduled)).rejects.toBeInstanceOf(ConflictError);
    expect((await getPuzzle(scheduled)).id).toBe(scheduled);
    await expect(deletePuzzle(randomUUID())).rejects.toBeInstanceOf(NotFoundError);
  });

  it("serves the same operations through the routes", async () => {
    await asAdmin();
    const headers = { "Content-Type": "application/json" };
    const created = await createRoute(new Request("https://riddletime.example/api/admin/puzzles", {
      method: "POST", headers, body: JSON.stringify(riddle()),
    }));
    expect(created.status).toBe(201);
    const { puzzle } = await created.json() as { puzzle: { id: string } };
    const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
    const url = `https://riddletime.example/api/admin/puzzles/${puzzle.id}`;

    expect((await detailRoute(new Request(url), ctx(puzzle.id) as never)).status).toBe(200);
    const patched = await patchRoute(new Request(url, { method: "PATCH", headers, body: JSON.stringify({ status: "retired" }) }), ctx(puzzle.id) as never);
    expect(patched.status).toBe(200);
    expect((await deleteRoute(new Request(url, { method: "DELETE" }), ctx(puzzle.id) as never)).status).toBe(200);
    expect((await detailRoute(new Request(url), ctx(puzzle.id) as never)).status).toBe(404);
    expect((await createRoute(new Request("https://riddletime.example/api/admin/puzzles", {
      method: "POST", headers, body: JSON.stringify({ difficulty: "easy" }),
    }))).status).toBe(400);
  });
});

describe("puzzle bank for spectators", () => {
  async function asSpectator() {
    const id = await createProfile("spectator");
    getVerifiedUser.mockResolvedValue({ id });
    return id;
  }
  const content = { puzzle: { type: "riddle" as const, prompt: "Edited", accepted_answers: ["e"] } };

  it("lists and fetches puzzles with answers and statistics (AC-1)", async () => {
    const adminId = await createProfile("admin");
    const puzzleId = await insertPuzzle(pool, { createdBy: adminId, answerData: { accepted: ["secret-answer"] } });
    await asSpectator();

    expect((await listPuzzles({})).find((p) => p.id === puzzleId)?.acceptedAnswers).toEqual(["secret-answer"]);
    expect(await getPuzzle(puzzleId)).toMatchObject({ id: puzzleId, stats: expect.any(Object) });
    expect((await listRoute(new Request("https://riddletime.example/api/admin/puzzles"))).status).toBe(200);
  });

  it("creates drafts and refuses any other status without storing anything (AC-2)", async () => {
    const spectatorId = await asSpectator();
    expect(await createPuzzle(riddle())).toMatchObject({ status: "draft" });
    expect(await createPuzzle({ ...riddle(), status: "draft" })).toMatchObject({ status: "draft" });
    for (const status of ["active", "retired"]) {
      await expect(createPuzzle({ ...riddle(), status })).rejects.toBeInstanceOf(ForbiddenError);
    }
    const { rowCount } = await pool.query("select 1 from puzzles where created_by = $1", [spectatorId]);
    expect(rowCount).toBe(2);
  });

  it("edits any draft's name, difficulty, and content (AC-3)", async () => {
    const adminId = await createProfile("admin");
    const draft = await insertPuzzle(pool, { createdBy: adminId, status: "draft", prompt: "Before" });
    await asSpectator();

    expect(await updatePuzzle(draft, { name: "Renamed", difficulty: "hard", ...content }))
      .toMatchObject({ name: "Renamed", difficulty: "hard", prompt: "Edited", status: "draft" });
  });

  it.each(["active", "retired"] as const)("refuses to edit a %s puzzle, even its name (AC-4)", async (status) => {
    const adminId = await createProfile("admin");
    const puzzleId = await insertPuzzle(pool, { createdBy: adminId, status, prompt: "Untouched" });
    await asSpectator();

    await expect(updatePuzzle(puzzleId, content)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updatePuzzle(puzzleId, { name: "Sneaky" })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await getPuzzle(puzzleId)).toMatchObject({ prompt: "Untouched", status, name: null });
  });

  it("refuses any status field, including the current one (AC-5)", async () => {
    const adminId = await createProfile("admin");
    const draft = await insertPuzzle(pool, { createdBy: adminId, status: "draft" });
    await asSpectator();

    for (const status of ["draft", "active", "retired"]) {
      await expect(updatePuzzle(draft, { status })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(updatePuzzle(draft, { name: "N", status })).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect((await getPuzzle(draft)).status).toBe("draft");
  });

  it("refuses to delete a puzzle in any status (AC-6)", async () => {
    const adminId = await createProfile("admin");
    const ids = await Promise.all((["draft", "active", "retired"] as const)
      .map((status) => insertPuzzle(pool, { createdBy: adminId, status })));
    await asSpectator();

    for (const id of ids) {
      await expect(deletePuzzle(id)).rejects.toBeInstanceOf(ForbiddenError);
      expect((await getPuzzle(id)).id).toBe(id);
    }
  });

  it("reaches the same decisions through the routes (AC-2, AC-5, AC-6)", async () => {
    const adminId = await createProfile("admin");
    const draft = await insertPuzzle(pool, { createdBy: adminId, status: "draft" });
    await asSpectator();
    const headers = { "Content-Type": "application/json" };
    const ctx = { params: Promise.resolve({ id: draft }) } as never;
    const url = `https://riddletime.example/api/admin/puzzles/${draft}`;

    expect((await createRoute(new Request("https://riddletime.example/api/admin/puzzles", {
      method: "POST", headers, body: JSON.stringify({ ...riddle(), status: "active" }),
    }))).status).toBe(403);
    expect((await patchRoute(new Request(url, { method: "PATCH", headers, body: JSON.stringify({ status: "active" }) }), ctx)).status).toBe(403);
    expect((await patchRoute(new Request(url, { method: "PATCH", headers, body: JSON.stringify({ name: "Ok" }) }), ctx)).status).toBe(200);
    expect((await deleteRoute(new Request(url, { method: "DELETE" }), ctx)).status).toBe(403);
  });

  it("still lets admins do everything (AC-8)", async () => {
    const adminId = await asAdmin();
    const draft = await insertPuzzle(pool, { createdBy: adminId, status: "draft" });
    expect(await updatePuzzle(draft, { status: "active" })).toMatchObject({ status: "active" });
    await deletePuzzle(draft);
  });
});

describe("puzzle routes for non-admins (AC-3)", () => {
  it("answer 403 before reading the body or validating the id", async () => {
    const adminId = await createProfile("admin");
    const puzzleId = await insertPuzzle(pool, { createdBy: adminId });
    const player = await createProfile("player");
    getVerifiedUser.mockResolvedValue({ id: player });
    const ctx = (id: string) => ({ params: Promise.resolve({ id }) }) as never;
    const headers = { "Content-Type": "application/json" };
    const malformed = (method: string) => new Request("https://riddletime.example/api/admin/puzzles", { method, headers, body: "{bad" });

    expect((await createRoute(malformed("POST"))).status).toBe(403);
    expect((await patchRoute(malformed("PATCH"), ctx(puzzleId))).status).toBe(403);
    expect((await patchRoute(malformed("PATCH"), ctx("not-a-uuid"))).status).toBe(403);
    expect((await detailRoute(new Request("https://riddletime.example/x"), ctx("not-a-uuid"))).status).toBe(403);
    expect((await deleteRoute(new Request("https://riddletime.example/x", { method: "DELETE" }), ctx("not-a-uuid"))).status).toBe(403);
  });

  it("still reports malformed input and ids to admins as 400", async () => {
    await asAdmin();
    const ctx = (id: string) => ({ params: Promise.resolve({ id }) }) as never;
    const bad = new Request("https://riddletime.example/api/admin/puzzles", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{bad",
    });
    expect((await createRoute(bad)).status).toBe(400);
    expect((await detailRoute(new Request("https://riddletime.example/x"), ctx("not-a-uuid"))).status).toBe(400);
  });
});

describe("puzzle statistics (AC-10)", () => {
  it("counts started, solved, failed, missed, and unfinished games separately", async () => {
    const adminId = await asAdmin();
    const puzzleId = await insertPuzzle(pool, { createdBy: adminId });
    const players = await Promise.all([1, 2, 3, 4, 5, 6].map(() => createProfile("player")));
    const challenges = await scheduleOnPersonalDay(adminId, puzzleId, players);

    await play(challenges[0], players[0], { correct: true, seconds: 10, attempts: 1 });
    await play(challenges[1], players[1], { correct: true, seconds: 30, attempts: 3 });
    await play(challenges[2], players[2], { correct: false, seconds: 60, attempts: 2 });
    await play(challenges[3], players[3], { missed: true });
    await play(challenges[4], players[4], { finished: false });
    // players[5] never started

    const { stats } = await getPuzzle(puzzleId);
    expect(stats).toEqual({
      daysUsed: 1,
      assigned: 6,
      started: 4,
      finished: 3,
      solved: 2,
      missed: 1,
      solveRate: 2 / 3,
      medianSolveSeconds: 20,
      averageAttempts: 2,
    });
    expect((await listPuzzles({})).find((p) => p.id === puzzleId)?.stats.solved).toBe(2);

    const { activity } = await getPuzzle(puzzleId);
    expect(activity?.plays).toHaveLength(6);
    expect(activity?.plays.map((entry) => entry.outcome).sort())
      .toEqual(["failed", "in_progress", "missed", "not_started", "solved", "solved"]);
    expect(activity?.ruleSets).toHaveLength(1);
    expect(activity?.ruleSets[0]).toMatchObject({ assigned: 6, solved: 2, failed: 1, missed: 1, solveRate: 2 / 3 });
  });

  it("reports empty statistics for a puzzle that has never been scheduled", async () => {
    const adminId = await asAdmin();
    const puzzleId = await insertPuzzle(pool, { createdBy: adminId });
    expect((await getPuzzle(puzzleId)).stats).toEqual({
      daysUsed: 0, assigned: 0, started: 0, finished: 0, solved: 0, missed: 0,
      solveRate: null, medianSolveSeconds: null, averageAttempts: null,
    });
  });
});
