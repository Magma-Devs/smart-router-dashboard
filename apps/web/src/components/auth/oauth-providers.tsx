import type { ReactNode } from "react";

/**
 * The OAuth providers this deployment offers, and how they are drawn.
 *
 * Shared by the sign-in form and the invitation form on purpose: with OAuth
 * sign-in link-only, redemption is the ONLY way a social account comes to
 * exist, so a provider the invitation page forgets to offer is a provider
 * nobody can ever sign in with. One list means the two screens cannot drift.
 */
export interface ProviderFlags {
  google: boolean;
  github: boolean;
}

/** Shown only for providers whose id/secret pair is set. */
export const PROVIDER_META: Array<{ id: keyof ProviderFlags; label: string; icon: ReactNode }> = [
  {
    id: "google",
    label: "Google",
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
        <path fill="#4285F4" d="M23.5 12.27c0-.85-.08-1.67-.22-2.46H12v4.65h6.45a5.52 5.52 0 0 1-2.39 3.62v3h3.87c2.26-2.09 3.57-5.16 3.57-8.81Z" />
        <path fill="#34A853" d="M12 24c3.24 0 5.95-1.07 7.93-2.91l-3.87-3c-1.07.72-2.44 1.14-4.06 1.14-3.13 0-5.78-2.11-6.73-4.96H1.29v3.1A12 12 0 0 0 12 24Z" />
        <path fill="#FBBC05" d="M5.27 14.27a7.2 7.2 0 0 1 0-4.54v-3.1H1.29a12 12 0 0 0 0 10.74l3.98-3.1Z" />
        <path fill="#EA4335" d="M12 4.77c1.76 0 3.35.61 4.6 1.8l3.44-3.44A11.96 11.96 0 0 0 12 0 12 12 0 0 0 1.29 6.63l3.98 3.1C6.22 6.88 8.87 4.77 12 4.77Z" />
      </svg>
    ),
  },
  {
    id: "github",
    label: "GitHub",
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M12 .5A11.5 11.5 0 0 0 .5 12a11.5 11.5 0 0 0 7.86 10.92c.58.1.79-.25.79-.56v-2.17c-3.2.7-3.87-1.37-3.87-1.37-.53-1.33-1.28-1.69-1.28-1.69-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.03 1.75 2.69 1.25 3.34.95.1-.74.4-1.25.72-1.53-2.55-.29-5.23-1.28-5.23-5.68 0-1.26.45-2.28 1.18-3.09-.12-.29-.51-1.45.11-3.03 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.78 0c2.2-1.49 3.16-1.18 3.16-1.18.63 1.58.24 2.74.12 3.03.74.8 1.18 1.83 1.18 3.09 0 4.41-2.69 5.38-5.25 5.66.41.36.77 1.05.77 2.13v3.16c0 .31.2.67.8.55A11.5 11.5 0 0 0 23.5 12 11.5 11.5 0 0 0 12 .5Z" />
      </svg>
    ),
  },
];

/** The enabled subset, in a stable order. */
export function enabledProviders(flags: ProviderFlags) {
  return PROVIDER_META.filter((p) => flags[p.id]);
}
