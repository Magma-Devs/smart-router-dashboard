"use client";

import { useSyncExternalStore } from "react";
import { getServerUsageState, getUsageState, setUsageConsent, subscribeUsage, type UsageState } from "@/lib/usage";

/** Magma's policies, as magmadevs.com publishes them. The consent banner and the Account page link both. */
export const PRIVACY_POLICY_URL = "https://magmadevs.com/privacy";
export const TERMS_URL = "https://magmadevs.com/terms";

/** Whether this deployment sends usage data, and what this browser answered. */
export function useUsageState(): UsageState {
  return useSyncExternalStore(subscribeUsage, getUsageState, getServerUsageState);
}

/**
 * The two policies, as links that open beside the dashboard. `short` is the
 * banner's form: one word each, the whole name read out.
 */
export function PolicyLinks({ className, short }: { className?: string; short?: boolean }) {
  return (
    <span className={className}>
      <a href={PRIVACY_POLICY_URL} target="_blank" rel="noopener noreferrer" aria-label="Privacy Policy">
        {short ? "Privacy" : "Privacy Policy"}
      </a>
      {short ? " · " : " and "}
      <a href={TERMS_URL} target="_blank" rel="noopener noreferrer" aria-label="Terms & Conditions">
        {short ? "Terms" : <>Terms &amp; Conditions</>}
      </a>
    </span>
  );
}

/**
 * The consent banner (MAG-5373): a card docked bottom-right where the
 * deployment records usage data (accounts on, the api says so), until the
 * person at this browser answers. Mixpanel is not loaded, and nothing is
 * recorded, sent or kept in the browser, before "Accept". The X is a "no": it
 * is kept like "Decline", and the Account page turns usage data on later. A
 * region, not a dialog: the page behind it stays in use.
 */
export function UsageConsentBar() {
  const { available, consent } = useUsageState();
  if (available !== true || consent !== null) return null;
  return (
    <div className="gw-consent" role="region" aria-labelledby="gw-consent-title">
      <div className="gw-consent__head">
        <span className="gw-consent__icon" aria-hidden="true">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5" />
            <path d="M8.5 8.5v.01M16 15.5v.01M12 12v.01M11 17v.01M7 14v.01" />
          </svg>
        </span>
        <p id="gw-consent-title" className="gw-consent__title">Cookies &amp; analytics</p>
        <button type="button" className="gw-consent__close" aria-label="Dismiss cookie banner" onClick={() => setUsageConsent("dismissed")}>
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <p className="gw-consent__body">
        Essential cookies keep you signed in. With your OK, Mixpanel also records clicks, pages and session replays, with
        text hidden.
      </p>
      <div className="gw-consent__foot">
        <PolicyLinks short className="gw-consent__links" />
        <div className="gw-consent__actions">
          <button type="button" className="gw-btn gw-consent__btn" onClick={() => setUsageConsent("rejected")}>
            Decline
          </button>
          <button type="button" className="gw-btn gw-btn--primary gw-consent__btn" onClick={() => setUsageConsent("accepted")}>
            Accept
          </button>
        </div>
      </div>
    </div>
  );
}
