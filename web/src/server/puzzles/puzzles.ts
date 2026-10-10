import "server-only";
import type { PoolClient } from "pg";
import { z } from "zod";
import { withTransaction } from "@/lib/db";
import { CHARACTER_SET, type CharacterConfig } from "@/server/challenges/character-puzzle";
import { requireAdmin, requireAdminRead } from "@/server/identity/identity";
import { BadRequestError, ConflictError, NotFoundError } from "@/server/http/errors";
import {
  characterPuzzleSchema,
  manualPuzzleSchema,
  presetNameSchema,
} from "@/server/schedules/schedules";
import { loadPuzzleActivity, type PuzzleActivity } from "./puzzle-activity";
import { hasSeenSql, insertPuzzle, puzzleAnswers, type NewPuzzleContent } from "./puzzle-store";

const MAX_FILTER_PLAYERS = 500;

const puzzleContentSchema = z.discriminatedUnion("type", [manualPuzzleSchema, characterPuzzleSchema]);
const idSchema = z.uuid();
const nameSchema = z.string().trim().min(1).max(80);
const statusSchema = z.enum(["draft", "active", "retired"]);

// Routes pass the body reader itself, so it runs only after the role check.
type LazyInput = unknown | (() => Promise<unknown>);

async function resolveInput(input: LazyInput): Promise<unknown> {
  return typeof input === "function" ? (input as () => Promise<unknown>)() : input;
}
type PuzzleContentInput = z.infer<typeof puzzleContentSchema>;

export const createPuzzleInput = z.object({
  name: nameSchema.optional(),
  status: statusSchema.default("draft"),
  difficulty: presetNameSchema,
  puzzle: puzzleContentSchema,
}).strict();

export const updatePuzzleInput = z.object({
  name: nameSchema.optional(),
  difficulty: presetNameSchema.optional(),
  puzzle: puzzleContentSchema.optional(),
  status: statusSchema.optional(),
}).strict().refine(
  (input) => input.name !== undefined || input.difficulty !== undefined
    || input.puzzle !== undefined || input.status !== undefined,
  { message: "Provide at least one field to change" },
);

export const listPuzzlesInput = z.object({
  type: z.enum(["riddle", "character_puzzle"]).optional(),
  status: statusSchema.optional(),
  used: z.enum(["true", "false"]).optional(),
  exclude_seen_by: z.array(z.uuid()).max(MAX_FILTER_PLAYERS).optional(),
}).strict();

export interface PuzzleStats {
  daysUsed: number;
  assigned: number;
  started: number;
  finished: number;
  solved: number;
  missed: number;
  solveRate: number | null;
  medianSolveSeconds: number | null;
  averageAttempts: number | null;
}

export interface BankPuzzle {
  id: string;
  type: "riddle" | "character_puzzle";
  name: string | null;
  prompt: string;
  acceptedAnswers: string[];
  difficulty: string;
  status: "draft" | "active" | "retired";
  createdAt: string;
  timesUsed: number;
  stats: PuzzleStats;
  activity?: PuzzleActivity;
}

const EMPTY_STATS: PuzzleStats = {
  daysUsed: 0, assigned: 0, started: 0, finished: 0, solved: 0, missed: 0,
  solveRate: null, medianSolveSeconds: null, averageAttempts: null,
};

function toContent(puzzle: PuzzleContentInput): NewPuzzleContent {
  if (puzzle.type === "riddle") {
    return {
      type: "riddle",
      prompt: puzzle.prompt,
      config: {},
      answerData: { accepted: puzzle.accepted_answers },
    };
  }
  const config: CharacterConfig = { target_length: puzzle.target.length, character_set: CHARACTER_SET };
  return { type: "character_puzzle", prompt: "Letter game", config, answerData: { target: puzzle.target } };
}

