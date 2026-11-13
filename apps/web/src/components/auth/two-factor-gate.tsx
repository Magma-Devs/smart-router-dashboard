"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { signOut } from "next-auth/react";
import { useMe } from "@/hooks/use-me";
import { gateView, type EnrolmentVerdict } from "@/lib/enrolment-gate";
import { Spinner } from "@/components/gateway/BusyButton";
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

/** The time now, moved on once a second while `ticking`. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [ticking]);
  return now;
}

/**
 * What the gate shows while neither the server's read nor the browser's has
 * answered: no chrome to take away, and no enrolment screen shown to somebody
 * who may not need it — but something on the page, so a wait never reads as a
 * blank screen. It fades in after a moment, so the usual quick answer shows
 * nothing at all.
 *
 * While the browser's read waits out a 429 it says so, with the api's own
 * `Retry-After` counting down: a wait that names its end does not look stuck.
 */
function GateWaiting({ retrying, retryAt }: { retrying: boolean; retryAt: number | null }) {
  const now = useNow(retrying && retryAt !== null);
  const seconds = retryAt === null ? null : Math.ceil((retryAt - now) / 1000);
  return (
    <main
      aria-busy="true"
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg)",
        padding: 24,
      }}
    >
      <div
        role="status"
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 10,
          textAlign: "center",
          color: "var(--text-2)",
          fontSize: 13,
          animation: "fadeIn 220ms ease 400ms both",
        }}
      >
        <Spinner size={18} />
        <span>Checking your account…</span>
        {retrying && (
          <span style={{ color: "var(--text-3)", fontSize: 12 }}>
            {seconds !== null && seconds > 0
              ? `Too many requests just now. Trying again in ${seconds} s.`
              : seconds !== null
                ? "Trying again…"
                : "Too many requests just now. Trying again shortly."}
          </span>
        )}
      </div>
    </main>
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
 * browser's own read takes over once it lands, and with neither the gate shows
 * a loading state rather than guess — `gateView` has the rules. Decided from the
 * browser's read alone, the dashboard would be drawn for as long as that read
 * takes and then replaced.
 *
 * **This is not the enforcement.** The api refuses every request from an
 * unenrolled session; this is what the person sees instead of forty panels
 * failing. Hiding the UI is never the control.
 */
export function TwoFactorGate({ children }: { children: React.ReactNode }) {
  const verdict = useContext(EnrolmentVerdictContext);
  const { twoFactor: live, read, retryAt, refresh } = useMe();
  const { view, twoFactor } = gateView(live, verdict, read);

  if (view === "app") return <>{children}</>;
  if (view === "wait") return <GateWaiting retrying={read === "retrying"} retryAt={retryAt} />;

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
