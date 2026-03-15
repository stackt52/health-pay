import { setGlobalOptions } from "firebase-functions";
import { onRequest } from "firebase-functions/https";
import { createApp } from "./app.js";

// Cost control: limit concurrent containers globally
setGlobalOptions({ maxInstances: 10 });

const expressApp = createApp();

/**
 * Main HTTP entry point.
 * All API routes are served under /api/** via the Express app.
 * Firebase Hosting rewrites /api/** to this function.
 */
export const api = onRequest(expressApp);
