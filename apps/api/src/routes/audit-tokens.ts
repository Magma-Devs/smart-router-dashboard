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

/** Strict 8-4-4-4-12, not `format: "uuid"` — Ajv's format admits `urn:uuid:`
 *  prefixes and other variants that Postgres's uuid parser then 500s on. Same
 *  shape as the member routes. */
const ID_PARAMS = {
  type: "object" as const,
  required: ["id"],
  properties: {
    id: {
      type: "string" as const,
      pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
    },
  },
};

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
              description: 'What this token is for, e.g. "SIEM pull"',
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

      // One transaction: a token whose creation the log missed is exactly the
      // credential an audit of the audit system cannot explain. Inside a tx the
      // writer propagates failure, so no row means no token.
      const minted = await db.transaction(async (tx) => {
        const m = await mintAuditToken(tx, {
          name,
          createdBy: admin.id,
          createdByName: admin.user.name ?? admin.email,
        });
        await createAuditWriter(db, {
          onViolation: (v) => request.log.error({ audit: v }, "audit event violated the catalog"),
        }).write(
          {
            action: "apikey.created",
            actor: { id: admin.id, kind: "user" },
            target: { type: "audit_token", id: m.row.id, name },
          },
          tx,
        );
        return m;
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
        params: ID_PARAMS,
      },
    },
    async (request, reply) => {
      const admin = requireRole(request, reply, "admin");
      if (!admin) return reply;
      const db = dbOr503(reply);
      if (!db) return reply;

      // Same transaction rule as minting: the revocation and its row land
      // together, or neither does.
      const revoked = await db.transaction(async (tx) => {
        const row = await revokeAuditToken(tx, {
          id: request.params.id,
          revokedBy: admin.id,
          revokedByName: admin.user.name ?? admin.email,
        });
        if (!row) return null;
        await createAuditWriter(db, {
          onViolation: (v) => request.log.error({ audit: v }, "audit event violated the catalog"),
        }).write(
          {
            action: "apikey.deleted",
            actor: { id: admin.id, kind: "user" },
            target: { type: "audit_token", id: row.id, name: row.name },
          },
          tx,
        );
        return row;
      });
      // Already revoked, or never existed. Both are "it cannot be used", and
      // distinguishing them would confirm an id to someone guessing.
      if (!revoked) return sendApiError(reply, 404, "No such active audit token");

      return { token: publicToken(revoked) };
    },
  );
}
