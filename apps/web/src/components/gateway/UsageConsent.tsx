"use client";

import { useState, useSyncExternalStore } from "react";
import { getServerUsageState, getUsageState, setUsageConsent, subscribeUsage, type UsageState } from "@/lib/usage";

/** Where the consent bar and the Account page send a reader for the whole policy. */
export const PRIVACY_POLICY_URL = "https://magmadevs.com/privacy";

/** Whether this deployment sends usage data, and what this browser answered. */
export function useUsageState(): UsageState {
  return useSyncExternalStore(subscribeUsage, getUsageState, getServerUsageState);
}

/**
 * The consent bar (MAG-5373): shown where the deployment sends usage data
 * (accounts on, the api says so) until the person at this browser answers.
 * Nothing is recorded, sent or kept in the browser before "Accept". The X
 * puts the question off until the next page load, with nothing sent.
 */
export function UsageConsentBar() {
  const { available, consent } = useUsageState();
  const [later, setLater] = useState(false);
  if (available !== true || consent !== null || later) return null;
  return (
    <div className="gw-consent" role="region" aria-label="Cookies and usage data">
      <p className="gw-consent__msg">
        We use cookies to keep you signed in. With your OK, this dashboard also sends anonymous usage data to Magma
        through Mixpanel, a third-party analytics service: pages opened, searches and clicks, never names, emails,
        request IDs or anything typed. See our{" "}
        <a href={PRIVACY_POLICY_URL} target="_blank" rel="noreferrer">Privacy Policy</a> for details.
      </p>
      <div className="gw-consent__actions">
        <button type="button" className="gw-btn" onClick={() => setUsageConsent("rejected")}>Reject non-essential</button>
        <button type="button" className="gw-btn gw-btn--primary" onClick={() => setUsageConsent("accepted")}>Accept</button>
        <button type="button" className="gw-consent__later" aria-label="Decide later" title="Decide later" onClick={() => setLater(true)}>
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}
