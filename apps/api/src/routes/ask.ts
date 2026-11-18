import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  ASK_CONTRACT_VERSION,
  askSubmitSchema,
  askSwitchSchema,
  roleAtLeast,
  type AskCapabilities,
} from "@sr/shared";
import { readAskSettings, type AskSettings } from "../config.js";
import { requireAuth, requireRole, type AuthUser } from "../plugins/auth.js";
import { redactAskText } from "../services/ask/redact.js";
import { AskFailure } from "../services/ask/errors.js";
import { AskStore, type AskAdmission } from "../services/ask/store.js";
import { readAskSwitch, setAskSwitch } from "../services/ask/switch.js";

export interface AskRoutesOptions {
  /** Trusted per-instance settings for independent deployment HTTP tests. */
  settings?: AskSettings;
  /** Installed only by the budget slice. No default financial bypass. */
  admit?: AskAdmission;
  ready?: () => boolean;
  /** Tells this replica's runtime the switch an admin just set. */
  switched?: (off: boolean) => void;
}
interface Context {
  me: AuthUser;
  settings: AskSettings;
  store: AskStore;
}
function uuid(value: unknown): string {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success) throw new AskFailure("ASK_INVALID_REQUEST", 400);
  return parsed.data;
}

/** Current-session/customer/deployment checks cover every personal path.
 * No route invokes a provider; submission requires installed budget admission. */
