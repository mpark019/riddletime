import "server-only";
import type { PoolClient } from "pg";
import { z } from "zod";
import { withTransaction } from "@/lib/db";
import { CHARACTER_SET, type CharacterConfig } from "@/server/challenges/character-puzzle";
import { requirePuzzleBank, requirePuzzleBankRead } from "@/server/identity/identity";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "@/server/http/errors";
import {
  characterPuzzleSchema,
  imagePuzzleSchema,
  manualPuzzleSchema,
  presetNameSchema,
} from "@/server/schedules/schedules";
import { imageConfigSchema, MAX_IMAGES } from "@/server/challenges/image-puzzle";
import { readImageFile } from "@/server/storage/image-file";
import {
  isPromptImagePath,
  newPromptImagePath,
  removePuzzleImages,
  signPuzzleImages,
  uploadPuzzleImage,
} from "@/server/storage/puzzle-images";
import type { LastUsage } from "@/lib/last-usage";
import { loadPuzzleActivity, type PuzzleActivity } from "./puzzle-activity";
import { hasSeenSql, insertPuzzle, puzzleAnswers, type NewPuzzleContent } from "./puzzle-store";

const MAX_FILTER_PLAYERS = 500;

const puzzleContentSchema = z.discriminatedUnion("type", [manualPuzzleSchema, characterPuzzleSchema, imagePuzzleSchema]);
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
  type: z.enum(["riddle", "character_puzzle", "image_submission"]).optional(),
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
  type: "riddle" | "character_puzzle" | "image_submission";
  name: string | null;
  prompt: string;
  acceptedAnswers: string[];
  hint: string | null;
  hintCostPoints: number | null;
  maxImages: number | null;
  promptImageUrl: string | null;
  promptImagePath: string | null;
  difficulty: string;
  status: "draft" | "active" | "retired";
  createdAt: string;
  createdBy: string | null;
  createdByName: string | null;
  timesUsed: number;
  stats: PuzzleStats;
  lastUsage: LastUsage | null;
  activity?: PuzzleActivity;
}

const EMPTY_STATS: PuzzleStats = {
  daysUsed: 0, assigned: 0, started: 0, finished: 0, solved: 0, missed: 0,
  solveRate: null, medianSolveSeconds: null, averageAttempts: null,
};

function hintOf(puzzle: { hint?: string; hint_cost_points?: number }): Pick<NewPuzzleContent, "hint"> {
  return puzzle.hint === undefined || puzzle.hint_cost_points === undefined
    ? {}
    : { hint: { text: puzzle.hint, costPoints: puzzle.hint_cost_points } };
}

function toContent(puzzle: PuzzleContentInput): NewPuzzleContent {
  if (puzzle.type === "riddle") {
    return {
      type: "riddle",
      prompt: puzzle.prompt,
      config: {},
      answerData: { accepted: puzzle.accepted_answers },
      ...hintOf(puzzle),
    };
  }
  if (puzzle.type === "image_submission") {
    return {
      type: "image_submission",
      prompt: puzzle.prompt,
      config: {
        max_images: MAX_IMAGES,
        ...(puzzle.prompt_image_path ? { prompt_image_path: puzzle.prompt_image_path } : {}),
      },
      answerData: {},
    };
  }
  const config: CharacterConfig = { target_length: puzzle.target.length, character_set: CHARACTER_SET };
  return {
    type: "character_puzzle",
    prompt: "Letter game",
    config,
    answerData: { target: puzzle.target },
    ...hintOf(puzzle),
  };
}

