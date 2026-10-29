"use client";

/* Ask your data - a PREVIEW of the chat panel a client will use to ask about
 * their own router in plain words. It draws the whole flow - the top-bar
 * button, a side panel that minimizes to a pill, a week of chats, one
 * question at a time, the steps while it works, and a numbered answer with
 * its sources - but answers from sample-answers.ts and reads no store. The
 * backend it stands in for (Bedrock, the client's own MCP scoped to their
 * data, a monthly budget per client, prompt logs kept 90 days) is
 * docs/ASK-YOUR-DATA.md. Shown only where ASK_DATA_PREVIEW=true; the panel
 * says on screen that its answers are samples.
 *
 * History is kept in this browser for 7 days, as the real one will be kept on
 * the server for each person. */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { SAMPLE_BUDGET, SUGGESTIONS, sampleAnswer, type SampleAnswer } from "./sample-answers";

const KEEP_MS = 7 * 24 * 3600_000;
const STORE_KEY = "sr:ask:threads";
/** Chats shown before "Show earlier" in the history list. */
const HISTORY_PAGE = 6;

interface Turn {
  id: string;
  question: string;
  at: number;
  /** Null while it works. */
  answer: SampleAnswer | null;
  tookMs?: number;
}

interface Thread {
  id: string;
  title: string;
  at: number;
  turns: Turn[];
}

type Phase = { step: number; startedAt: number } | null;

interface AskState {
  open: boolean;
  minimized: boolean;
  threads: Thread[];
  active: Thread | null;
  phase: Phase;
  spent: number;
  openPanel: () => void;
  close: () => void;
  minimize: () => void;
  newChat: () => void;
  pick: (id: string) => void;
  ask: (q: string) => void;
  stop: () => void;
}

const Ctx = createContext<AskState | null>(null);
const useAsk = () => {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAsk outside AskDataProvider");
  return v;
};

const uid = () => Math.random().toString(36).slice(2, 10);

function load(): Thread[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]") as Thread[];
    const live = raw.filter((t) => Date.now() - t.at < KEEP_MS);
    if (live.length) return live;
  } catch { /* nothing kept */ }
  // A first visit opens on two earlier chats, so the history reads as it will.
  const day = 24 * 3600_000;
  return [
    { id: uid(), title: "Did any requests fail today?", at: Date.now() - day, turns: [{ id: uid(), question: "Did any requests fail today?", at: Date.now() - day, answer: sampleAnswer("fail"), tookMs: 3400 }] },
    { id: uid(), title: "Is latency normal right now?", at: Date.now() - 3 * day, turns: [{ id: uid(), question: "Is latency normal right now?", at: Date.now() - 3 * day, answer: sampleAnswer("latency"), tookMs: 2900 }] },
  ];
}

export function AskDataProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [minimized, setMinimized] = useState(false);
  // Read once, in the browser; the panel only draws after a click, so the server's empty list never shows.
  const [threads, setThreads] = useState<Thread[]>(() => (typeof window === "undefined" ? [] : load()));
  const [activeId, setActiveId] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>(null);
  const [spent, setSpent] = useState(SAMPLE_BUDGET.spent);
  const timers = useRef<number[]>([]);

  useEffect(() => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(threads)); } catch { /* private window */ }
  }, [threads]);

  // ⌘J / Ctrl+J opens and closes it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
        e.preventDefault();
        setOpen((o) => !o);
        setMinimized(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const clear = () => { timers.current.forEach((t) => window.clearTimeout(t)); timers.current = []; };

  const ask = useCallback((question: string) => {
    if (phase) return; // one question at a time
    const answer = sampleAnswer(question);
    const turn: Turn = { id: uid(), question, at: Date.now(), answer: null };
    // A question in an open chat joins it; otherwise it starts one.
    const into = threads.some((x) => x.id === activeId) ? activeId! : null;
    const tid = into ?? uid();
    setThreads((ts) => (into
      ? ts.map((x) => (x.id === into ? { ...x, at: Date.now(), turns: [...x.turns, turn] } : x))
      : [{ id: tid, title: question, at: Date.now(), turns: [turn] }, ...ts]));
    setActiveId(tid);
    const started = Date.now();
    setPhase({ step: 0, startedAt: started });
    let at = 0;
    answer.steps.forEach((s, i) => {
      at += s.ms;
      timers.current.push(window.setTimeout(() => setPhase(i + 1 < answer.steps.length ? { step: i + 1, startedAt: started } : null), at));
    });
    timers.current.push(window.setTimeout(() => {
      setThreads((ts) => ts.map((x) => ({ ...x, turns: x.turns.map((u) => (u.id === turn.id ? { ...u, answer, tookMs: Date.now() - started } : u)) })));
      setSpent((s) => s + answer.cost);
    }, at));
  }, [phase, activeId, threads]);

  const stop = () => {
    clear();
    setPhase(null);
    setThreads((ts) => ts.map((x) => ({ ...x, turns: x.turns.filter((u) => u.answer) })).filter((x) => x.turns.length));
  };

  const value = useMemo<AskState>(() => ({
    open, minimized, threads, phase, spent,
    active: threads.find((t) => t.id === activeId) ?? null,
    openPanel: () => { setOpen(true); setMinimized(false); },
    close: () => { setOpen(false); setMinimized(false); },
    minimize: () => setMinimized(true),
    newChat: () => { if (!phase) setActiveId(null); },
    pick: (id) => { if (!phase) setActiveId(id); },
    ask,
    stop,
  }), [open, minimized, threads, activeId, phase, spent, ask]); // eslint-disable-line react-hooks/exhaustive-deps

  return <Ctx.Provider value={value}>{children}<AskDataPanel /></Ctx.Provider>;
}

