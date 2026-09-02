import { TraceSearch } from "@/components/trace/TraceSearch";
import { TraceAiSettingsCard } from "@/components/trace/TraceAiSettingsCard";

export default function TracePage() {
  return (
    <div className="gw-page" style={{ display: "flex", flexDirection: "column", gap: "var(--gap-card)", maxWidth: 640 }}>
      <div className="gw-card">
        <div className="gw-label" style={{ marginBottom: 8 }}>Investigate a relay</div>
        <p style={{ marginTop: 0, marginBottom: 16, color: "var(--text-2)", fontSize: 13.5 }}>
          Paste a relay&rsquo;s GUID to see what the router did with it. The router returns one in
          the <code className="gw-mono">Lava-Guid</code> response header on every relay, and the
          Try-me drawer links here directly from a request you just fired.
        </p>
        <TraceSearch autoFocus />
      </div>

      {/* The model settings live here rather than in Account: they configure
          this one feature, and putting them where the feature is means nobody
          has to go looking for them. */}
      <TraceAiSettingsCard />
    </div>
  );
}
