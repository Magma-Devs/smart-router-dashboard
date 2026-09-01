import { TraceSearch } from "@/components/trace/TraceSearch";

export default function TracePage() {
  return (
    <div className="gw-page">
      <div className="gw-card" style={{ maxWidth: 640 }}>
        <div className="gw-label" style={{ marginBottom: 8 }}>Explain a relay</div>
        <p style={{ marginTop: 0, marginBottom: 16, color: "var(--text-2)", fontSize: 13.5 }}>
          Paste a relay&rsquo;s GUID to see what the router did with it. The router returns one in
          the <code className="gw-mono">Lava-Guid</code> response header on every relay, and the
          Try-me drawer links here directly from a request you just fired.
        </p>
        <TraceSearch autoFocus />
      </div>
    </div>
  );
}