// Missed days carry no play, so they stay out of every rate.
async function loadStats(client: PoolClient, puzzleIds: string[]): Promise<Map<string, PuzzleStats>> {
  if (puzzleIds.length === 0) return new Map();
  const { rows } = await client.query(
    `with plays as (
       select c.puzzle_id, s.submitted_at, s.correct, s.attempts, s.time_taken_ms,
              coalesce(s.scoring_breakdown @> '{"missed": true}', false) as missed
       from submissions s join challenges c on c.id = s.challenge_id
       where c.puzzle_id = any($1::uuid[])
     ),
     placements as (
       select c.puzzle_id,
              count(distinct c.daily_challenge_id)::int as days_used,
              coalesce(sum(case when c.mode = 'personal' then 1 else (
                select count(*) from profiles p
                where p.role = 'player'
                  and p.created_at < riddle_private.day_end(d.active_date, current_setting('timezone'))
              ) end), 0)::int as assigned
       from challenges c join daily_challenges d on d.id = c.daily_challenge_id
       where c.puzzle_id = any($1::uuid[])
       group by c.puzzle_id
     ),
     results as (
       select puzzle_id,
              count(*) filter (where not missed)::int as started,
              count(*) filter (where not missed and submitted_at is not null)::int as finished,
              count(*) filter (where not missed and submitted_at is not null and correct)::int as solved,
              count(*) filter (where missed)::int as missed,
              percentile_cont(0.5) within group (order by time_taken_ms)
                filter (where not missed and submitted_at is not null and correct) as median_ms,
              avg(attempts) filter (where not missed and submitted_at is not null) as avg_attempts
       from plays group by puzzle_id
     )
     select p.puzzle_id, p.days_used, p.assigned,
            coalesce(r.started, 0) as started, coalesce(r.finished, 0) as finished,
            coalesce(r.solved, 0) as solved, coalesce(r.missed, 0) as missed,
            r.median_ms, r.avg_attempts
     from placements p left join results r on r.puzzle_id = p.puzzle_id`,
    [puzzleIds],
  );
  return new Map(rows.map((row) => [row.puzzle_id as string, {
    daysUsed: row.days_used,
    assigned: row.assigned,
    started: row.started,
    finished: row.finished,
    solved: row.solved,
    missed: row.missed,
    solveRate: row.finished > 0 ? row.solved / row.finished : null,
    medianSolveSeconds: row.median_ms === null ? null : Number(row.median_ms) / 1000,
    averageAttempts: row.avg_attempts === null ? null : Number(row.avg_attempts),
  }]));
}

function toBankPuzzle(row: Record<string, unknown>, stats: PuzzleStats | undefined): BankPuzzle {
  return {
    id: row.id as string,
    type: row.type as BankPuzzle["type"],
    name: (row.name as string | null) ?? null,
    prompt: row.prompt as string,
    acceptedAnswers: puzzleAnswers(row.answer_data as { accepted?: unknown; target?: unknown }),
    difficulty: row.difficulty as string,
    status: row.status as BankPuzzle["status"],
    createdAt: new Date(row.created_at as string).toISOString(),
    timesUsed: row.times_used as number,
    stats: stats ?? EMPTY_STATS,
  };
}

const PUZZLE_COLUMNS = `pz.id, pz.type, pz.name, pz.prompt, pz.answer_data, pz.difficulty, pz.status, pz.created_at,
  (select count(*)::int from challenges c where c.puzzle_id = pz.id) as times_used`;

async function loadOne(client: PoolClient, id: string): Promise<BankPuzzle> {
  const { rows } = await client.query(`select ${PUZZLE_COLUMNS} from puzzles pz where pz.id = $1`, [id]);
  if (!rows[0]) throw new NotFoundError("Puzzle not found");
  const stats = await loadStats(client, [id]);
  return toBankPuzzle(rows[0], stats.get(id));
}

const FROZEN_MESSAGE = "This puzzle has been scheduled, so its content can no longer change. Retire it instead.";
const ACTIVE_MESSAGE = "An active puzzle's content cannot change. Move it to draft first.";

export async function createPuzzle(input: LazyInput): Promise<BankPuzzle> {
  return withTransaction(async (client) => {
    const admin = await requireAdmin(client);
    const parsed = createPuzzleInput.parse(await resolveInput(input));
    const id = await insertPuzzle(client, admin.id, toContent(parsed.puzzle), parsed.difficulty, parsed.name ?? null, parsed.status);
    return loadOne(client, id);
  });
}

