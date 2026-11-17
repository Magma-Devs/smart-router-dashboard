/**
 * Forwarding the dashboard's usage events to Mixpanel (MAG-5373). The web
 * sends a visit's events to `POST /api/usage`; what the catalog allows
 * (`cleanUsageProps` in `@sr/shared`) goes on from here, server side, so the
 * project token never reaches a browser and the store never sees a client's
 * address (`ip=0`). Every event carries the tenant, so the store splits
 * everything per client.
 */
import { createHash } from "node:crypto";
import { cleanUsageProps, type UsageEventName } from "@sr/shared";
import type { UsageSettings } from "../config.js";

export interface IncomingUsageEvent {
  name: string;
  /** Unix ms, as the browser saw it. */
  at: number;
  /** The event's place in its visit, from 0. */
  seq: number;
  props?: unknown;
}

export interface MixpanelEvent {
  event: UsageEventName;
  properties: Record<string, string | number | boolean>;
}

/** A browser clock this far off is not believed: the event takes the api's time. */
const CLOCK_SLACK_MS = 10 * 60_000;

/**
 * The events of one batch as Mixpanel takes them: each cleaned by the
 * catalog, tagged with the visit, the tenant, the deployment and the version,
 * timed by the browser unless its clock is far off, and given an insert id
 * from the visit and its place in it, so a batch sent twice counts once.
 * Events the catalog doesn't name are left out.
 */
/** Who sent a batch, as far as usage data may say: never the person, only these. Null without a signed-in user. */
export interface UsageViewer {
  staff: boolean;
  role: string;
}

export function viewerOf(user: { email: string; role: string } | null | undefined, s: UsageSettings): UsageViewer | null {
  if (!user) return null;
  const domain = user.email.split("@").pop()?.toLowerCase() ?? "";
  return { staff: s.staffDomains.includes(domain), role: user.role };
}

export function toMixpanel(visit: string, events: IncomingUsageEvent[], s: UsageSettings, now = Date.now(), viewer: UsageViewer | null = null): MixpanelEvent[] {
  const out: MixpanelEvent[] = [];
  for (const e of events) {
    const props = cleanUsageProps(e.name, e.props);
    if (!props) continue;
    const at = Number.isFinite(e.at) && Math.abs(now - e.at) <= CLOCK_SLACK_MS ? Math.round(e.at) : now;
    out.push({
      event: e.name as UsageEventName,
      properties: {
        ...props,
        token: s.token ?? "",
        time: at,
        distinct_id: visit,
        $insert_id: createHash("sha256").update(`${visit}:${e.seq}:${e.name}`).digest("hex").slice(0, 32),
        tenant: s.tenant,
        deployment_mode: s.deploymentMode,
        dashboard_version: s.version,
        ...(viewer ? { staff: viewer.staff, role: viewer.role } : {}),
      },
    });
  }
  return out;
}

/** One send to Mixpanel's track endpoint. Resolves to whether it took the batch; never throws. */
export async function sendToMixpanel(
  events: MixpanelEvent[],
  s: UsageSettings,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 10_000,
): Promise<{ ok: boolean; status: number | null; detail?: string }> {
  if (events.length === 0) return { ok: true, status: null };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${s.host}/track?ip=0&strict=1`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(events),
      signal: controller.signal,
    });
    if (res.ok) return { ok: true, status: res.status };
    return { ok: false, status: res.status, detail: (await res.text().catch(() => "")).slice(0, 300) };
  } catch (err) {
    return { ok: false, status: null, detail: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}