export async function askRoutes(app: FastifyInstance, opts: AskRoutesOptions = {}): Promise<void> {
  app.setChildLoggerFactory((logger, bindings, options) =>
    logger.child(bindings, {
      ...options,
      serializers: {
        ...options.serializers,
        req: (request: FastifyRequest) => ({
          method: request.method,
          url: request.url.split("?")[0],
        }),
      },
    }),
  );
  const settingsOf = () => opts.settings ?? readAskSettings();
  const personal =
    (work: (request: FastifyRequest, context: Context) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      reply.header("Cache-Control", "no-store");
      try {
        const settings = settingsOf();
        if (!settings.enabled) throw new AskFailure("ASK_DISABLED", 404);
        const me = requireAuth(request, reply);
        if (!me) return reply;
        if (!app.db) throw new AskFailure("ASK_UNAVAILABLE");
        return await work(request, {
          me,
          settings,
          store: new AskStore(app.db, settings.customerId, settings.retentionDays),
        });
      } catch (error) {
        // ORM errors can contain bound prompt/answer values. Keep them out of
        // global application logs, which have a different retention boundary.
        if (!(error instanceof AskFailure))
          request.log.error({ code: "ASK_STORAGE_UNAVAILABLE" }, "Ask storage request failed");
        const failure = error instanceof AskFailure ? error : new AskFailure("ASK_UNAVAILABLE");
        return reply
          .status(failure.statusCode)
          .send({ code: failure.code, message: failure.message, statusCode: failure.statusCode });
      }
    };

  app.get("/api/ask/capabilities", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const settings = settingsOf();
    if (!settings.enabled) {
      const error = new AskFailure("ASK_DISABLED", 404);
      return reply
        .status(error.statusCode)
        .send({ code: error.code, message: error.message, statusCode: error.statusCode });
    }
    const me = requireAuth(request, reply);
    if (!me) return reply;
    let off = false;
    let switchKnown = Boolean(app.db);
    try {
      if (app.db) off = await readAskSwitch(app.db, settings.customerId);
    } catch {
      switchKnown = false;
    }
    const result: AskCapabilities = {
      contractVersion: ASK_CONTRACT_VERSION,
      enabled: true,
      scopeId: createHash("sha256")
        .update(JSON.stringify([settings.customerId, me.id]))
        .digest("hex"),
      acceptingQuestions:
        Boolean(opts.admit) && (opts.ready?.() ?? true) && !settings.problem && switchKnown && !off,
      off,
      canSwitch: roleAtLeast(me.role, "admin"),
    };
    return result;
  });

  // An admin turns Ask off for everyone, or back on. It changes no deployment
  // setting: Ask also needs the deployment flag, its credentials and budget.
  app.post("/api/ask/switch", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const fail = (failure: AskFailure) =>
      reply
        .status(failure.statusCode)
        .send({ code: failure.code, message: failure.message, statusCode: failure.statusCode });
    const settings = settingsOf();
    if (!settings.enabled) return fail(new AskFailure("ASK_DISABLED", 404));
    const admin = requireRole(request, reply, "admin");
    if (!admin) return reply;
    if (!app.db) return fail(new AskFailure("ASK_UNAVAILABLE"));
    const parsed = askSwitchSchema.safeParse(request.body);
    if (!parsed.success) return fail(new AskFailure("ASK_INVALID_REQUEST", 400));
    try {
      await setAskSwitch(app.db, settings.customerId, parsed.data.off, admin.id, (violation) =>
        request.log.error({ audit: violation }, "audit event violated the catalog"),
      );
    } catch {
      request.log.error({ code: "ASK_SWITCH_FAILED" }, "Ask switch could not be saved");
      return fail(new AskFailure("ASK_UNAVAILABLE"));
    }
    opts.switched?.(parsed.data.off);
    return { off: parsed.data.off };
  });

  app.get(
    "/api/ask/chats",
    personal((request, { me, store }) => store.listChats(me.id, request.query)),
  );
  // Search text stays in the body, away from browser/ingress URL logs.
  app.post(
    "/api/ask/chats/search",
    personal((request, { me, store }) => store.listChats(me.id, request.body)),
  );
  app.post(
    "/api/ask/chats",
    personal(async (request, { me, store }) => {
      if (request.body !== undefined && !z.object({}).strict().safeParse(request.body).success)
        throw new AskFailure("ASK_INVALID_REQUEST", 400);
      return store.createChat(me.id);
    }),
  );
  app.get(
    "/api/ask/chats/:id",
    personal((request, { me, store }) => {
      const parsed = z
        .object({ before: z.string().max(512).optional() })
        .strict()
        .safeParse(request.query);
      if (!parsed.success) throw new AskFailure("ASK_INVALID_REQUEST", 400);
      return store.chatDetail(
        me.id,
        uuid((request.params as { id: unknown }).id),
        parsed.data.before,
      );
    }),
  );
  app.post(
    "/api/ask/chats/:id/runs",
    personal((request, { me, store, settings }) => {
      if (!opts.admit || settings.problem || !(opts.ready?.() ?? true))
        throw new AskFailure("ASK_UNAVAILABLE");
      return store.submit(
        me.id,
        me.sessionId,
        uuid((request.params as { id: unknown }).id),
        (() => {
          const parsed = askSubmitSchema.safeParse(request.body);
          if (!parsed.success) throw new AskFailure("ASK_INVALID_REQUEST", 400);
          return {
            ...parsed.data,
            question: redactAskText(parsed.data.question, [
              settings.mcpToken,
              settings.bedrockToken,
            ]),
          };
        })(),
        opts.admit,
      );
    }),
  );
  app.get(
    "/api/ask/runs/active",
    personal(async (_request, { me, store }) => ({ run: await store.activeRun(me.id) })),
  );
  app.get(
    "/api/ask/runs/:id",
    personal((request, { me, store }) =>
      store.getRun(me.id, uuid((request.params as { id: unknown }).id)),
    ),
  );
  app.post(
    "/api/ask/runs/:id/cancel",
    personal((request, { me, store }) =>
      store.cancel(me.id, uuid((request.params as { id: unknown }).id)),
    ),
  );
  app.get(
    "/api/ask/preferences",
    personal((_request, { me, store }) => store.preferences(me.id)),
  );
  app.patch(
    "/api/ask/preferences",
    personal((request, { me, store }) => store.savePreferences(me.id, request.body)),
  );
}
