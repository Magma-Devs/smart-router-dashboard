"use client";

/* Ported from the design prototype (page-providers.jsx SideSheet + the
   gw-sheet__head/title/sub/body/foot/steps structure of its call sites,
   incl. SheetStepBar). */

export interface SideSheetSteps {
  /** Step labels, in order (SheetStepBar `steps`). */
  labels: string[];
  /** 1-based current step (SheetStepBar `current`). */
  current: number;
}

export interface SideSheetProps {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  sub?: React.ReactNode;
  wide?: boolean;
  footer?: React.ReactNode;
  steps?: SideSheetSteps;
  children?: React.ReactNode;
}

/** Stat card used inside sheets — ported verbatim from page-metrics.jsx SheetStat. */
export function SheetStat({ label, value, color }: { label: React.ReactNode; value: React.ReactNode; color?: string }) {
  return (
    <div className="gw-card" style={{ padding: "10px 12px" }}>
      <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-3)", marginBottom: 4 }}>{label}</div>
      <div className="gw-mono gw-tnum" style={{ fontSize: 18, fontWeight: 700, color: color || "var(--text)" }}>{value}</div>
    </div>
  );
}

export function SideSheet({ open, onClose, title, sub, wide, footer, steps, children }: SideSheetProps) {
  if (!open) return null;
  return (
    <div className="gw-sheet-bg" onClick={onClose}>
      <div className={"gw-sheet" + (wide ? " gw-sheet--wide" : "")} onClick={(e) => e.stopPropagation()}>
        <div className="gw-sheet__head">
          <div>
            <p className="gw-sheet__title">{title}</p>
            {sub && <p className="gw-sheet__sub">{sub}</p>}
          </div>
          <button className="gw-btn gw-btn--ghost" style={{ padding: 5 }} onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        {steps && (
          <div className="gw-sheet__steps">
            {steps.labels.map((s, i) => {
              const idx = i + 1, isDone = steps.current > idx, isActive = steps.current === idx;
              return (
                <div key={i} className={"gw-sheet__step" + (isActive ? " active" : "") + (isDone ? " done" : "")}>
                  <span className="gw-sheet__step-num">{isDone ? "✓" : idx}</span>{s}
                </div>
              );
            })}
          </div>
        )}

        <div className="gw-sheet__body">{children}</div>

        {footer && <div className="gw-sheet__foot">{footer}</div>}
      </div>
    </div>
  );
}