/* ── Glyph ─────────────────────────────────────────────────────────── */

/** Two sparks over a bar: data, asked. */
function Spark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M10 3l1.6 4.2L16 9l-4.4 1.8L10 15l-1.6-4.2L4 9l4.4-1.8L10 3z" fill="currentColor" />
      <path d="M18 13l.9 2.1L21 16l-2.1.9L18 19l-.9-2.1L15 16l2.1-.9L18 13z" fill="currentColor" opacity=".7" />
      <rect x="4" y="19" width="9" height="2" rx="1" fill="currentColor" opacity=".45" />
    </svg>
  );
}

/* ── Top-bar button ────────────────────────────────────────────────── */

export function AskDataButton() {
  const { openPanel, phase } = useAsk();
  return (
    <button type="button" onClick={openPanel} className="ask-launch" title="Ask your data (⌘J)">
      <span className="ask-launch__glyph"><Spark size={14} /></span>
      <span>Ask your data</span>
      {phase ? <span className="ask-dot" aria-label="Answering" /> : <kbd className="ask-kbd">⌘J</kbd>}
    </button>
  );
}

/* ── The panel ─────────────────────────────────────────────────────── */

function AskDataPanel() {
  const s = useAsk();
  const [showHistory, setShowHistory] = useState(false);
  if (!s.open) return null;
  if (s.minimized) {
    return (
      <button type="button" className="ask-pill" onClick={s.openPanel}>
        <span className="ask-launch__glyph"><Spark size={14} /></span>
        {s.phase ? <>Answering<span className="ask-ellipsis" /></> : s.active ? s.active.title : "Ask your data"}
      </button>
    );
  }
  const pct = Math.min(100, (s.spent / SAMPLE_BUDGET.limit) * 100);
  return (
    <aside className="ask-panel" aria-label="Ask your data">
      <header className="ask-head">
        <div className="ask-head__title">
          <span className="ask-badge"><Spark size={15} /></span>
          <div>
            <div style={{ fontWeight: 600, fontSize: 13.5, color: "var(--text)" }}>Ask your data</div>
            <div style={{ fontSize: 11, color: "var(--text-4)" }}>Reads this deployment&apos;s data only</div>
          </div>
        </div>
        <div className="ask-head__actions">
          <IconBtn label="History" on={showHistory} onClick={() => setShowHistory((h) => !h)} d="M12 8v4l2.5 2.5M3.05 11a9 9 0 1 1 .5 4M3 4v5h5" />
          <IconBtn label="New chat" onClick={() => { s.newChat(); setShowHistory(false); }} d="M12 5v14M5 12h14" disabled={!!s.phase} />
          <IconBtn label="Minimize" onClick={s.minimize} d="M5 12h14" />
          <IconBtn label="Close" onClick={s.close} d="M6 6l12 12M18 6L6 18" />
        </div>
      </header>

      <div className="ask-preview">Preview · sample answers, not your data</div>

      {showHistory ? (
        <History onPick={(id) => { s.pick(id); setShowHistory(false); }} />
      ) : (
        <Conversation />
      )}

      <Composer />

      <footer className="ask-foot">
        <div className="ask-budget" title="What this month's questions have cost, against your monthly limit">
          <span>This month</span>
          <span className="ask-budget__bar"><span style={{ width: `${pct}%` }} /></span>
          <span className="gw-mono gw-tnum">${s.spent.toFixed(2)} of ${SAMPLE_BUDGET.limit}</span>
        </div>
        <span>Kept 7 days</span>
      </footer>
    </aside>
  );
}

