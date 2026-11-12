"use client";

import { createContext, useContext } from "react";
import { signOut } from "next-auth/react";
import { useMe } from "@/hooks/use-me";
import { gateView, type EnrolmentVerdict } from "@/lib/enrolment-gate";
import { EnrolPanel } from "./enrol-panel";

/**
 * The server's answer to "must this person enrol", read by the layout before
 * it rendered (`lib/enrolment-verdict.ts`). Defaults to `none`, which leaves
 * the gate to the browser's own read: the right answer where accounts are off,
 * since nobody can sign in there and so nothing would ever settle a wait.
 */
const EnrolmentVerdictContext = createContext<EnrolmentVerdict>({ state: "none" });

export function EnrolmentVerdictProvider({
  verdict,
  children,
}: {
  verdict: EnrolmentVerdict;
  children: React.ReactNode;
}) {
  return (
    <EnrolmentVerdictContext.Provider value={verdict}>{children}</EnrolmentVerdictContext.Provider>
  );
}

/**
 * The way out of a screen that otherwise has none. The gate replaces the whole
 * Shell, sign-out control included, and a signed-in visit to /login bounces
 * straight back here — so somebody without their phone, or signed into the
 * wrong account on a shared machine, would be stuck for the session's thirty
 * days. Through `signOut()`, not a link to /login: the edge gate would bounce a
 * still-valid cookie straight back.
 */
export function SignOutInstead() {
  return (
    <p style={{ textAlign: "center", fontSize: 12, color: "var(--text-3)", margin: "14px 0 0" }}>
      Not you, or no phone to hand?{" "}
      <button
        type="button"
        onClick={() => void signOut({ redirectTo: "/login" })}
        style={{
          background: "none",
          border: 0,
          padding: 0,
          color: "var(--brand)",
          cursor: "pointer",
          font: "inherit",
        }}
      >
        Sign out
      </button>
    </p>
  );
}

/**
 * The screen a person meets when the dashboard is shut until they enrol.
 *
 * It wraps the app rather than living on a route of its own, and that is
 * deliberate. A redirect would fight the api: the gate's answer changes the
 * moment enrolment lands, and a route-based version has to either poll for the
 * change or bounce somebody who has just finished. Rendering in place means the
 * dashboard appears underneath as soon as `refresh()` comes back clean.
 *
 * It decides before the dashboard draws anything. The layout's server-side read
 * of the account (`EnrolmentVerdictProvider`) answers on the first render, the
 * browser's own read takes over once it lands, and with neither the gate draws
 * an empty page rather than guess — `gateView` has the rules. Decided from the
 * browser's read alone, the dashboard would be drawn for as long as that read
 * takes and then replaced.
 *
 * **This is not the enforcement.** The api refuses every request from an
 * unenrolled session; this is what the person sees instead of forty panels
 * failing. Hiding the UI is never the control.
 */
export function TwoFactorGate({ children }: { children: React.ReactNode }) {
  const verdict = useContext(EnrolmentVerdictContext);
  const { twoFactor: live, settled, refresh } = useMe();
  const { view, twoFactor } = gateView(live, verdict, settled);

  if (view === "app") return <>{children}</>;
  // The page's own background and nothing on it: no chrome to take away, and
  // no enrolment screen shown to somebody who may not need it.
  if (view === "wait") return <main aria-busy="true" style={{ minHeight: "100vh", background: "var(--bg)" }} />;

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
            twoFactor?.graceEndsAt
              ? "Your grace period has ended. Set up an authenticator app to get back into the dashboard."
              : "Everyone who uses this dashboard signs in with an authenticator app. Set one up to continue — it takes about a minute."
          }
        />
        <SignOutInstead />
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
