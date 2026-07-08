/* Standard "this is a Magma Cloud feature" callout. Used wherever a
   design-prototype surface exists but the self-hosted deployment can't back it
   (team invites, connected accounts, password change, sessions, …). One shared
   style so every such spot reads the same: info-tinted panel, icon, a bold lead
   naming Magma Cloud, then the self-hosted reason. */

export function CloudNotice({
  feature,
  detail,
  compact = false,
}: {
  /** What's gated, e.g. "Team accounts", "Changing your password". */
  feature: string;
  /** Why it's unavailable here, e.g. "this deployment uses a single shared login." */
  detail?: string;
  /** Smaller variant for inline use under a section header. */
  compact?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 9,
        padding: compact ? "8px 10px" : "10px 12px",
        borderRadius: 8,
        background: "rgba(96,165,250,0.08)",
        border: "1px solid rgba(96,165,250,0.22)",
        fontSize: 12,
        color: "var(--text-2)",
        lineHeight: 1.5,
      }}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="var(--info)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ flexShrink: 0, marginTop: 1 }}
      >
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="16" x2="12" y2="12" />
        <line x1="12" y1="8" x2="12.01" y2="8" />
      </svg>
      <span>
        <strong style={{ color: "var(--text)", fontWeight: 600 }}>
          {feature} {feature.endsWith("s") ? "are" : "is"} a Magma&nbsp;Cloud feature.
        </strong>
        {detail ? <> {detail}</> : null}
      </span>
    </div>
  );
}