function IconBtn({ label, d, onClick, on, disabled }: { label: string; d: string; onClick: () => void; on?: boolean; disabled?: boolean }) {
  return (
    <button type="button" className={`ask-icon${on ? " on" : ""}`} onClick={onClick} title={label} aria-label={label} disabled={disabled}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
    </button>
  );
}

/* ── History: a week of chats ──────────────────────────────────────── */

function History({ onPick }: { onPick: (id: string) => void }) {
  const { threads, active } = useAsk();
  const [shown, setShown] = useState(HISTORY_PAGE);
  const dayOf = (at: number) => {
    const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(at).setHours(0, 0, 0, 0)) / 86_400_000);
    return days <= 0 ? "Today" : days === 1 ? "Yesterday" : "Earlier this week";
  };
  const list = [...threads].sort((a, b) => b.at - a.at);
  // A heading wherever the day changes.
  const rows = list.slice(0, shown).map((t, i, arr) => ({ t, head: i === 0 || dayOf(arr[i - 1]!.at) !== dayOf(t.at) ? dayOf(t.at) : null }));
  return (
    <div className="ask-scroll" style={{ padding: "8px 12px" }}>
      {!list.length && <div className="ask-empty-note">No chats in the last 7 days.</div>}
      {rows.map(({ t, head }) => {
        return (
          <div key={t.id}>
            {head && <div className="ask-group">{head}</div>}
            <button type="button" className={`ask-thread${active?.id === t.id ? " on" : ""}`} onClick={() => onPick(t.id)}>
              <span className="ask-thread__title">{t.title}</span>
              <span className="ask-thread__meta gw-mono">{new Date(t.at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })} · {t.turns.length} {t.turns.length === 1 ? "question" : "questions"}</span>
            </button>
          </div>
        );
      })}
      {shown < list.length && (
        <button type="button" className="ask-more" onClick={() => setShown((n) => n + HISTORY_PAGE)}>Show earlier chats</button>
      )}
      <div className="ask-empty-note">Chats are kept for 7 days.</div>
    </div>
  );
}

/* ── The conversation ──────────────────────────────────────────────── */

