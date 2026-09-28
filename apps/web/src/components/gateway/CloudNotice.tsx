/* Standard "this is a Magma Cloud feature" callout, for a design-prototype
   surface the self-hosted deployment can't back (JWT management). `Notice` is
   the same panel with a lead of your own, for something that exists on no
   deployment — saying "Magma Cloud" there would promise a feature nobody has. */

export function CloudNotice({
  feature,
  detail,
  compact = false,
}: {
  /** What's gated, e.g. "Team accounts", "Changing your password". */
  feature: string;
  /** Why it's unavailable here, e.g. "no tokens exist on this deployment." */
  detail?: string;
  /** Smaller variant for inline use under a section header. */
  compact?: boolean;
}) {
  return (
    <Notice
      lead={`${feature} ${feature.endsWith("s") ? "are" : "is"} a Magma Cloud feature.`}
      detail={detail}
      compact={compact}
    />
  );
}

export function Notice({
  lead,
  detail,
  compact = false,
}: {
  /** The bold first sentence. */
  lead: string;
  detail?: string;
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
          {lead}
        </strong>
        {detail ? ` ${detail}` : null}
      </span>
    </div>
  );
}
