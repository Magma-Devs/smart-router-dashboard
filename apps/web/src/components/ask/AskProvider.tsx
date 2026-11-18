"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
} from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import useSWR, { useSWRConfig } from "swr";
import {
  WINDOWS,
  type AskCapabilities,
  type AskChatDetail,
  type AskPageContext,
  type AskPreferences,
  type AskRun,
} from "@sr/shared";
import { ApiError } from "@/lib/api-client";
import { getAuthState, getAuthVersion, subscribeAuth } from "@/lib/auth-store";
import { askAnswerProps, getUsageState, track, usageAllowed } from "@/lib/usage";
import { askPoll, createAskApi } from "./ask-api";
import { validChatId } from "./ask-display";
import { useFilters } from "@/components/gateway/FiltersProvider";

const origins = ["/metrics", "/upstreams", "/team", "/audit", "/account"] as const;
const safeOrigin = (path: AskPreferences["returnTo"]): AskPreferences["returnTo"] =>
  (origins as readonly string[]).includes(path) ? path : "/metrics";
const defaults: AskPreferences = { view: "panel", chatId: null, returnTo: "/metrics" };
type Mode = "closed" | "panel" | "minimized";
interface Local {
  scope: string;
  mode: Mode;
  chatId: string | null;
  drafts: Record<string, string>;
  pageContext: AskPageContext | null;
  preferences: AskPreferences;
}
const empty = (scope: string): Local => ({
  scope,
  mode: "closed",
  chatId: null,
  drafts: {},
  pageContext: null,
  preferences: defaults,
});
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
  mode: Mode;
  full: boolean;
  invalidLink: boolean;
  chatId: string | null;
  draft: string;
  submitting: boolean;
  navigating: boolean;
  active: AskRun | null;
  activityKnown: boolean;
  notice: string | null;
  preferenceError: boolean;
  /** Opens Ask; `from` is what opened it, for usage data. */
  open: (from?: "button" | "pill" | "shortcut") => Promise<void>;
  minimize: () => void;
  close: () => void;
  expand: () => void;
  back: () => void;
  select: (id: string | null) => void;
  setDraft: (value: string) => void;
  submit: (context?: AskPageContext | null) => Promise<void>;
  stop: () => Promise<void>;
  context: (previous?: AskPageContext | null) => AskPageContext;
  refresh: () => Promise<void>;
  retryPreferences: () => void;
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
  const filters = useFilters();
  const { mutate } = useSWRConfig();
  const visible = enabled && Boolean(principal);
  const caps = useSWR<AskCapabilities>(
    visible ? ["ask-capabilities", principal] : null,
    () => api.get("/api/ask/capabilities"),
    { ...askPoll<AskCapabilities>(30_000), revalidateOnFocus: true },
  );
  // The api answers ASK_DISABLED where Ask is off for the deployment (its flag
  // can differ from this page's): no entry point, no shortcut.
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
  const full = pathname === "/ask";
  const linkId = search.get("chat");
  const invalidLink = full && linkId !== null && !validChatId(linkId);
  const chatId = full ? (validChatId(linkId) ? linkId : null) : local.chatId;
  const preferences = useSWR<AskPreferences>(
    available ? ["ask-preferences", scope] : null,
    () => api.get("/api/ask/preferences"),
    { revalidateOnFocus: false, shouldRetryOnError: false },
  );
  // Shares the exact cache key with the conversation: ownership is proved
  // before a direct link can become a saved last-view preference.
  const linkedChat = useSWR<AskChatDetail>(
    full && available && chatId ? ["ask", scope, "chat", chatId] : null,
    () => api.get(`/api/ask/chats/${chatId}`),
    { revalidateOnFocus: false, shouldRetryOnError: false },
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [navigating, startNavigation] = useTransition();
  const [preferenceError, setPreferenceError] = useState(false);
  const submittingRef = useRef(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const preferenceQueue = useRef<Promise<unknown>>(Promise.resolve());
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
  const patch = useCallback(
    (change: Partial<Local> | ((old: Local) => Partial<Local>)) => {
      setState((old) => {
        const current = old.scope === scope ? old : empty(scope);
        return { ...current, ...(typeof change === "function" ? change(current) : change) };
      });
    },
    [scope],
  );
  const preferenceVersion = useRef(0);
  const currentPreferences = useMemo(
    () =>
      state.scope === scope
        ? local.preferences
        : preferences.data
          ? { ...preferences.data, returnTo: safeOrigin(preferences.data.returnTo) }
          : defaults,
    [state.scope, scope, local.preferences, preferences.data],
  );
  const persist = useCallback(
    (next: AskPreferences) => {
      const version = ++preferenceVersion.current;
      preferenceQueue.current = preferenceQueue.current
        .catch(() => undefined)
        .then(() => api.send<AskPreferences>("PATCH", "/api/ask/preferences", next))
        .then(
          (saved) => {
            if (version === preferenceVersion.current) {
              patch({ preferences: saved });
              setPreferenceError(false);
            }
          },
          () => {
            if (version === preferenceVersion.current) setPreferenceError(true);
          },
        );
    },
    [api, patch],
  );
  const save = useCallback(
    (next: AskPreferences) => {
      patch({ preferences: next });
      persist(next);
    },
    [patch, persist],
  );
  const preferenceReady =
    state.scope === scope ||
    (Boolean(preferences.data) && !preferences.isValidating && !preferences.error);
  const ownedLinkReady = !chatId || Boolean(linkedChat.data);
  const rememberFullView = useEffectEvent(() => {
    persist({ ...currentPreferences, view: "full", chatId });
  });
  useEffect(() => {
    if (full && available && !invalidLink && preferenceReady && ownedLinkReady) rememberFullView();
  }, [full, available, invalidLink, scope, chatId, preferenceReady, ownedLinkReady]);
  const origin = useCallback(
    (): AskPreferences["returnTo"] =>
      (origins as readonly string[]).includes(pathname)
        ? (pathname as AskPreferences["returnTo"])
        : safeOrigin(currentPreferences.returnTo),
    [pathname, currentPreferences.returnTo],
  );
  const select = useCallback(
    (id: string | null) => {
      if (submittingRef.current) return;
      patch({ chatId: id });
      setNotice(null);
      retry.current = null;
      save({ ...currentPreferences, chatId: id, view: full ? "full" : "panel" });
      if (full) startNavigation(() => router.replace(id ? `/ask?chat=${id}` : "/ask"));
    },
    [patch, save, currentPreferences, full, router],
  );
  const open = useCallback(async (from: "button" | "pill" | "shortcut" = "button") => {
    if (!visible || caps.isLoading) return;
    returnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (full) {
      document.querySelector<HTMLTextAreaElement>("#ask-question")?.focus({ preventScroll: true });
      return;
    }
    if (local.mode === "minimized" || local.mode === "panel") {
      if (local.mode === "minimized") track("ask_open", { from, view: "panel" });
      patch({ mode: "panel" });
      document.querySelector<HTMLTextAreaElement>("#ask-question")?.focus({ preventScroll: true });
      return;
    }
    setNotice(null);
    if (!available) {
      track("ask_open", { from, view: "panel" });
      patch({ mode: "panel" });
      return;
    }
    try {
      // A choice still being saved is the one to restore.
      await preferenceQueue.current.catch(() => undefined);
      const stored = await api.get<AskPreferences>("/api/ask/preferences");
      const preferences = { ...stored, returnTo: safeOrigin(stored.returnTo) };
      track("ask_open", { from, view: preferences.view });
      patch({
        preferences,
        chatId: preferences.chatId,
        mode: preferences.view === "full" ? "closed" : "panel",
      });
      if (preferences.view === "full")
        startNavigation(() =>
          router.push(preferences.chatId ? `/ask?chat=${preferences.chatId}` : "/ask"),
        );
    } catch {
      track("ask_open", { from, view: "panel" });
      patch({ mode: "panel" });
      setNotice("Your last view could not be restored. You can still open your history.");
    }
  }, [api, visible, caps.isLoading, local.mode, available, full, patch, router]);
  const restoreFocus = () => {
    if (returnFocus.current?.isConnected) returnFocus.current.focus();
  };
  const minimize = useCallback(() => {
    patch({ mode: "minimized" });
    restoreFocus();
  }, [patch]);
  const close = useCallback(() => {
    patch({ mode: "closed" });
    restoreFocus();
  }, [patch]);
  const context = useCallback(
    (previous?: AskPageContext | null): AskPageContext => {
      if (previous) return previous;
      if (full && local.pageContext) {
        // The page the chat was opened from, over the same length of time
        // ending now: a question asked later is about later.
        const span = Date.parse(local.pageContext.to) - Date.parse(local.pageContext.from);
        const end = Date.now();
        return {
          ...local.pageContext,
          from: new Date(end - span).toISOString(),
          to: new Date(end).toISOString(),
        };
      }
      const now = Date.now();
      return {
        page: ["overview", "dashboard", "metrics", "upstreams"].includes(pathname.slice(1))
          ? (pathname.slice(1) as AskPageContext["page"])
          : "ask",
        ...(filters.chain ? { chain: filters.chain } : {}),
        ...(filters.router ? { router: filters.router } : {}),
        ...(filters.routerId ? { routerId: filters.routerId } : {}),
        from: new Date(now - WINDOWS[filters.timeWindow].rangeSeconds * 1000).toISOString(),
        to: new Date(now).toISOString(),
      };
    },
    [
      full,
      local.pageContext,
      pathname,
      filters.chain,
      filters.router,
      filters.routerId,
      filters.timeWindow,
    ],
  );
  const expand = useCallback(() => {
    save({ view: "full", chatId: chatId, returnTo: origin() });
    patch({ mode: "closed", pageContext: context() });
    startNavigation(() => router.push(chatId ? `/ask?chat=${chatId}` : "/ask"));
  }, [save, chatId, origin, patch, router, context]);
  const back = useCallback(() => {
    save({ ...currentPreferences, view: "panel", chatId: chatId });
    patch({ mode: "panel", chatId });
    startNavigation(() => router.push(currentPreferences.returnTo));
  }, [save, currentPreferences, chatId, patch, router]);
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
          patch((old) => ({ chatId: id, drafts: { ...old.drafts, [id!]: question } }));
          save({ ...currentPreferences, view: full ? "full" : "panel", chatId: id });
          if (full) startNavigation(() => router.replace(`/ask?chat=${id}`));
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
          view: full ? "full" : "panel",
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
      currentPreferences,
      local,
      chatId,
      available,
      caps.data?.acceptingQuestions,
      activity,
      patch,
      save,
      full,
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
  useEffect(() => {
    if (!shown) return;
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        void open("shortcut");
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [shown, open]);
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
      mode: local.mode,
      full,
      invalidLink,
      chatId: chatId,
      draft: local.drafts[chatId ?? "new"] ?? "",
      submitting,
      navigating,
      active,
      activityKnown: available && Boolean(activity.data) && !activity.error,
      notice,
      preferenceError,
      open,
      minimize,
      close,
      expand,
      back,
      select,
      setDraft: (text) =>
        patch((old) => ({ drafts: { ...old.drafts, [chatId ?? "new"]: text.slice(0, 4000) } })),
      submit,
      stop,
      context,
      refresh,
      retryPreferences: () =>
        save({ ...currentPreferences, view: full ? "full" : "panel", chatId }),
    }),
    [
      api,
      currentPreferences,
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
      full,
      invalidLink,
      chatId,
      submitting,
      navigating,
      active,
      activity.data,
      activity.error,
      notice,
      preferenceError,
      open,
      minimize,
      close,
      expand,
      back,
      select,
      patch,
      submit,
      stop,
      context,
      refresh,
      save,
    ],
  );
  return <AskContext.Provider value={value}>{children}</AskContext.Provider>;
}