function Conversation() {
  const { active, phase, ask } = useAsk();
  const end = useRef<HTMLDivElement>(null);
  const turns = active?.turns ?? [];
  const lastAnswered = !!turns[turns.length - 1]?.answer;
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [turns.length, phase?.step, lastAnswered]);

  if (!turns.length) {
    return (
      <div className="ask-scroll ask-hello">
        <div className="ask-hello__badge"><Spark size={22} /></div>
        <div className="ask-hello__title">What do you want to know?</div>
        <div className="ask-hello__sub">Ask about your requests, errors, latency or providers, in your own words.</div>
        <div className="ask-suggest">
          {SUGGESTIONS.map((x) => (
            <button key={x.title} type="button" className="ask-suggest__item" onClick={() => ask(x.title)}>
              <span>{x.title}</span>
              <span className="ask-suggest__hint">{x.hint}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className="ask-scroll" style={{ padding: "12px 16px 4px" }}>
      {turns.map((t, i) => (
        <div key={t.id} className="ask-turn">
          <div className="ask-q">{t.question}</div>
          {t.answer ? <Answer a={t.answer} tookMs={t.tookMs} /> : i === turns.length - 1 && phase && <Working question={t.question} step={phase.step} />}
        </div>
      ))}
      <div ref={end} />
    </div>
  );
}

/** The steps it works through, the one in progress shimmering. */
function Working({ question, step }: { question: string; step: number }) {
  const steps = sampleAnswer(question).steps;
  return (
    <div className="ask-steps" aria-live="polite">
      {steps.map((s, i) => (
        <div key={i} className={`ask-step ${i < step ? "done" : i === step ? "now" : "next"}`}>
          <span className="ask-step__mark">{i < step ? "✓" : i === step ? <span className="ask-spin" /> : ""}</span>
          <span className="ask-step__label">{s.label}</span>
          <span className="ask-step__detail">{s.detail}</span>
        </div>
      ))}
    </div>
  );
}

/** A numbered answer: the one-line summary, then a numbered part each, then what it read. */
function Answer({ a, tookMs }: { a: SampleAnswer; tookMs?: number }) {
  const [copied, setCopied] = useState(false);
  const [vote, setVote] = useState<"up" | "down" | null>(null);
  const text = [a.summary, ...a.sections.map((s, i) => `${i + 1}. ${s.title}\n${s.body}${s.points ? "\n" + s.points.map((p) => `- ${p}`).join("\n") : ""}`)].join("\n\n");
  return (
    <div className="ask-a">
      <div className="ask-a__summary">{a.summary}</div>
      <ol className="ask-a__list">
        {a.sections.map((s, i) => (
          <li key={i} className="ask-a__item">
            <span className="ask-a__n">{i + 1}</span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="ask-a__head">
                <span className="ask-a__title">{s.title}</span>
                {s.stat && <span className={`ask-a__stat ${s.stat.tone ?? ""}`}><b className="gw-tnum">{s.stat.value}</b> {s.stat.label}</span>}
              </div>
              <div className="ask-a__body">{renderInline(s.body)}</div>
              {s.points && <ul className="ask-a__points">{s.points.map((p) => <li key={p}>{renderInline(p)}</li>)}</ul>}
            </div>
          </li>
        ))}
      </ol>
      <div className="ask-a__sources">
        <span>Read</span>
        {a.sources.map((x) => <span key={x} className="ask-chip">{x}</span>)}
      </div>
      <div className="ask-a__actions">
        <button type="button" className="ask-mini" onClick={() => { void navigator.clipboard?.writeText(text); setCopied(true); window.setTimeout(() => setCopied(false), 1400); }}>{copied ? "Copied" : "Copy"}</button>
        <button type="button" className={`ask-mini${vote === "up" ? " on" : ""}`} onClick={() => setVote("up")} aria-label="Helpful">▲</button>
        <button type="button" className={`ask-mini${vote === "down" ? " on" : ""}`} onClick={() => setVote("down")} aria-label="Not helpful">▼</button>
        <span style={{ flex: 1 }} />
        <span className="gw-mono gw-tnum">{tookMs ? `${(tookMs / 1000).toFixed(1)} s · ` : ""}${a.cost.toFixed(3)}</span>
      </div>
    </div>
  );
}

/** `code` in a sentence, as the router writes method names. */
function renderInline(s: string): React.ReactNode {
  return s.split(/(`[^`]+`)/).map((part, i) => (part.startsWith("`") ? <code key={i} className="ask-code">{part.slice(1, -1)}</code> : part));
}

/* ── The composer: one question at a time ──────────────────────────── */

function Composer() {
  const { ask, phase, stop, spent } = useAsk();
  const [q, setQ] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const over = spent >= SAMPLE_BUDGET.limit;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(140, el.scrollHeight)}px`;
  }, [q]);
  const send = () => {
    const v = q.trim();
    if (!v || phase || over) return;
    ask(v);
    setQ("");
  };
  return (
    <div className="ask-compose">
      <div className={`ask-compose__box${phase ? " busy" : ""}`}>
        <textarea
          ref={ref}
          rows={1}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder={over ? "This month's limit is reached" : phase ? "Answering - one question at a time" : "Ask about requests, errors, latency…"}
          disabled={!!phase || over}
          aria-label="Your question"
        />
        {phase ? (
          <button type="button" className="ask-send stop" onClick={stop} aria-label="Stop">
            <svg width="12" height="12" viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" /></svg>
          </button>
        ) : (
          <button type="button" className="ask-send" onClick={send} disabled={!q.trim() || over} aria-label="Send">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
          </button>
        )}
      </div>
      <div className="ask-compose__note">Enter to send · Shift+Enter for a new line · Answers can be wrong: check the figures on the dashboard.</div>
    </div>
  );
}
