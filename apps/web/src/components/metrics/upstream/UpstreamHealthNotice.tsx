import type { HealthState } from "@sr/shared";
import { upstreamHealthNotice } from "@/lib/upstream-presentation";

export function UpstreamHealthNotice({ health, reason }: { health: HealthState; reason?: string }) {
  const message = upstreamHealthNotice(health, reason);
  if (!message) return null;
  return (
    <div
      role="alert"
      style={{
        padding: "12px 14px",
        marginBottom: 12,
        border: `1px solid ${health === "unhealthy" ? "var(--err)" : "var(--warn)"}`,
        borderRadius: 8,
        color: health === "unhealthy" ? "var(--err)" : "var(--warn)",
        background: "var(--hover)",
        fontSize: 13,
      }}
    >
      {message}
    </div>
  );
}
