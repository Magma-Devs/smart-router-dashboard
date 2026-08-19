import type { FastifyInstance, FastifyReply } from "fastify";
import {
  createAuditWriter,
  listAuditTokens,
  mintAuditToken,
  revokeAuditToken,
  type Database,
} from "@sr/db";
import { requireRole } from "../plugins/auth.js";
import { sendApiError } from "../plugins/error-handler.js";

/**
 * Managing the audit log's read-only tokens — MAG-2770.
 *
 * Separate from the log's own routes because the permissions are opposite: the
 * log is readable by every role, while minting a credential that reads it is an
 * admin action. Keeping them in one file would put the two rules a few lines
 * apart and invite the wrong one being copied.
 *
 * **An audit token cannot reach any of this.** `auditTokenMayReach` excludes
 * `/api/audit/tokens` explicitly — a token able to mint another token would be
 * an escalation dressed as a read.
 */

interface CreateBody {
  name?: string;
}

const NAME_MAX = 120;

/** What a listing may say about a token: everything except the secret and its
 *  hash. There is nothing a caller can do with a hash but try to crack it. */
function publicToken(row: Awaited<ReturnType<typeof listAuditTokens>>[number]) {
  return {
    id: row.id,
    name: row.name,
    suffix: row.suffix,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdByName,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    lastUsedIp: row.lastUsedIp,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    revokedBy: row.revokedByName,
  };
}

export async function auditTokenRoutes(app: FastifyInstance) {
  function dbOr503(reply: FastifyReply): Database | null {
    if (!app.db) {
      void reply.code(503).send({
        statusCode: 503,
        error: "Service Unavailable",
        message: "audit database not ready",
      });
      return null;
    }
    return app.db;
  }

  app.get(
    "/api/audit/tokens",
    { schema: { tags: ["Audit"], summary: "List audit tokens (admin)" } },
    async (request, reply) => {
      if (!requireRole(request, reply, "admin")) return reply;
      const db = dbOr503(reply);
      if (!db) return reply;
      return { tokens: (await listAuditTokens(db)).map(publicToken) };
    },
  );

  app.post<{ Body: CreateBody }>(
    "/api/audit/tokens",
    {
      schema: {
        tags: ["Audit"],
        summary: "Create an audit token (admin) — the value is shown once",
        description:
          "Returns the full token exactly once. It is stored only as a SHA-256 hash, so it " +
          "cannot be shown again; if it is lost, revoke it and create another.",
        body: {
          type: "object" as const,
          required: ["name"],
          properties: {
            name: {
              type: "string" as const,
              minLength: 1,
              maxLength: NAME_MAX,
              description: 'What this token is for, e.g. "DFNS SIEM"',
            },
          },
        },
      },
    },
    async (request, reply) => {
      const admin = requireRole(request, reply, "admin");
      if (!admin) return reply;
      const db = dbOr503(reply);
      if (!db) return reply;

      const name = request.body?.name?.trim();
      if (!name) return sendApiError(reply, 400, "`name` is required");

      const minted = await mintAuditToken(db, {
        name,
        createdBy: admin.id,
        createdByName: admin.user.name ?? admin.email,
      });

      await createAuditWriter(db, {
        onViolation: (v) => request.log.error({ audit: v }, "audit event violated the catalog"),
      }).write({
        action: "apikey.created",
        actor: { id: admin.id, kind: "user" },
        target: { type: "audit_token", id: minted.row.id, name },
      });

      // 201 and the only sight of the secret anyone gets.
      return reply.code(201).send({ token: publicToken(minted.row), secret: minted.secret });
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/audit/tokens/:id",
    {
      schema: {
        tags: ["Audit"],
        summary: "Revoke an audit token (admin)",
        params: {
          type: "object" as const,
          required: ["id"],
          properties: { id: { type: "string" as const, format: "uuid" } },
        },
      },
    },
    async (request, reply) => {
      const admin = requireRole(request, reply, "admin");
      if (!admin) return reply;
      const db = dbOr503(reply);
      if (!db) return reply;

      const revoked = await revokeAuditToken(db, {
        id: request.params.id,
        revokedBy: admin.id,
        revokedByName: admin.user.name ?? admin.email,
      });
      // Already revoked, or never existed. Both are "it cannot be used", and
      // distinguishing them would confirm an id to someone guessing.
      if (!revoked) return sendApiError(reply, 404, "No such active audit token");

      await createAuditWriter(db, {
        onViolation: (v) => request.log.error({ audit: v }, "audit event violated the catalog"),
      }).write({
        action: "apikey.deleted",
        actor: { id: admin.id, kind: "user" },
        target: { type: "audit_token", id: revoked.id, name: revoked.name },
      });

      return { token: publicToken(revoked) };
    },
  );
}
