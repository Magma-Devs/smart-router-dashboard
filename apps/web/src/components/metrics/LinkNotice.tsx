/* LinkNotice — one plain line saying a link asked for something the page
 * couldn't show as it was (an upstream no longer in the config, times older
 * than the logs keep), and what it shows instead. */

export function LinkNotice({ children }: { children: React.ReactNode }) {
  return (
    <div role="status" style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, padding: "9px 14px", borderRadius: 9, background: "var(--hover)", border: "1px solid var(--line-2)", fontSize: 13, color: "var(--text-2)" }}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ flexShrink: 0 }}>
        <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" />
      </svg>
      <span>{children}</span>
    </div>
  );
}
