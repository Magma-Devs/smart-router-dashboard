import type { HealthState } from "@sr/shared";
import { HEALTH_UNKNOWN_HINT, healthColor, healthLabel, healthTagClass } from "@/lib/health";

/** Status dot alone, for a table cell that has its own label column. */
export function HealthDot({ health, size = 7 }: { health: HealthState; size?: number }) {
  return (
    <span
      title={health === "unknown" ? HEALTH_UNKNOWN_HINT : healthLabel(health)}
      style={{
        width: size, height: size, borderRadius: 999, flexShrink: 0,
        background: healthColor(health),
      }}
    />
  );
}

/**
 * Dot + word chip. The one place a health state turns into UI, so the
 * Upstreams roster, the Try-it drawer header and the deep-dive can't drift
 * apart again (see `lib/health.ts` for what they used to say).
 */
export function HealthTag({ health, fontSize = 10 }: { health: HealthState; fontSize?: number }) {
  return (
    <span
      className={healthTagClass(health)}
      title={health === "unknown" ? HEALTH_UNKNOWN_HINT : undefined}
      style={{ fontSize, padding: "1px 6px", display: "inline-flex", gap: 5, alignItems: "center" }}
    >
      <HealthDot health={health} size={6} />
      {healthLabel(health)}
    </span>
  );
}
