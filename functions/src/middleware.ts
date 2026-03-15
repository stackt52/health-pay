import type { Request, Response, NextFunction } from "express";
import * as logger from "firebase-functions/logger";
import { v4 as uuidv4 } from "uuid";
import { AppError } from "./types.js";

// Augment Express Request to carry correlationId
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      correlationId: string;
    }
  }
}

/** Attaches a correlation ID to every request for distributed tracing. */
export function correlationMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const correlationId =
    (req.headers["x-correlation-id"] as string | undefined) ?? uuidv4();
  req.correlationId = correlationId;
  res.setHeader("x-correlation-id", correlationId);
  next();
}

/** Structured JSON request logger. Sensitive fields are never logged. */
export function requestLogger(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  logger.info("Incoming request", {
    method: req.method,
    path: req.path,
    correlationId: req.correlationId,
  });
  next();
}

/** Central error handler — converts AppError and unknown errors to structured JSON. */
export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  // Express requires the 4-arg signature even when _next is unused
  _next: NextFunction,
): void {
  const correlationId = req.correlationId ?? "unknown";

  if (err instanceof AppError) {
    logger.warn("Application error", {
      code: err.code,
      statusCode: err.statusCode,
      correlationId,
    });
    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        correlationId,
        ...(err.details !== undefined ? { details: err.details } : {}),
      },
    });
    return;
  }

  // Never expose internal details or stack traces in API responses
  logger.error("Unhandled error", {
    message: err.message,
    correlationId,
  });

  res.status(500).json({
    error: {
      code: "INTERNAL_ERROR",
      message: "An unexpected error occurred. Please try again.",
      correlationId,
    },
  });
}
