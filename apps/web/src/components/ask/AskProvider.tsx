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
import { createAskApi } from "./ask-api";
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
  open: () => Promise<void>;
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
    { refreshInterval: 30_000, revalidateOnFocus: true, shouldRetryOnError: false },
  );
  const available =
    visible &&
    !(caps.error instanceof ApiError && caps.error.code === "ASK_DISABLED") &&
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
  const retry = useRef<{
    chatId: string;
    question: string;
    context: AskPageContext;
    idempotencyKey: string;
  } | null>(null);
  const activity = useSWR<{ run: AskRun | null }>(
    available ? ["ask-active", scope] : null,
    () => api.get("/api/ask/runs/active"),
    { refreshInterval: 1500, revalidateOnFocus: true, shouldRetryOnError: false },
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
  const open = useCallback(async () => {
    if (!visible || caps.isLoading) return;
    returnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (full) {
      document.querySelector<HTMLTextAreaElement>("#ask-question")?.focus({ preventScroll: true });
      return;
    }
    if (local.mode === "minimized" || local.mode === "panel") {
      patch({ mode: "panel" });
      document.querySelector<HTMLTextAreaElement>("#ask-question")?.focus({ preventScroll: true });
      return;
    }
    setNotice(null);
    if (!available) {
      patch({ mode: "panel" });
      return;
    }
    try {
      const stored = await api.get<AskPreferences>("/api/ask/preferences");
      const preferences = { ...stored, returnTo: safeOrigin(stored.returnTo) };
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
      if (full && local.pageContext) return local.pageContext;
      const now = Date.now();
      return {
        page: ["overview", "dashboard", "metrics", "upstreams"].includes(pathname.slice(1))
          ? (pathname.slice(1) as AskPageContext["page"])
          : "ask",
        ...(filters.chain ? { chain: filters.chain } : {}),
        ...(filters.router ? { router: filters.router } : {}),
        from: new Date(now - WINDOWS[filters.timeWindow].rangeSeconds * 1000).toISOString(),
        to: new Date(now).toISOString(),
      };
    },
    [full, local.pageContext, pathname, filters.chain, filters.router, filters.timeWindow],
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
  const lastRun = useRef<string | null>(null);
  useEffect(() => {
    if (lastRun.current && lastRun.current !== active?.id)
      void mutate((key) => Array.isArray(key) && key[0] === "ask" && key[1] === scope);
    lastRun.current = active?.id ?? null;
  }, [active?.id, mutate, scope]);
  useEffect(() => {
    if (!visible) return;
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        void open();
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [visible, open]);
  const value: AskContextValue = useMemo(
    () => ({
      api,
      visible,
      loading: enabled && (!principal || caps.isLoading),
      available,
      accepting: available && !caps.error && caps.data?.acceptingQuestions === true,
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
      visible,
      enabled,
      principal,
      caps.isLoading,
      caps.data?.acceptingQuestions,
      caps.error,
      available,
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
