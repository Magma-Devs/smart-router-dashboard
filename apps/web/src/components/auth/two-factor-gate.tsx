"use client";

import { useMe } from "@/hooks/use-me";
import { EnrolPanel } from "./enrol-panel";

/**
 * The screen a person meets when the dashboard is shut until they enrol.
 *
 * It wraps the app rather than living on a route of its own, and that is
 * deliberate. A redirect would fight the api: the gate's answer changes the
 * moment enrolment lands, and a route-based version has to either poll for the
 * change or bounce somebody who has just finished. Rendering in place means the
 * dashboard appears underneath as soon as `refresh()` comes back clean.
 *
 * **This is not the enforcement.** The api refuses every request from an
 * unenrolled session; this is what the person sees instead of forty panels
 * failing. Hiding the UI is never the control.
 */
export function TwoFactorGate({ children }: { children: React.ReactNode }) {
  const { me, twoFactor, refresh } = useMe();

  // Nothing known yet — AUTH_MODE=disabled (where these routes are not even
  // registered), or the first read is still in flight. Rendering the block on a
  // guess would flash it at everyone on every cold load.
  if (!twoFactor?.enrolmentRequired) return <>{children}</>;

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg)",
        padding: 24,
      }}
    >
      <div style={{ width: "100%", maxWidth: 520 }}>
        <EnrolPanel
          onEnrolled={refresh}
          heading="Two-factor authentication is required"
          intro={
            // Two ways to arrive here and they need different words. Somebody
            // whose admin reset them is not being asked to do something new,
            // and telling them "your organisation requires this" when what
            // actually happened is "an administrator cleared your phone" leaves
            // them wondering whether something is wrong.
            me?.twoFactor?.graceEndsAt
              ? "Your grace period has ended. Set up an authenticator app to get back into the dashboard."
              : "Everyone who uses this dashboard signs in with an authenticator app. Set one up to continue — it takes about a minute."
          }
        />
      </div>
    </main>
  );
}

/**
 * The countdown in the header, for the one account that may defer.
 *
 * A permanent strip rather than a dismissible banner, because a dismissible one
 * is dismissed on day one and never seen again — and the thing it is counting
 * down to is the dashboard closing. It renders only while there is a countdown
 * to show; everybody else has either enrolled or been stopped by the gate.
 */
export function TwoFactorCountdown() {
  const { twoFactor } = useMe();
  if (!twoFactor || twoFactor.enrolled || twoFactor.daysLeft === null) return null;
  if (twoFactor.enrolmentRequired) return null;

  const days = twoFactor.daysLeft;
  // Under a week it stops being a note and starts being a deadline.
  const urgent = days <= 7;

  return (
    <a
      href="/account/two-factor"
      className="pill"
      style={{
        textDecoration: "none",
        color: urgent ? "var(--danger, #f43)" : "var(--text-2)",
        borderColor: urgent ? "var(--danger, #f43)" : undefined,
        whiteSpace: "nowrap",
      }}
      title="Set up an authenticator app before the dashboard closes"
    >
      Set up 2FA — {days} day{days === 1 ? "" : "s"} left
    </a>
  );
}
