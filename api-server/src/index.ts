import "dotenv/config";
import app from "./app";
import { logger } from "./lib/logger";
import { startBackgroundLearner, stopBackgroundLearner } from "./lib/backgroundLearnerService";

// Replit normally provides PORT, but default to 3000 so local/iPad/browser
// testing does not crash before the app starts.
const rawPort = process.env["PORT"] ?? "3000";
const port = Number(rawPort);

if (!Number.isFinite(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = app.listen(port, () => {
  logger.info({ port }, "Server listening");
  startBackgroundLearner();
});

server.on("error", (err) => {
  logger.error({ err }, "Error listening on port");
  process.exit(1);
});

process.on("SIGTERM", () => { stopBackgroundLearner(); server.close(() => process.exit(0)); });
process.on("SIGINT", () => { stopBackgroundLearner(); server.close(() => process.exit(0)); });
