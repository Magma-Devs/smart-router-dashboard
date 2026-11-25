import type { FastifyInstance, FastifyReply } from "fastify";
import type { Database } from "@sr/db";
import {
  UNNAMEABLE_CUSTOMERS,
  isNameableCustomerId,
  parseCustomerName,
  type CustomerNamesResponse,
  type CustomerRow,
  type CustomersResponse,
} from "@sr/shared";
import { requireRole } from "../plugins/auth.js";
import {
  clearCustomerName,
  listCustomerNames,
  readCustomerNames,
  setCustomerName,
} from "../services/customer-names.js";

/** How many ids `GET /api/customers` lists at most, busiest first. */
export const MAX_LISTED_CUSTOMERS = 1000;

/**
 * Requests per caller's customer-id over the last day, the routers' own
 * counter with the reserved values left out. Ask's customers summary reads the
 * same counter over the same longest window.
 */
export const CUSTOMER_REQUESTS_24H = `round(sum by (customer) (increase(smartrouter_customer_requests_total{customer!~${JSON.stringify(UNNAMEABLE_CUSTOMERS.join("|"))}}[24h])))`;

function badRequest(reply: FastifyReply, message: string) {
  return reply.code(400).send({ statusCode: 400, error: "Bad Request", message });
}

/**
 * The names a deployment's admins give its callers' customer-ids (MAG-5764).
 * Registered with accounts only: the names live in the accounts database.
 * Every member reads them; an admin sets and clears them.
 */
export async function customerRoutes(app: FastifyInstance) {
  function dbOr503(reply: FastifyReply): Database | null {
    if (!app.db) {
      void reply
        .code(503)
        .send({
          statusCode: 503,
          error: "Service Unavailable",
          message: "auth database not ready",
        });
      return null;
    }
    return app.db;
  }

  /** Requests per counted id, or null when the store does not answer. */
  async function countedIds(): Promise<Map<string, number> | null> {
    const samples = await app.prom.queryAtOrNull(
      CUSTOMER_REQUESTS_24H,
      Math.floor(Date.now() / 1000),
    );
    if (!samples) return null;
    const counts = new Map<string, number>();
    for (const sample of samples) {
      const id = sample.metric.customer;
      const value = Number(sample.value[1]);
      if (id && isNameableCustomerId(id) && Number.isFinite(value)) counts.set(id, value);
    }
    return counts;
  }

  app.get(
    "/api/customers/names",
    async (request, reply): Promise<CustomerNamesResponse | FastifyReply> => {
      if (!requireRole(request, reply, "read_only")) return reply;
      const db = dbOr503(reply);
      if (!db) return reply;
      reply.header("Cache-Control", "no-store");
      return { names: Object.fromEntries(await readCustomerNames(db)) };
    },
  );

  app.get("/api/customers", async (request, reply): Promise<CustomersResponse | FastifyReply> => {
    if (!requireRole(request, reply, "read_only")) return reply;
    const db = dbOr503(reply);
    if (!db) return reply;
    reply.header("Cache-Control", "no-store");
    const [named, counts] = await Promise.all([listCustomerNames(db), countedIds()]);
    const rows = new Map<string, CustomerRow>();
    for (const [id, requests] of counts ?? [])
      rows.set(id, { id, name: null, requests, changedAt: null });
    for (const row of named)
      rows.set(row.customer, {
        id: row.customer,
        name: row.name,
        requests: counts?.get(row.customer) ?? null,
        changedAt: row.changedAt.toISOString(),
      });
    const customers = [...rows.values()]
      .sort((a, b) => (b.requests ?? -1) - (a.requests ?? -1) || a.id.localeCompare(b.id))
      .slice(0, MAX_LISTED_CUSTOMERS);
    return { window: "24h", customers, requestsUnavailable: counts === null };
  });

  // The id travels in the body: it may hold `/`, which a path cannot carry through every proxy.
  app.post("/api/customers/name", async (request, reply) => {
    const admin = requireRole(request, reply, "admin");
    if (!admin) return reply;
    const db = dbOr503(reply);
    if (!db) return reply;
    const body = (request.body ?? {}) as { customer?: unknown; name?: unknown };
    if (!isNameableCustomerId(body.customer))
      return badRequest(
        reply,
        "customer is a customer-id the routers count, not one of their own values.",
      );
    const customer = body.customer;
    const onViolation = (violation: unknown) =>
      request.log.error({ audit: violation }, "audit event violated the catalog");
    if (body.name === null) {
      await clearCustomerName(db, { customer, actorId: admin.id, onViolation });
      return { customer, name: null };
    }
    const parsed = parseCustomerName(body.name);
    if (!parsed.ok) return badRequest(reply, parsed.problem);
    const counts = await countedIds();
    const result = await setCustomerName(db, {
      customer,
      name: parsed.name,
      actorId: admin.id,
      onViolation,
      otherIds: counts?.keys(),
    });
    if (!result.ok)
      return reply.code(409).send({
        statusCode: 409,
        error: "Conflict",
        message:
          result.reason === "name-taken"
            ? `Another customer-id is already named "${parsed.name}".`
            : `"${parsed.name}" is a customer-id itself, so it cannot be a name.`,
      });
    return { customer, name: parsed.name };
  });
}
