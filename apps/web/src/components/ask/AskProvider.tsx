"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
} from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import useSWR, { useSWRConfig } from "swr";
import type { AskCapabilities, AskPageContext, AskRun } from "@sr/shared";
import { ApiError } from "@/lib/api-client";
import { getAuthState, getAuthVersion, subscribeAuth } from "@/lib/auth-store";
import { askAnswerProps, getUsageState, track, usageAllowed } from "@/lib/usage";
import { askPoll, createAskApi } from "./ask-api";
import { validChatId } from "./ask-display";

const DAY_MS = 86_400_000;
interface Local {
  scope: string;
  drafts: Record<string, string>;
}
const empty = (scope: string): Local => ({ scope, drafts: {} });
interface AskContextValue {
  api: ReturnType<typeof createAskApi>;
  visible: boolean;
  loading: boolean;
  available: boolean;
  accepting: boolean;
  /** An admin turned Ask off for everyone on this deployment. */
  off: boolean;
  /** This person may turn Ask off and on. */
  canSwitch: boolean;
  setOff: (off: boolean) => Promise<void>;
  scope: string;
  /** Where the menu entry leads: the chat with a question still running, else
   *  the chat last open in this tab, else a new one. */
  href: string;
  invalidLink: boolean;
  chatId: string | null;
  draft: string;
  submitting: boolean;
  navigating: boolean;
  active: AskRun | null;
  activityKnown: boolean;
  connectionLost: boolean;
  notice: string | null;
  select: (id: string | null) => void;
  setDraft: (value: string) => void;
  submit: (context?: AskPageContext | null) => Promise<void>;
  stop: () => Promise<void>;
  /** What a question is sent with: the chat's chain and router, over a time that ends now. */
  context: (previous?: AskPageContext | null) => AskPageContext;
  refresh: () => Promise<void>;
}
const AskContext = createContext<AskContextValue | null>(null);
export function useAsk(): AskContextValue {
  const value = useContext(AskContext);
  if (!value) throw new Error("Ask requires its provider");
  return value;
}
function errorMessage(error: unknown): string {
  return error instanceof ApiError &&
    (error.code?.startsWith("ASK_") || error.code === "SESSION_CHANGED")
    ? error.message
    : "Chat could not connect. Your question is still here; please try again.";
}

