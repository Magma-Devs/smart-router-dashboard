import type { FastifyInstance } from "fastify";
import { ASK_CONTRACT_VERSION, type AskCapabilities } from "@sr/shared";
import { readAskSettings } from "../config.js";
import { requireAuth } from "../plugins/auth.js";
import { AskFailure } from "../services/ask/errors.js";

/** The foundation has no route that can invoke a model or customer tool.
 * Paid submission arrives only with durable run/budget admission. */
export async function askRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/ask/capabilities", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const settings = readAskSettings();
    if (!settings.enabled) {
      const error = new AskFailure("ASK_DISABLED", 404);
      return reply
        .status(error.statusCode)
        .send({ code: error.code, message: error.message, statusCode: error.statusCode });
    }
    if (!requireAuth(request, reply)) return reply;
    const result: AskCapabilities = {
      contractVersion: ASK_CONTRACT_VERSION,
      enabled: true,
      acceptingQuestions: false,
    };
    return result;
  });
}
