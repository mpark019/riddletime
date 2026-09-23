import "server-only";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { AppError } from "./errors";

export function ok<T>(data: T, init?: ResponseInit) {
  return NextResponse.json(data, { ...init, status: init?.status ?? 200 });
}

// Only a recognized AppError's message reaches the client; anything else
// could leak internals, so it's logged and replaced with a generic message.
export function apiError(err: unknown) {
  if (err instanceof AppError) {
    return NextResponse.json(
      { error: err.message, code: err.code, ...err.details },
      { status: err.status },
    );
  }
  if (err instanceof ZodError) {
    return NextResponse.json(
      { error: "Invalid request body", code: "validation_error", issues: err.issues },
      { status: 400 },
    );
  }
  if (err instanceof SyntaxError) {
    return NextResponse.json(
      { error: "Malformed JSON body", code: "invalid_json" },
      { status: 400 },
    );
  }
  console.error(err);
  return NextResponse.json(
    { error: "Internal server error" },
    { status: 500 },
  );
}
