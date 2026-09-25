export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Authentication required") {
    super(401, "unauthorized", message);
  }
}

export class BadRequestError extends AppError {
  constructor(message = "Invalid request") {
    super(400, "bad_request", message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Not permitted") {
    super(403, "forbidden", message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found") {
    super(404, "not_found", message);
  }
}

export class ConflictError extends AppError {
  constructor(message = "Conflict", details?: Record<string, unknown>) {
    super(409, "conflict", message, details);
  }
}
