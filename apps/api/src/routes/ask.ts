import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { ASK_CONTRACT_VERSION, type AskCapabilities } from "@sr/shared";
import { readAskSettings, type AskSettings } from "../config.js";
import { requireAuth, type AuthUser } from "../plugins/auth.js";
import { AskFailure } from "../services/ask/errors.js";
import { AskStore, type AskAdmission } from "../services/ask/store.js";

export interface AskRoutesOptions {
  /** Trusted per-instance settings for independent deployment HTTP tests. */
  settings?: AskSettings;
  /** Installed only by the budget slice. No default financial bypass. */
  admit?: AskAdmission;
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
        if (!(error instanceof AskFailure)) throw error;
        return reply
          .status(error.statusCode)
          .send({ code: error.code, message: error.message, statusCode: error.statusCode });
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
    if (!requireAuth(request, reply)) return reply;
    const result: AskCapabilities = {
      contractVersion: ASK_CONTRACT_VERSION,
      enabled: true,
      acceptingQuestions: Boolean(opts.admit) && !settings.problem,
    };
    return result;
  });

  app.get(
    "/api/ask/chats",
    personal((request, { me, store }) => store.listChats(me.id, request.query)),
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
      if (!opts.admit || settings.problem) throw new AskFailure("ASK_UNAVAILABLE");
      return store.submit(
        me.id,
        me.sessionId,
        uuid((request.params as { id: unknown }).id),
        request.body,
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