export function AskProvider({
  enabled,
  children,
}: {
  enabled: boolean;
  children: React.ReactNode;
}) {
  useSyncExternalStore(subscribeAuth, getAuthVersion, () => 0);
  const sessionToken = getAuthState().token ?? "";
  const api = useMemo(() => createAskApi(sessionToken), [sessionToken]);
  const user = getAuthState().user;
  const principal = user?.id && user.sessionId ? `${user.id}:${user.sessionId}` : null;
  const pathname = usePathname();
  const router = useRouter();
  const search = useSearchParams();
  const { mutate } = useSWRConfig();
  const visible = enabled && Boolean(principal);
  const caps = useSWR<AskCapabilities>(
    visible ? ["ask-capabilities", principal] : null,
    () => api.get("/api/ask/capabilities"),
    { ...askPoll<AskCapabilities>(30_000), revalidateOnFocus: true },
  );
  // The api answers ASK_DISABLED where Ask is off for the deployment (its flag
  // can differ from this page's): no menu entry.
  const disabledByApi = caps.error instanceof ApiError && caps.error.code === "ASK_DISABLED";
  const shown = visible && !disabledByApi;
  const available =
    visible &&
    !disabledByApi &&
    caps.data?.enabled === true &&
    /^[a-f0-9]{64}$/.test(caps.data.scopeId);
  const scope = available ? caps.data!.scopeId : `unavailable:${principal ?? ""}`;
  const [state, setState] = useState<Local>(() => empty(""));
  const local = useMemo(() => (state.scope === scope ? state : empty(scope)), [state, scope]);
  const onPage = pathname === "/ask";
  const linkId = search.get("chat");
  const invalidLink = onPage && linkId !== null && !validChatId(linkId);
  const chatId = onPage && validChatId(linkId) ? linkId : null;
  // The chat last open on the page, kept while the person is elsewhere.
  const [last, setLast] = useState<{ scope: string; id: string | null }>({ scope: "", id: null });
  if (onPage && !invalidLink && (last.scope !== scope || last.id !== chatId))
    setLast({ scope, id: chatId });
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [navigating, startNavigation] = useTransition();
  const submittingRef = useRef(false);
  /** Runs this tab sent, so only the tab that asked reports how one ended. */
  const asked = useRef(new Set<string>());
  const retry = useRef<{
    chatId: string;
    question: string;
    context: AskPageContext;
    idempotencyKey: string;
  } | null>(null);
  const activity = useSWR<{ run: AskRun | null }>(
    available ? ["ask-active", scope] : null,
    () => api.get("/api/ask/runs/active"),
    {
      // Fast while a question runs; slow otherwise, to notice one another tab started.
      ...askPoll<{ run: AskRun | null }>((data) => (data?.run ? 1500 : 15_000)),
      revalidateOnFocus: true,
    },
  );
  const activeRun = available ? (activity.data?.run ?? null) : null;
  const active =
    activeRun && ["queued", "running", "cancelling"].includes(activeRun.status) ? activeRun : null;
  const resume = active?.chatId ?? (last.scope === scope ? last.id : null);
  const patch = useCallback(
    (change: Partial<Local> | ((old: Local) => Partial<Local>)) => {
      setState((old) => {
        const current = old.scope === scope ? old : empty(scope);
        return { ...current, ...(typeof change === "function" ? change(current) : change) };
      });
    },
    [scope],
  );
  const select = useCallback(
    (id: string | null) => {
      if (submittingRef.current) return;
      setNotice(null);
      retry.current = null;
      startNavigation(() => router.replace(id ? `/ask?chat=${id}` : "/ask"));
    },
    [router],
  );
  const context = useCallback((previous?: AskPageContext | null): AskPageContext => {
    // A follow-up keeps its chat's chain and router. The time always ends now:
    // a question asked later is about later. A new chat covers the last day,
    // the most one read may cover.
    const end = Date.now();
    const kept = previous ? Date.parse(previous.to) - Date.parse(previous.from) : DAY_MS;
    const span = Number.isFinite(kept) && kept > 0 ? kept : DAY_MS;
    return {
      ...(previous ?? { page: "ask" as const }),
      from: new Date(end - span).toISOString(),
      to: new Date(end).toISOString(),
    };
  }, []);
  const refresh = useCallback(async () => {
    await Promise.all([
      caps.mutate(),
      activity.mutate(),
      mutate((key) => Array.isArray(key) && key[0] === "ask" && key[1] === scope),
    ]);
  }, [caps, activity, mutate, scope]);
  const submit = useCallback(
    async (previous?: AskPageContext | null) => {
      const question = (local.drafts[chatId ?? "new"] ?? "").trim();
      if (submittingRef.current || !question || !available || !caps.data?.acceptingQuestions)
        return;
      submittingRef.current = true;
      setSubmitting(true);
      setNotice(null);
      try {
        // Check again across tabs before committing. PostgreSQL still owns the
        // final atomic rule if two browsers race after this read.
        const current = await api.get<{ run: AskRun | null }>("/api/ask/runs/active");
        if (current.run) {
          await activity.mutate(current);
          setNotice("A question is already processing. Wait or stop it first.");
          return;
        }
        let id = chatId;
        const newChat = !id;
        if (!id) {
          id = (await api.post<{ id: string }>("/api/ask/chats", {})).id;
          patch((old) => ({ drafts: { ...old.drafts, [id!]: question } }));
          startNavigation(() => router.replace(`/ask?chat=${id}`));
        }
        const pending =
          retry.current?.chatId === id && retry.current.question === question
            ? retry.current
            : {
                chatId: id,
                question,
                context: context(previous),
                idempotencyKey: crypto.randomUUID(),
              };
        retry.current = pending;
        const run = await api.post<AskRun>(`/api/ask/chats/${id}/runs`, {
          question,
          context: pending.context,
          idempotencyKey: pending.idempotencyKey,
        });
        retry.current = null;
        asked.current.add(run.id);
        track("ask_question", {
          view: "full",
          page: pending.context.page,
          new_chat: newChat,
          chain: Boolean(pending.context.chain),
        });
        patch((old) => ({ drafts: { ...old.drafts, [id!]: "", new: "" } }));
        await activity.mutate({ run }, false);
        await mutate((key) => Array.isArray(key) && key[0] === "ask" && key[1] === scope);
      } catch (error) {
        setNotice(errorMessage(error));
        await activity.mutate();
      } finally {
        submittingRef.current = false;
        setSubmitting(false);
      }
    },
    [
      api,
      local,
      chatId,
      available,
      caps.data?.acceptingQuestions,
      activity,
      patch,
      router,
      context,
      mutate,
      scope,
    ],
  );
  const stop = useCallback(async () => {
    if (!active) return;
    try {
      const run = await api.post<AskRun>(`/api/ask/runs/${active.id}/cancel`, {});
      await activity.mutate({ run }, false);
      await mutate((key) => Array.isArray(key) && key[0] === "ask" && key[1] === scope);
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }, [api, active, activity, mutate, scope]);
  const setOff = useCallback(
    async (off: boolean) => {
      await api.post("/api/ask/switch", { off });
      await Promise.all([
        caps.mutate(),
        activity.mutate(),
        mutate((key) => Array.isArray(key) && key[0] === "ask" && key[1] === scope),
      ]);
    },
    [api, caps, activity, mutate, scope],
  );
  const lastRun = useRef<string | null>(null);
  useEffect(() => {
    const ended = lastRun.current;
    if (ended && ended !== active?.id) {
      // How a question this tab sent ended, read only while usage data is recorded.
      if (asked.current.delete(ended)) {
        const usage = getUsageState();
        if (usageAllowed(usage.available, usage.consent))
          void api.get<AskRun>(`/api/ask/runs/${ended}`).then(
            (run) => {
              const props = askAnswerProps(run);
              if (props) track("ask_answer", props);
            },
            () => undefined,
          );
      }
      void mutate((key) => Array.isArray(key) && key[0] === "ask" && key[1] === scope);
      // A question that ended may have been stopped by an admin's switch.
      void caps.mutate();
    }
    lastRun.current = active?.id ?? null;
  }, [active?.id, mutate, scope, caps, api]);
  const value: AskContextValue = useMemo(
    () => ({
      api,
      visible: shown,
      loading: enabled && (!principal || caps.isLoading),
      available,
      accepting: available && !caps.error && caps.data?.acceptingQuestions === true,
      off: available && caps.data?.off === true,
      canSwitch: available && caps.data?.canSwitch === true,
      setOff,
      scope,
      href: resume ? `/ask?chat=${resume}` : "/ask",
      invalidLink,
      chatId: chatId,
      draft: local.drafts[chatId ?? "new"] ?? "",
      submitting,
      navigating,
      active,
      activityKnown: available && Boolean(activity.data) && !activity.error,
      connectionLost: Boolean(activity.error || caps.error),
      notice,
      select,
      setDraft: (text) =>
        patch((old) => ({ drafts: { ...old.drafts, [chatId ?? "new"]: text.slice(0, 4000) } })),
      submit,
      stop,
      context,
      refresh,
    }),
    [
      api,
      shown,
      enabled,
      principal,
      caps.isLoading,
      caps.data?.acceptingQuestions,
      caps.data?.off,
      caps.data?.canSwitch,
      caps.error,
      available,
      setOff,
      scope,
      local,
      resume,
      invalidLink,
      chatId,
      submitting,
      navigating,
      active,
      activity.data,
      activity.error,
      notice,
      select,
      patch,
      submit,
      stop,
      context,
      refresh,
    ],
  );
  return <AskContext.Provider value={value}>{children}</AskContext.Provider>;
}