// Missed days carry no play, so they stay out of every rate.
async function loadStats(client: PoolClient, puzzleIds: string[]): Promise<Map<string, PuzzleStats>> {
  if (puzzleIds.length === 0) return new Map();
  const { rows } = await client.query(
    `with plays as (
       select c.puzzle_id, s.submitted_at, s.correct, s.attempts, s.time_taken_ms,
              coalesce(s.scoring_breakdown @> '{"missed": true}', false) as missed,
              coalesce(s.scoring_breakdown @> '{"outcome": "partial"}', false) as partial
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
              count(*) filter (where not missed and not partial and submitted_at is not null and correct)::int as solved,
              count(*) filter (where missed)::int as missed,
              percentile_cont(0.5) within group (order by time_taken_ms)
                filter (where not missed and not partial and submitted_at is not null and correct) as median_ms,
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

interface StoredScoringPolicy {
  base_points: number;
  failure_penalty_points?: number;
  speed_bonuses?: Array<{ under_ms: number; points: number }>;
}

async function loadLastUsage(client: PoolClient, puzzleIds: string[]): Promise<Map<string, LastUsage>> {
  if (puzzleIds.length === 0) return new Map();
  const { rows } = await client.query(
    `select distinct on (c.puzzle_id)
            c.puzzle_id, d.active_date::text as active_date, c.time_limit_seconds, c.max_attempts, c.scoring_policy
     from challenges c join daily_challenges d on d.id = c.daily_challenge_id
     where c.puzzle_id = any($1::uuid[])
     order by c.puzzle_id, d.active_date desc, c.created_at desc`,
    [puzzleIds],
  );
  return new Map(rows.map((row) => {
    const policy = row.scoring_policy as StoredScoringPolicy;
    return [row.puzzle_id as string, {
      activeDate: row.active_date as string,
      timeLimitSeconds: row.time_limit_seconds === null ? null : Number(row.time_limit_seconds),
      maxAttempts: Number(row.max_attempts),
      basePoints: policy.base_points,
      failurePenaltyPoints: policy.failure_penalty_points ?? 0,
      speedBonuses: (policy.speed_bonuses ?? []).map((tier) => ({ underMs: tier.under_ms, points: tier.points })),
    }];
  }));
}

function imageConfigOf(row: Record<string, unknown>) {
  if (row.type !== "image_submission") return null;
  const parsed = imageConfigSchema.safeParse(row.config);
  return parsed.success ? parsed.data : null;
}

function toBankPuzzle(
  row: Record<string, unknown>,
  stats: PuzzleStats | undefined,
  lastUsage: LastUsage | undefined,
  imageUrls: Map<string, string>,
): BankPuzzle {
  const image = imageConfigOf(row);
  return {
    id: row.id as string,
    type: row.type as BankPuzzle["type"],
    name: (row.name as string | null) ?? null,
    prompt: row.prompt as string,
    acceptedAnswers: puzzleAnswers(row.answer_data as { accepted?: unknown; target?: unknown }),
    hint: (row.hint as string | null) ?? null,
    hintCostPoints: (row.hint_cost_points as number | null) ?? null,
    maxImages: image?.max_images ?? null,
    promptImagePath: image?.prompt_image_path ?? null,
    promptImageUrl: image?.prompt_image_path ? (imageUrls.get(image.prompt_image_path) ?? null) : null,
    difficulty: row.difficulty as string,
    status: row.status as BankPuzzle["status"],
    createdAt: new Date(row.created_at as string).toISOString(),
    createdBy: (row.created_by as string | null) ?? null,
    createdByName: (row.created_by_name as string | null) ?? null,
    timesUsed: row.times_used as number,
    stats: stats ?? EMPTY_STATS,
    lastUsage: lastUsage ?? null,
  };
}

async function signPromptImages(rows: Array<Record<string, unknown>>) {
  const paths = rows.flatMap((row) => {
    const path = imageConfigOf(row)?.prompt_image_path;
    return path ? [path] : [];
  });
  return signPuzzleImages(paths);
}

const PUZZLE_COLUMNS = `pz.id, pz.type, pz.name, pz.prompt, pz.config, pz.answer_data, pz.hint, pz.hint_cost_points, pz.difficulty, pz.status, pz.created_at, pz.created_by,
  (select coalesce(p.display_name, p.name) from profiles p where p.id = pz.created_by) as created_by_name,
  (select count(*)::int from challenges c where c.puzzle_id = pz.id) as times_used`;

async function loadOne(client: PoolClient, id: string): Promise<BankPuzzle> {
  const { rows } = await client.query(`select ${PUZZLE_COLUMNS} from puzzles pz where pz.id = $1`, [id]);
  if (!rows[0]) throw new NotFoundError("Puzzle not found");
  const stats = await loadStats(client, [id]);
  const lastUsage = await loadLastUsage(client, [id]);
  return toBankPuzzle(rows[0], stats.get(id), lastUsage.get(id), await signPromptImages(rows));
}

const FROZEN_MESSAGE = "This puzzle has been scheduled, so its content can no longer change. Retire it instead.";
const ACTIVE_MESSAGE = "An active puzzle's content cannot change. Move it to draft first.";

// A prompt image path embeds its uploader, so an account can only attach files it uploaded itself.
async function requireOwnPromptImage(
  client: PoolClient,
  puzzle: PuzzleContentInput,
  accountId: string,
  existingPath: string | null,
) {
  if (puzzle.type !== "image_submission" || !puzzle.prompt_image_path) return;
  if (puzzle.prompt_image_path === existingPath) return;
  if (puzzle.prompt_image_path.split("/")[1] !== accountId) {
    throw new BadRequestError("Upload the prompt image from your own account");
  }
  const { rows } = await client.query(
    "select 1 from puzzles where config->>'prompt_image_path' = $1 limit 1",
    [puzzle.prompt_image_path],
  );
  if (rows[0]) throw new BadRequestError("That prompt image is already used by another puzzle");
}

// A shared object is kept until its last referencing puzzle is gone.
async function removeUnreferencedPromptImage(path: string) {
  const { rows } = await withTransaction((client) =>
    client.query("select 1 from puzzles where config->>'prompt_image_path' = $1 limit 1", [path]));
  if (!rows[0]) await removePuzzleImages([path]);
}

export async function uploadPromptImage(rawFile: unknown): Promise<{ path: string; url: string | null }> {
  const uploader = await withTransaction((client) => requirePuzzleBankRead(client));
  const image = await readImageFile(rawFile, "Prompt image");
  const path = newPromptImagePath(uploader.id, image.extension);
  await uploadPuzzleImage(path, image);
  const urls = await signPuzzleImages([path]);
  return { path, url: urls.get(path) ?? null };
}

// Removes an upload that never became part of a puzzle. A path any puzzle uses, or one uploaded by
// someone else, is left alone, so a saved prompt can never be deleted through this.
export async function discardPromptImage(rawPath: unknown): Promise<{ removed: boolean }> {
  const path = await withTransaction(async (client) => {
    const actor = await requirePuzzleBank(client);
    const candidate = z.string().max(300).parse(rawPath);
    if (!isPromptImagePath(candidate) || candidate.split("/")[1] !== actor.id) {
      throw new BadRequestError("Not one of your prompt image uploads");
    }
    const { rows } = await client.query(
      "select 1 from puzzles where config->>'prompt_image_path' = $1 limit 1",
      [candidate],
    );
    return rows[0] ? null : candidate;
  });
  if (path === null) return { removed: false };
  await removePuzzleImages([path]);
  return { removed: true };
}

export async function createPuzzle(input: LazyInput): Promise<BankPuzzle> {
  return withTransaction(async (client) => {
    const author = await requirePuzzleBank(client);
    const parsed = createPuzzleInput.parse(await resolveInput(input));
    if (author.role === "spectator" && parsed.status !== "draft") {
      throw new ForbiddenError("Spectators can only create drafts");
    }
    await requireOwnPromptImage(client, parsed.puzzle, author.id, null);
    const id = await insertPuzzle(client, author.id, toContent(parsed.puzzle), parsed.difficulty, parsed.name ?? null, parsed.status);
    return loadOne(client, id);
  });
}

export async function listPuzzles(filter: LazyInput): Promise<BankPuzzle[]> {
  return withTransaction(async (client) => {
    await requirePuzzleBankRead(client);
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
    const ids = rows.map((row) => row.id as string);
    const stats = await loadStats(client, ids);
    const lastUsage = await loadLastUsage(client, ids);
    const imageUrls = await signPromptImages(rows);
    return rows.map((row) => toBankPuzzle(row, stats.get(row.id as string), lastUsage.get(row.id as string), imageUrls));
  });
}

export async function getPuzzle(id: unknown): Promise<BankPuzzle> {
  return withTransaction(async (client) => {
    await requirePuzzleBankRead(client);
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
  let replacedImagePath: string | null = null;
  try {
    const updated = await withTransaction(async (client) => {
      const editor = await requirePuzzleBank(client);
      const id = idSchema.parse(rawId);
      const parsed = updatePuzzleInput.parse(await resolveInput(input));
      const { rows } = await client.query("select type, status, config from puzzles where id = $1 for update", [id]);
      if (!rows[0]) throw new NotFoundError("Puzzle not found");
      const previousImagePath = imageConfigOf(rows[0])?.prompt_image_path ?? null;
      if (parsed.puzzle) await requireOwnPromptImage(client, parsed.puzzle, editor.id, previousImagePath);
      if (editor.role === "spectator") {
        if (parsed.status !== undefined) throw new ForbiddenError("Spectators cannot change a puzzle's status");
        if (rows[0].status !== "draft") throw new ForbiddenError("Spectators can only edit drafts");
      }
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
      const nextImagePath = content && "prompt_image_path" in content.config
        ? (content.config as { prompt_image_path: string }).prompt_image_path
        : null;
      if (content && previousImagePath && previousImagePath !== nextImagePath) {
        replacedImagePath = previousImagePath;
      }
      await client.query(
        `update puzzles set
           prompt = coalesce($2, prompt),
           config = coalesce($3::jsonb, config),
           answer_data = coalesce($4::jsonb, answer_data),
           difficulty = coalesce($5, difficulty),
           status = coalesce($6, status),
           name = case when $7::boolean then $8 else name end,
           hint = case when $9::boolean then $10 else hint end,
           hint_cost_points = case when $9::boolean then $11::int else hint_cost_points end
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
          content !== null,
          content?.hint?.text ?? null,
          content?.hint?.costPoints ?? null,
        ],
      );
      return loadOne(client, id);
    });
    if (replacedImagePath) await removeUnreferencedPromptImage(replacedImagePath);
    return updated;
  } catch (error) {
    return frozenConflict(error);
  }
}

export async function deletePuzzle(rawId: unknown): Promise<{ id: string }> {
  try {
    const deleted = await withTransaction(async (client) => {
      const actor = await requirePuzzleBank(client);
      const id = idSchema.parse(rawId);
      const { rows } = await client.query("select config, status, created_by from puzzles where id = $1 for update", [id]);
      if (!rows[0]) throw new NotFoundError("Puzzle not found");
      if (actor.role === "spectator" && (rows[0].status !== "draft" || rows[0].created_by !== actor.id)) {
        throw new ForbiddenError("Spectators can only delete their own drafts");
      }
      await client.query("delete from puzzles where id = $1", [id]);
      return { id, imagePath: (rows[0].config as { prompt_image_path?: unknown })?.prompt_image_path };
    });
    if (typeof deleted.imagePath === "string") await removeUnreferencedPromptImage(deleted.imagePath);
    return { id: deleted.id };
  } catch (error) {
    return frozenConflict(error);
  }
}
