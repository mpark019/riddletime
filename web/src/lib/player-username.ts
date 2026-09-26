import { z } from "zod";

export const playerUsernameInput = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9_-]{2,31}$/, "Use 3–32 letters, numbers, underscores, or hyphens.");

export function parsePlayerUsername(value: string) {
  return playerUsernameInput.parse(value);
}

export function playerUsernameEmail(value: string) {
  return `${parsePlayerUsername(value)}@players.riddletime.invalid`;
}