export async function listPuzzles(filter: LazyInput): Promise<BankPuzzle[]> {
  return withTransaction(async (client) => {
    await requireAdminRead(client);
    const parsed = listPuzzlesInput.parse(await resolveInput(filter));
    const values: unknown[] = [];
    const where: string[] = [];
    const bind = (value: unknown) => `$${values.push(value)}`;
    if (parsed.type) where.push(`pz.type = ${bind(parsed.type)}`);
    if (parsed.status) where.push(`pz.status = ${bind(parsed.status)}`);
    if (parsed.used) {
      where.push(`${parsed.used === "true" ? "" : "not "}exists (select 1 from challenges c where c.puzzle_id = pz.id)`);
    }
    if (parsed.exclude_seen_by?.length) {
      const players = bind(parsed.exclude_seen_by);
      where.push(`not exists (
        select 1 from profiles p
        where p.id = any(${players}::uuid[]) and ${hasSeenSql("pz.id", "p.id", "p.created_at")}
      )`);
    }
    const { rows } = await client.query(
      `select ${PUZZLE_COLUMNS} from puzzles pz
       ${where.length ? `where ${where.join(" and ")}` : ""}
       order by pz.created_at desc, pz.id`,
      values,
    );
    const stats = await loadStats(client, rows.map((row) => row.id as string));
    return rows.map((row) => toBankPuzzle(row, stats.get(row.id as string)));
  });
}

export async function getPuzzle(id: unknown): Promise<BankPuzzle> {
  return withTransaction(async (client) => {
    await requireAdminRead(client);
    const puzzleId = idSchema.parse(id);
    const puzzle = await loadOne(client, puzzleId);
    return { ...puzzle, activity: await loadPuzzleActivity(client, puzzleId) };
  });
}

// Only the content-freeze triggers and the challenges foreign key map to 409; other violations pass through.
function frozenConflict(error: unknown): never {
  const { code, message } = error as { code?: unknown; message?: unknown };
  const trigger = code === "23514" && typeof message === "string" ? message : "";
  if (/active puzzle/i.test(trigger)) throw new ConflictError(ACTIVE_MESSAGE);
  if (/scheduled puzzle/i.test(trigger) || code === "23503") throw new ConflictError(FROZEN_MESSAGE);
  throw error;
}

export async function updatePuzzle(rawId: unknown, input: LazyInput): Promise<BankPuzzle> {
  try {
    return await withTransaction(async (client) => {
      await requireAdmin(client);
      const id = idSchema.parse(rawId);
      const parsed = updatePuzzleInput.parse(await resolveInput(input));
      const { rows } = await client.query("select type, status from puzzles where id = $1 for update", [id]);
      if (!rows[0]) throw new NotFoundError("Puzzle not found");
      if (parsed.puzzle && parsed.puzzle.type !== rows[0].type) {
        throw new BadRequestError("A puzzle's type cannot be changed");
      }

      const changesContent = parsed.puzzle !== undefined || parsed.difficulty !== undefined;
      if (changesContent) {
        const { rows: used } = await client.query("select 1 from challenges where puzzle_id = $1 limit 1", [id]);
        if (used[0]) throw new ConflictError(FROZEN_MESSAGE);
        if (rows[0].status === "active") throw new ConflictError(ACTIVE_MESSAGE);
      }

      const content = parsed.puzzle ? toContent(parsed.puzzle) : null;
      await client.query(
        `update puzzles set
           prompt = coalesce($2, prompt),
           config = coalesce($3::jsonb, config),
           answer_data = coalesce($4::jsonb, answer_data),
           difficulty = coalesce($5, difficulty),
           status = coalesce($6, status),
           name = case when $7::boolean then $8 else name end
         where id = $1`,
        [
          id,
          content?.prompt ?? null,
          content ? JSON.stringify(content.config) : null,
          content ? JSON.stringify(content.answerData) : null,
          parsed.difficulty ?? null,
          parsed.status ?? null,
          parsed.name !== undefined,
          parsed.name ?? null,
        ],
      );
      return loadOne(client, id);
    });
  } catch (error) {
    return frozenConflict(error);
  }
}

export async function deletePuzzle(rawId: unknown): Promise<{ id: string }> {
  try {
    return await withTransaction(async (client) => {
      await requireAdmin(client);
      const id = idSchema.parse(rawId);
      const { rows } = await client.query("select 1 from puzzles where id = $1 for update", [id]);
      if (!rows[0]) throw new NotFoundError("Puzzle not found");
      await client.query("delete from puzzles where id = $1", [id]);
      return { id };
    });
  } catch (error) {
    return frozenConflict(error);
  }
}
