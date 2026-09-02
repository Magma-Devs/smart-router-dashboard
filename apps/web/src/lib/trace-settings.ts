/**
 * Per-person model settings for the Relay Investigator explanation.
 *
 * These live in the BROWSER and are sent with each ask. The key never reaches
 * the server's disk — the api uses it for that one call and drops it. That is
 * what makes "bring your own key" real: each person spends their own budget,
 * and a deployment holds no secret that everyone who can reach it could spend.
 *
 * The tradeoff, stated on the settings page rather than buried here: anything
 * able to run script in this origin can read `localStorage`. For a key scoped
 * to one person's own model spend that is a reasonable trade; for anything
 * with broader authority it would not be.
 *
 * Same storage idiom the dashboard already uses for `sr:theme` and
 * `sr:window`, including the try/catch — private mode and blocked site data
 * make every one of these calls throw.
 */
import type { TraceAiProviderId, TraceAiSettings } from "@sr/shared";

const STORAGE_KEY = "sr:traceAi";

/** Shown as the field placeholder, and what the api falls back to when the
 *  model is left blank. Kept in step with the api's own defaults. */
export const PROVIDER_DEFAULT_MODEL: Record<TraceAiProviderId, string> = {
  anthropic: "claude-sonnet-5",
  gemini: "gemini-3.6-flash",
};

export const PROVIDER_LABEL: Record<TraceAiProviderId, string> = {
  anthropic: "Anthropic",
  gemini: "Google Gemini",
};

/** Where each provider issues keys — worth linking rather than making people
 *  hunt for it. */
export const PROVIDER_KEY_URL: Record<TraceAiProviderId, string> = {
  anthropic: "https://console.anthropic.com/settings/keys",
  gemini: "https://aistudio.google.com/apikey",
};

export const EMPTY_SETTINGS: TraceAiSettings = { provider: "anthropic", model: "", apiKey: "" };

/** Saved settings, or null when there are none (or storage is unavailable). */
export function loadTraceSettings(): TraceAiSettings | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<TraceAiSettings>;
    const provider: TraceAiProviderId = parsed.provider === "gemini" ? "gemini" : "anthropic";
    return {
      provider,
      model: typeof parsed.model === "string" ? parsed.model : "",
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : "",
    };
  } catch {
    // Unparseable or unavailable — behave as if nothing was ever saved rather
    // than breaking the page that reads this.
    return null;
  }
}

export function saveTraceSettings(s: TraceAiSettings): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* private mode / blocked site data — the settings just don't persist */
  }
}

export function clearTraceSettings(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to do */
  }
}

/** Only settings carrying a key are usable — provider and model alone cannot
 *  ask anything. */
export function hasUsableKey(s: TraceAiSettings | null): s is TraceAiSettings {
  return s !== null && s.apiKey.trim() !== "";
}

/** `sk-ant-…AbCd` — enough to recognise which key is saved, not enough to use.
 *  The full value is never rendered back into the DOM. */
export function maskKey(key: string): string {
  const k = key.trim();
  if (k.length <= 8) return "••••";
  return `${k.slice(0, 6)}…${k.slice(-4)}`;
}
