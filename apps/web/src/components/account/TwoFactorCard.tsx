"use client";

import Link from "next/link";
import { useMe } from "@/hooks/use-me";

/**
 * Your own two-factor state, on your own account page.
 *
 * There is no "turn it off" button, and its absence is the design. The only way
 * back from an enrolled account is an admin reset, which is logged and names
 * both people — a self-service disable would be a second way out that names
 * nobody, and whoever held a stolen session could take it.
 */
export function TwoFactorCard() {
  const { twoFactor } = useMe();
  if (!twoFactor) return null;

  const deferring = !twoFactor.enrolled && twoFactor.daysLeft !== null;

  return (
    <div className="gw-card" style={{ marginBottom: 14, padding: 18 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>
            Two-factor authentication
          </div>
          <div style={{ fontSize: 12.5, color: "var(--text-3)", lineHeight: 1.6, maxWidth: 560 }}>
            {twoFactor.enrolled ? (
              <>
                On. You are asked for a code from your authenticator app each time you sign in. If
                you lose your phone, an administrator can reset it — nobody can read your key back,
                so that is the only way.
              </>
            ) : deferring ? (
              <>
                Not set up. You have{" "}
                <strong style={{ color: "var(--text-2)" }}>
                  {twoFactor.daysLeft} day{twoFactor.daysLeft === 1 ? "" : "s"}
                </strong>{" "}
                left, and the dashboard closes after that. Inviting anyone needs it first.
              </>
            ) : (
              <>Not set up.</>
            )}
          </div>
        </div>
        {twoFactor.enrolled ? (
          <span className="pill" style={{ whiteSpace: "nowrap" }}>
            <span className="dot-ok" /> On
          </span>
        ) : (
          <Link
            href="/account/two-factor"
            className="gw-btn gw-btn--primary"
            style={{ textDecoration: "none", whiteSpace: "nowrap" }}
          >
            Set up
          </Link>
        )}
      </div>
    </div>
  );
}
