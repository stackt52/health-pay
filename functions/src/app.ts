import express from "express";
import cors from "cors";
import {
  correlationMiddleware,
  requestLogger,
  errorHandler,
} from "./middleware.js";
import claimsRouter from "./routes/claims.js";
import providersRouter from "./routes/providers.js";
import seedRouter from "./routes/seed.js";

export function createApp(): express.Application {
  const app = express();

  // ─── Global middleware ──────────────────────────────────────────────────────
  app.use(cors());
  app.use(express.json({ limit: "1mb" }));
  app.use(correlationMiddleware);
  app.use(requestLogger);

  // ─── Routes ─────────────────────────────────────────────────────────────────
  app.use("/api/claims", claimsRouter);
  app.use("/api/providers", providersRouter);
  app.use("/api/seed", seedRouter);

  // Health check — useful for Cloud Run / uptime monitors
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", service: "healthpay-claims-api" });
  });

  // ─── 404 catch-all ──────────────────────────────────────────────────────────
  app.use((_req, res) => {
    res.status(404).json({
      error: {
        code: "NOT_FOUND",
        message: "The requested endpoint does not exist.",
      },
    });
  });

  // ─── Central error handler (must be last) ───────────────────────────────────
  app.use(errorHandler);

  return app;
}
