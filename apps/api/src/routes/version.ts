import type { FastifyInstance } from "fastify";
import { config } from "../config.js";

const startedAt = new Date().toISOString();

export async function versionRoutes(app: FastifyInstance) {
  app.get("/version", { schema: { tags: ["Version"], summary: "Build provenance" } }, async () => ({
    commit: config.build.commit,
    version: config.build.version,
    env: config.env,
    startedAt,
    uptimeSec: Math.floor(process.uptime()),
  }));
}
