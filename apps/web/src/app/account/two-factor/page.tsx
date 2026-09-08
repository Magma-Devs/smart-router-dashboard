"use client";

import { useRouter } from "next/navigation";
import { EnrolPanel } from "@/components/auth/enrol-panel";
import { useMe } from "@/hooks/use-me";

/**
 * Setting up an authenticator on purpose, rather than because the gate insisted.
 *
 * This is where the header countdown points: the first admin, still inside their
 * grace period, choosing to get it done. It sits outside the `(app)` group so it
 * renders without the sidebar — the same shape as `/setup` and `/invite`, which
 * are the other "finish this before carrying on" screens.
 */
export default function TwoFactorSetupPage() {
  const router = useRouter();
  const { twoFactor, refresh } = useMe();

  if (twoFactor?.enrolled) {
    return (
      <main style={wrap}>
        <div className="gw-card" style={{ padding: 28, maxWidth: 520 }}>
          <h2 style={{ margin: "0 0 6px", fontSize: 18 }}>Two-factor is on</h2>
          <p style={{ margin: "0 0 20px", fontSize: 13, color: "var(--text-3)", lineHeight: 1.55 }}>
            You will be asked for a code from your authenticator app each time you sign in. If you
            lose your phone, an administrator can reset this for you — nobody can read your key
            back, so resetting is the only way.
          </p>
          <button className="gw-btn gw-btn--primary" onClick={() => router.push("/overview")}>
            Back to the dashboard
          </button>
        </div>
      </main>
    );
  }

  return (
    <main style={wrap}>
      <div style={{ width: "100%", maxWidth: 520 }}>
        <EnrolPanel
          onEnrolled={() => {
            refresh();
            router.push("/overview");
          }}
        />
      </div>
    </main>
  );
}

const wrap: React.CSSProperties = {
  minHeight: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "var(--bg)",
  padding: 24,
};
