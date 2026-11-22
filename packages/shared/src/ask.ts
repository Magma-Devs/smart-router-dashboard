import { z } from "zod";

/** Wire contract shared by the API, worker and both chat views. */
export const ASK_CONTRACT_VERSION = 1 as const;
export const ASK_LIMITS = Object.freeze({
  question: 4000,
  title: 120,
  summary: 500,
  sections: 8,
  sectionBody: 4000,
  points: 8,
  point: 500,
  evidence: 32,
  pageSize: 50,
});

const text = (max: number) => z.string().trim().min(1).max(max);
const uuid = z.uuid();
const instant = z.iso.datetime({ offset: true });
const token = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);

export const askErrorCodeSchema = z.enum([
  "ASK_DISABLED",
  "ASK_TURNED_OFF",
  "ASK_UNAVAILABLE",
  "ASK_NOT_FOUND",
  "ASK_INVALID_REQUEST",
  "ASK_CONFLICT",
  "ASK_ACTIVE_RUN",
  "ASK_BUDGET_LIMIT",
  "ASK_BUDGET_BUSY",
  "ASK_MCP_UNAVAILABLE",
  "ASK_IDENTITY_MISMATCH",
  "ASK_TOOL_DENIED",
  "ASK_BEDROCK_UNAVAILABLE",
  "ASK_INVALID_ANSWER",
  "ASK_TRUNCATED",
  "ASK_CANCELLED",
  "ASK_INTERRUPTED",
  "ASK_TIMEOUT",
  "ASK_LIMIT_REACHED",
]);
export type AskErrorCode = z.infer<typeof askErrorCodeSchema>;

/** Evidence is authored by the server from executed tools, never by the model. */
export const askEvidenceSchema = z
  .object({
    id: uuid,
    sourceId: token,
    operationId: token,
    observedAt: instant,
    from: instant.optional(),
    to: instant.optional(),
    coverage: z.enum(["complete", "partial", "empty", "unavailable", "unknown"]),
    truncated: z.boolean(),
  })
  .strict();
export type AskEvidence = z.infer<typeof askEvidenceSchema>;

/** The model returns only this presentation shape. Render all strings as text. */
export const askAnswerContentSchema = z
  .object({
    summary: text(ASK_LIMITS.summary),
    sections: z
      .array(
        z
          .object({
            title: text(ASK_LIMITS.title),
            body: text(ASK_LIMITS.sectionBody),
            points: z.array(text(ASK_LIMITS.point)).max(ASK_LIMITS.points).optional(),
            stat: z
              .object({
                value: text(80),
                label: text(120),
                tone: z.enum(["neutral", "good", "warn", "bad"]),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(ASK_LIMITS.sections),
  })
  .strict();
export type AskAnswerContent = z.infer<typeof askAnswerContentSchema>;
export const askAnswerSchema = askAnswerContentSchema
  .extend({
    contractVersion: z.literal(ASK_CONTRACT_VERSION),
    answeredAt: instant,
    evidence: z.array(askEvidenceSchema).max(ASK_LIMITS.evidence),
  })
  .strict();
export type AskAnswer = z.infer<typeof askAnswerSchema>;

export const askPageContextSchema = z
  .object({
    page: z.enum(["overview", "dashboard", "metrics", "upstreams", "ask"]),
    chain: token.optional(),
    /** Collector label scope and config identity are distinct router axes. */
    router: token.optional(),
    routerId: token.optional(),
    from: instant,
    to: instant,
  })
  .strict()
  .refine((v) => Date.parse(v.from) <= Date.parse(v.to), "Invalid time range");
export type AskPageContext = z.infer<typeof askPageContextSchema>;

export const askSubmitSchema = z
  .object({
    idempotencyKey: uuid,
    question: text(ASK_LIMITS.question),
    context: askPageContextSchema.optional(),
  })
  .strict();
export type AskSubmit = z.infer<typeof askSubmitSchema>;

export const askRunStatusSchema = z.enum([
  "queued",
  "running",
  "cancelling",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);
export type AskRunStatus = z.infer<typeof askRunStatusSchema>;

export interface AskChat {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}
export interface AskMessage {
  id: string;
  runId: string;
  role: "user" | "assistant";
  createdAt: string;
  question: string | null;
  answer: AskAnswer | null;
}
export interface AskRun {
  id: string;
  chatId: string;
  status: AskRunStatus;
  createdAt: string;
  completedAt: string | null;
  error: { code: AskErrorCode; message: string } | null;
  answer: AskAnswer | null;
  /** Only on `GET /api/ask/runs/active` while the run is running; an API
   * without it, or a run not yet started, has none. */
  progress?: AskRunProgress | null;
}
/**
 * Where a running answer is, read from the model turns and reads the run has
 * already recorded. `starting`: no model turn yet. `planning`: the first turn,
 * with no data read. `reading`: reads finished after the last turn ended.
 * `reviewing`: a turn after reads, which reads more or writes the answer.
 * `working`: a turn ended and nothing after it is recorded yet.
 */
export type AskRunStep = "starting" | "planning" | "reading" | "reviewing" | "working";
export interface AskRunRead {
  /** Server-authored from the operation and the series or streams it read,
   * never from the model's words or the data returned. */
  label: string;
  ok: boolean;
}
export interface AskRunProgress {
  step: AskRunStep;
  /** Every read the run has finished, oldest first. */
  reads: AskRunRead[];
}
export interface AskChatDetail {
  chat: AskChat;
  context: AskPageContext | null;
  messages: AskMessage[];
  activeRun: AskRun | null;
  runs: Array<Pick<AskRun, "id" | "status" | "error" | "completedAt">>;
  nextMessageCursor: string | null;
}
export interface AskChatPage {
  chats: AskChat[];
  nextCursor: string | null;
}
export interface AskCapabilities {
  contractVersion: typeof ASK_CONTRACT_VERSION;
  enabled: boolean;
  acceptingQuestions: boolean;
  /** An admin turned Ask off for everyone on this deployment. */
  off: boolean;
  /** The caller is an admin, who may turn Ask off and on. */
  canSwitch: boolean;
  /** Opaque customer/person cache scope; never an authorization grant. */
  scopeId: string;
}
/** An admin's request to turn Ask off for everyone, or back on. */
export const askSwitchSchema = z.object({ off: z.boolean() }).strict();
export type AskSwitch = z.infer<typeof askSwitchSchema>;
export const askPreferencesSchema = z
  .object({
    view: z.enum(["panel", "full"]),
    chatId: uuid.nullable(),
    /** A local path only. Query filters are reconstructed from typed page context. */
    returnTo: z.enum([
      "/overview",
      "/dashboard",
      "/metrics",
      "/upstreams",
      "/team",
      "/audit",
      "/account",
    ]),
  })
  .strict();
export type AskPreferences = z.infer<typeof askPreferencesSchema>;

export const askHistoryQuerySchema = z
  .object({
    query: z.string().trim().max(200).optional(),
    cursor: z.string().max(512).optional(),
    limit: z.coerce.number().int().min(1).max(ASK_LIMITS.pageSize).optional(),
  })
  .strict();
export type AskHistoryQuery = z.infer<typeof askHistoryQuerySchema>;
