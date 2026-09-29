import { z } from "zod";

export const playerUsernameInput = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9_-]{2,31}$/i, "Use 3–32 letters, numbers, underscores, or hyphens.");

export function parsePlayerUsernameDisplay(value: string) {
  return playerUsernameInput.parse(value);
}

export function parsePlayerUsername(value: string) {
  return parsePlayerUsernameDisplay(value).toLowerCase();
}

export function playerUsernameEmail(value: string) {
  return `${parsePlayerUsername(value)}@players.riddletime.invalid`;
}
