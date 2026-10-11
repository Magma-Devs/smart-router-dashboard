import type { HealthState } from "@sr/shared";
import { upstreamHealthNotice } from "@/lib/upstream-presentation";

export function UpstreamHealthNotice({ health }: { health: HealthState }) {
  const message = upstreamHealthNotice(health);
  if (!message) return null;
  return (
    <div
      role="status"
      style={{
        padding: "12px 14px",
        marginBottom: 12,
        border: "1px solid var(--line)",
        borderRadius: 8,
        color: health === "unhealthy" ? "var(--err)" : "var(--text-3)",
        background: "var(--hover)",
        fontSize: 13,
      }}
    >
      {message}
    </div>
  );
}
