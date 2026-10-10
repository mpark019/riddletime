import "server-only";
import type { PoolClient } from "pg";
import { BadRequestError, ConflictError } from "@/server/http/errors";

export type PuzzleType = "riddle" | "character_puzzle" | "image_submission";
export type PuzzleStatus = "draft" | "active" | "retired";

export interface NewPuzzleContent {
  type: PuzzleType;
  prompt: string;
  config: object;
  answerData: object;
}

export interface PuzzleSource {
  puzzleId: string;
  type: PuzzleType;
}

// A shared day counts as seen by every player whose account existed when that day ended.
export function hasSeenSql(puzzleId: string, playerId: string, playerCreatedAt: string): string {
  return `exists (
    select 1 from challenges c
    join daily_challenges d on d.id = c.daily_challenge_id
    where c.puzzle_id = ${puzzleId}
      and (c.assigned_to = ${playerId}
           or (c.mode = 'shared'
               and ${playerCreatedAt} < riddle_private.day_end(d.active_date, current_setting('timezone'))))
  )`;
}

export function puzzleAnswers(answerData: { accepted?: unknown; target?: unknown } | null): string[] {
  if (Array.isArray(answerData?.accepted)) return answerData.accepted as string[];
  return typeof answerData?.target === "string" ? [answerData.target] : [];
}

export async function insertPuzzle(
  client: PoolClient,
  adminId: string,
  content: NewPuzzleContent,
  difficulty: string,
  name: string | null,
  status: PuzzleStatus,
): Promise<string> {
  const { rows } = await client.query(
    `insert into puzzles (type, name, prompt, config, answer_data, difficulty, status, created_by)
     values ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8)
     returning id`,
    [
      content.type, name, content.prompt, JSON.stringify(content.config), JSON.stringify(content.answerData),
      difficulty, status, adminId,
    ],
  );
  return rows[0].id as string;
}

// A lock that conflicts with itself, so concurrent choosers of one puzzle run one at a time and
// the repeat check below sees the winner's challenge.
async function lockSchedulablePuzzle(client: PoolClient, puzzleId: string, type: PuzzleType) {
  const { rows } = await client.query(
    "select type, status from puzzles where id = $1 for no key update",
    [puzzleId],
  );
  const puzzle = rows[0];
  if (!puzzle) throw new BadRequestError("Puzzle not found");
  if (puzzle.status !== "active") throw new BadRequestError(`That puzzle is ${puzzle.status}, so it cannot be scheduled`);
  if (puzzle.type !== type) throw new BadRequestError("That puzzle is not an allowed type for this date");
}

export async function resolveSharedPuzzle(client: PoolClient, source: PuzzleSource): Promise<string> {
  await lockSchedulablePuzzle(client, source.puzzleId, source.type);
  const { rows } = await client.query(
    "select 1 from challenges where puzzle_id = $1 limit 1",
    [source.puzzleId],
  );
  if (rows[0]) throw new ConflictError("That puzzle has already been scheduled");
  return source.puzzleId;
}

export async function resolvePersonalPuzzle(
  client: PoolClient,
  source: PuzzleSource,
  playerIds: string[],
): Promise<string> {
  await lockSchedulablePuzzle(client, source.puzzleId, source.type);
  const { rows } = await client.query(
    `select p.display_name
     from profiles p
     where p.id = any($2::uuid[]) and ${hasSeenSql("$1::uuid", "p.id", "p.created_at")}
     order by lower(p.display_name)`,
    [source.puzzleId, playerIds],
  );
  if (rows.length > 0) {
    const names = rows.map((row) => row.display_name as string).join(", ");
    throw new ConflictError(`Already given that puzzle: ${names}`);
  }
  return source.puzzleId;
}
