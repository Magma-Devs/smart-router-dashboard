import { mutate } from "swr";
import { idleGateApplies, idlePhase, idleStart, msToNextPhase, onActivity, onPhaseTimer, type IdlePhase, type IdleState } from "./poll";

/* The idle gate's clock: when someone last did something on the page, held
 * against the rules in poll.ts. Module-level, so SWR's `isPaused` and every
 * poll's interval read it without a render. It watches the page only while
 * something subscribes - every `useApi` does - and starts its clock there.
 * An exempt page (`idleGateApplies`) always reads as active. */

/** What counts as someone at the page. A tab coming back into view does; one going away doesn't. */
export const ACTIVITY_EVENTS = ["pointermove", "pointerdown", "keydown", "wheel", "touchstart", "focus", "visibilitychange", "popstate"] as const;

export interface IdleEnv {
  /** Where the events land: the window, listened to in the capture phase. */
  target: () => EventTarget;
  /** Whether the page is on screen. */
  visible: () => boolean;
  /** Re-reads these keys now. */
  refresh: (keys: ReadonlySet<string>) => void;
  /** Whether the page showing is one the gate leaves alone. */
  exempt: () => boolean;
}

export interface IdleStore {
  subscribe(listener: () => void): () => void;
  /** The phase last announced: what the paused pill draws. Active while nothing watches the page, and on an exempt one. */
  phase(): IdlePhase;
  /** The phase by the clock: what the polls obey. Active while nothing watches the page, and on an exempt one. */
  phaseNow(): IdlePhase;
  /** Returns from idle so far. */
  resumes(): number;
  /** Counts `key` as polling - re-read on a return from idle - until the returned function runs. */
  watchPoll(key: string): () => void;
}

export function createIdleStore(env: IdleEnv): IdleStore {
  let state: IdleState = idleStart(Date.now());
  const listeners = new Set<() => void>();
  const polls = new Map<string, number>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const opts: AddEventListenerOptions = { capture: true, passive: true };

  const emit = () => {
    for (const l of listeners) l();
  };
  const gated = () => listeners.size > 0 && !env.exempt();

  // One timer, set for the next phase boundary. Activity doesn't move it: it
  // fires, reads the clock, and sets itself again.
  function arm() {
    clearTimeout(timer);
    const wait = msToNextPhase(Date.now() - state.lastActivityAt);
    timer = wait === null ? undefined : setTimeout(tick, wait);
  }

  function tick() {
    const next = onPhaseTimer(state, Date.now());
    if (next !== state) {
      state = next;
      emit();
    }
    arm();
  }

  function onEvent(e: Event) {
    if (e.type === "visibilitychange" && !env.visible()) return;
    const next = onActivity(state, Date.now());
    if (next === state) return;
    const resumed = next.resumes !== state.resumes;
    state = next;
    if (!resumed) return;
    arm();
    // An exempt page never slowed: its clock moves on, nothing else does.
    if (env.exempt()) return;
    emit();
    env.refresh(new Set(polls.keys()));
  }

  return {
    subscribe(listener) {
      if (listeners.size === 0) {
        // Nothing watched the page until now, so its clock starts here.
        state = idleStart(Date.now(), state.resumes);
        for (const type of ACTIVITY_EVENTS) env.target().addEventListener(type, onEvent, opts);
        arm();
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        for (const type of ACTIVITY_EVENTS) env.target().removeEventListener(type, onEvent, opts);
        clearTimeout(timer);
        timer = undefined;
      };
    },
    phase: () => (gated() ? state.phase : "active"),
    phaseNow: () => (gated() ? idlePhase(Date.now() - state.lastActivityAt) : "active"),
    resumes: () => state.resumes,
    watchPoll(key) {
      polls.set(key, (polls.get(key) ?? 0) + 1);
      return () => {
        const n = (polls.get(key) ?? 1) - 1;
        if (n > 0) polls.set(key, n);
        else polls.delete(key);
      };
    },
  };
}

let store: IdleStore | undefined;

/** The page's store. Made on first use; on the server nothing subscribes, so it never touches `window`. */
function idle(): IdleStore {
  store ??= createIdleStore({
    target: () => window,
    visible: () => document.visibilityState === "visible",
    // RefreshButton's broadcast without clearing the cache, so the numbers
    // stay on screen while they reload; and only keys that poll, never a
    // one-off look-up (a 30-day request search scans every log line in it).
    refresh: (keys) => void mutate((key) => typeof key === "string" && keys.has(key)),
    exempt: () => !idleGateApplies(window.location.pathname),
  });
  return store;
}

export const subscribeIdle = (listener: () => void) => idle().subscribe(listener);
export const getIdlePhase = () => idle().phase();
export const getIdleResumes = () => idle().resumes();
export const idlePhaseNow = () => idle().phaseNow();
/** SWR's `isPaused` for every poll: nothing revalidates while paused, a `mutate()` included. */
export const isPollingPaused = () => idle().phaseNow() === "paused";
export const watchPoll = (key: string) => idle().watchPoll(key);
