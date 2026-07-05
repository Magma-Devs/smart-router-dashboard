"use client";

/* ADD SHEET — credential steps. Ported verbatim from the design prototype
 * (page-providers.jsx StepConfigureA / StepConfigureB / StepCustomUrl /
 * StepJwt / NodeConfigSection). Two self-hosted substitutions:
 *   · chain <select>s list the LIVE chains from the mounted config
 *     (spec-keyed) instead of the design's mock CHAINS global;
 *   · NodeConfigSection derives interface options from the live router's
 *     own `interfaces` (falling back to the design's CHAIN_IFACES table). */

import { useEffect, useMemo, useState } from "react";
import {
  CHAIN_IFACES,
  IFACE_LABEL,
  PROVIDER_CATALOG,
  isEvmSpec,
  parseJwtExpiry,
  specToDesignChainId,
  type ProviderCatalogEntry,
} from "@/components/providers/catalog";
import {
  EncNote,
  FE,
  FL,
  Hint,
  ProviderIdentityRow,
  SecretInput,
  UrlParserPreview,
  type LiveChain,
} from "@/components/providers/bits";
import { ProviderLogo } from "@/components/providers/ProviderLogo";

/** Credential-form payload (the design's onSubmit object shapes, unified). */
export interface CredData {
  name: string;
  flow: "A" | "B" | "URL" | "JWT";
  catalogId: string;
  key?: string;
  urls?: string[];
  url?: string;
  chainId?: string;
  authHeader?: string | null;
  authValue?: string | null;
  mode?: "preissued" | "signing";
  token?: string;
  alg?: string;
  pem?: string;
  kid?: string;
  expiry?: string;
}

export interface Caps { archive: boolean; debug: boolean; trace: boolean }

/* ─────────────────────────────────────────────
   ADD SHEET — Step 3A (account API key)
───────────────────────────────────────────── */
export function StepConfigureA({ catalog, onSubmit, onSwitchJwt }: {
  catalog: ProviderCatalogEntry;
  onSubmit: (d: CredData) => void;
  onSwitchJwt: () => void;
}) {
  const [name, setName] = useState(catalog.name);
  const [key, setKey] = useState("");
  const [errors, setE] = useState<{ key?: string }>({});
  const validate = () => {
    const e: { key?: string } = {};
    if (!key.trim()) e.key = "API key is required";
    else if (key.includes(" ")) e.key = "No spaces allowed";
    setE(e); return !Object.keys(e).length;
  };
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <ProviderIdentityRow catalog={catalog} sub="Account API key · Step 3 of 3" />
      <div>
        <FL>Display name <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>(optional)</span></FL>
        <input className="gw-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
      </div>
      <div>
        <FL>API key</FL>
        <SecretInput value={key} onChange={(e) => setKey(e.target.value)} placeholder={`Your ${catalog.name} API key`} />
        <FE msg={errors.key} />
      </div>
      <EncNote />
      {catalog.supportsJWT && (
        <div style={{ fontSize: 12, color: "var(--text-3)" }}>
          Prefer token-based auth?{" "}
          <button onClick={onSwitchJwt} style={{ border: "none", background: "none", color: "var(--brand)", cursor: "pointer", padding: 0, fontSize: 12, fontWeight: 600, fontFamily: "inherit" }}>Use JWT →</button>
        </div>
      )}
      <button id="__pv-submit" style={{ display: "none" }} onClick={() => { if (validate()) onSubmit({ name, key, flow: "A", catalogId: catalog.id }); }} />
    </div>
  );
}

/* ─────────────────────────────────────────────
   ADD SHEET — Step 3B (paste endpoint URLs)
───────────────────────────────────────────── */
export function StepConfigureB({ catalog, onSubmit, onBack }: {
  catalog: ProviderCatalogEntry;
  onSubmit: (d: CredData) => void;
  onBack: () => void;
}) {
  const [name, setName] = useState(catalog.name);
  const [raw, setRaw] = useState("");
  const [showAuth, setShowAuth] = useState(false);
  const [hName, setHName] = useState("x-token");
  const [hVal, setHVal] = useState("");
  const [errors, setE] = useState<{ raw?: string }>({});
  const valid = raw.split("\n").map((u) => u.trim()).filter((u) => u.startsWith("https://") || u.startsWith("wss://"));
  const altProvider = useMemo(() => {
    const u = raw.split("\n").find((line) => { const a = PROVIDER_CATALOG.find((p) => p.domainPattern && p.domainPattern.test(line)); return a && a.id !== catalog.id; });
    return u ? PROVIDER_CATALOG.find((p) => p.domainPattern && p.domainPattern.test(u)) : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw]);
  const validate = () => {
    const e: { raw?: string } = {};
    if (!valid.length) e.raw = "At least one https:// URL is required";
    setE(e); return !Object.keys(e).length;
  };
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <ProviderIdentityRow catalog={catalog} sub="Endpoint URLs · Step 3 of 3" />
      <div>
        <FL>Display name <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>(optional)</span></FL>
        <input className="gw-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
      </div>
      <div>
        <FL>Endpoint URLs <span style={{ color: "var(--text-3)", fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>— one per line</span></FL>
        <textarea className="gw-input gw-mono" rows={5} value={raw} onChange={(e) => setRaw(e.target.value)}
          placeholder={"https://your-endpoint.quiknode.pro/abc123/\nhttps://your-endpoint-2.quiknode.pro/def456/"} style={{ fontSize: 11, resize: "vertical" }} />
        <FE msg={errors.raw} />
        {altProvider && <Hint type="warn">Looks like a <strong>{altProvider.name}</strong> endpoint — <button onClick={onBack} style={{ border: "none", background: "none", color: "var(--brand)", cursor: "pointer", padding: 0, fontSize: 12, fontWeight: 600, fontFamily: "inherit" }}>use that preset instead</button>.</Hint>}
        <UrlParserPreview urls={raw.split("\n")} catalog={catalog} />
      </div>
      <div>
        <button onClick={() => setShowAuth((s) => !s)} style={{ display: "flex", alignItems: "center", gap: 7, border: "none", background: "none", color: "var(--text-2)", cursor: "pointer", fontSize: 12, fontWeight: 500, padding: 0, fontFamily: "inherit" }}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: showAuth ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}><polyline points="9 18 15 12 9 6"/></svg>
          Auth header <span style={{ color: "var(--text-4)", fontWeight: 400, marginLeft: 2 }}>(optional)</span>
        </button>
        {showAuth && (
          <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "1fr 2fr", gap: 8 }}>
            <div><FL>Header name</FL><input className="gw-input gw-mono" value={hName} onChange={(e) => setHName(e.target.value)} style={{ fontSize: 12 }} /></div>
            <div><FL>Value</FL><SecretInput value={hVal} onChange={(e) => setHVal(e.target.value)} placeholder="secret-value" /></div>
          </div>
        )}
      </div>
      <EncNote />
      <button id="__pv-submit" style={{ display: "none" }} onClick={() => { if (validate()) onSubmit({ name, urls: valid, authHeader: showAuth ? hName : null, authValue: showAuth ? hVal : null, flow: "B", catalogId: catalog.id }); }} />
    </div>
  );
}

/* ─────────────────────────────────────────────
   ADD SHEET — Custom URL flow
───────────────────────────────────────────── */
export function StepCustomUrl({ chains, onSubmit }: { chains: LiveChain[]; onSubmit: (d: CredData) => void }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [chainId, setChainId] = useState(chains[0]?.spec ?? "");
  const [showH, setShowH] = useState(false);
  const [hName, setHName] = useState("x-api-key");
  const [hVal, setHVal] = useState("");
  const [errors, setE] = useState<{ name?: string; url?: string }>({});
  const knownProvider = useMemo(() => PROVIDER_CATALOG.find((p) => p.domainPattern && p.domainPattern.test(url)), [url]);
  const looksPrivate = useMemo(() => /^https?:\/\/(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|localhost|127\.|.*\.internal\b|.*\.lan\b)/.test(url), [url]);
  const validate = () => {
    const e: { name?: string; url?: string } = {};
    if (!name.trim()) e.name = "Display name is required";
    if (!url.trim()) e.url = "URL is required";
    else if (!url.startsWith("https://") && !url.startsWith("wss://")) e.url = "Must start with https:// or wss://";
    setE(e); return !Object.keys(e).length;
  };
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center", padding: "12px 14px", borderRadius: 10, background: "var(--bg)", border: "1px solid var(--line)" }}>
        <div style={{ width: 36, height: 36, borderRadius: 9, background: "var(--surface-2)", border: "1px solid var(--line-2)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-2)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
        </div>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Custom URL</div>
          <div style={{ fontSize: 11, color: "var(--text-3)" }}>Step 2 of 2</div>
        </div>
      </div>
      <div><FL>Display name <span style={{ color: "var(--err)" }}>*</span></FL>
        <input className="gw-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="e.g. My Ethereum Node" />
        <FE msg={errors.name} />
      </div>
      <div><FL>Endpoint URL <span style={{ color: "var(--err)" }}>*</span></FL>
        <input className="gw-input gw-mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://your-node.example.com/rpc" style={{ fontSize: 12 }} />
        <FE msg={errors.url} />
        {knownProvider && <Hint type="warn">Looks like <strong>{knownProvider.name}</strong> — you can use that preset for easier setup.</Hint>}
        {looksPrivate && !knownProvider && <Hint type="info">This looks like a private node — make sure it&apos;s reachable from our routing layer.</Hint>}
      </div>
      <div><FL>Chain <span style={{ color: "var(--err)" }}>*</span></FL>
        <select className="gw-input" value={chainId} onChange={(e) => setChainId(e.target.value)} style={{ fontSize: 13 }}>
          {chains.map((c) => <option key={c.spec} value={c.spec}>{c.name}</option>)}
        </select>
      </div>
      <div>
        <button onClick={() => setShowH((s) => !s)} style={{ display: "flex", alignItems: "center", gap: 7, border: "none", background: "none", color: "var(--text-2)", cursor: "pointer", fontSize: 12, fontWeight: 500, padding: 0, fontFamily: "inherit" }}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: showH ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}><polyline points="9 18 15 12 9 6"/></svg>
          Custom header <span style={{ color: "var(--text-4)", fontWeight: 400, marginLeft: 2 }}>(optional)</span>
        </button>
        {showH && (
          <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "1fr 2fr", gap: 8 }}>
            <div><FL>Header name</FL><input className="gw-input gw-mono" value={hName} onChange={(e) => setHName(e.target.value)} style={{ fontSize: 12 }} /></div>
            <div><FL>Value</FL><SecretInput value={hVal} onChange={(e) => setHVal(e.target.value)} placeholder="secret" /></div>
          </div>
        )}
      </div>
      <EncNote />
      <button id="__pv-submit" style={{ display: "none" }} onClick={() => { if (validate()) onSubmit({ name, url, chainId, authHeader: showH ? hName : null, authValue: showH ? hVal : null, flow: "URL", catalogId: "custom" }); }} />
    </div>
  );
}

/* ─────────────────────────────────────────────
   ADD SHEET — JWT flow
───────────────────────────────────────────── */
export function StepJwt({ catalog, chains, onSubmit }: {
  catalog: ProviderCatalogEntry | null;
  chains: LiveChain[];
  onSubmit: (d: CredData) => void;
}) {
  const [name, setName] = useState(catalog?.name || "");
  const [url, setUrl] = useState("");
  const [chainId, setCh] = useState(chains[0]?.spec ?? "");
  const [mode, setMode] = useState<"preissued" | "signing">("preissued");
  const [token, setToken] = useState("");
  const [alg, setAlg] = useState("RS256");
  const [pem, setPem] = useState("");
  const [kid, setKid] = useState("");
  const [expiry, setExp] = useState("60");
  const [errors, setE] = useState<{ name?: string; url?: string; token?: string; pem?: string; kid?: string }>({});

  const jwtExp = useMemo(() => token ? parseJwtExpiry(token) : null, [token]);
  const isExpired = !!jwtExp && jwtExp < new Date();
  const nearExp = !!jwtExp && !isExpired && (jwtExp.getTime() - Date.now()) < 86400000;

  const validate = () => {
    const e: { name?: string; url?: string; token?: string; pem?: string; kid?: string } = {};
    if (!name.trim()) e.name = "Display name is required";
    if (!url.trim()) e.url = "URL is required";
    else if (!url.startsWith("https://") && !url.startsWith("wss://")) e.url = "Must start with https:// or wss://";
    if (mode === "preissued") {
      if (!token.trim()) e.token = "JWT is required";
      else if (token.split(".").length !== 3) e.token = "Not a valid JWT (expected 3 dot-separated parts)";
      else if (isExpired) e.token = "This token is expired — paste a fresh one.";
    } else {
      if (!pem.trim()) e.pem = "Private key is required";
      else if (!pem.includes("PRIVATE KEY")) e.pem = "Expected PEM format: -----BEGIN [RSA/EC] PRIVATE KEY-----";
      if (!kid.trim()) e.kid = "Key ID (kid) is required";
    }
    setE(e); return !Object.keys(e).length;
  };

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center", padding: "12px 14px", borderRadius: 10, background: "var(--bg)", border: "1px solid var(--line)" }}>
        {catalog
          ? <ProviderLogo id={catalog.id} size={36} />
          : <div style={{ width: 36, height: 36, borderRadius: 9, background: "var(--surface-2)", border: "1px solid var(--line-2)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-2)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/></svg>
            </div>
        }
        <div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{catalog?.name || "JWT"}</div>
          <div style={{ fontSize: 11, color: "var(--text-3)" }}>JWT authentication · Step {catalog ? "3" : "2"} of {catalog ? "3" : "2"}</div>
        </div>
      </div>

      <div><FL>Display name <span style={{ color: "var(--err)" }}>*</span></FL>
        <input className="gw-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} /><FE msg={errors.name} />
      </div>
      <div><FL>Endpoint URL <span style={{ color: "var(--err)" }}>*</span></FL>
        <input className="gw-input gw-mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://your-provider.example.com/rpc" style={{ fontSize: 12 }} /><FE msg={errors.url} />
      </div>
      <div><FL>Chain</FL>
        <select className="gw-input" value={chainId} onChange={(e) => setCh(e.target.value)} style={{ fontSize: 13 }}>
          {chains.map((c) => <option key={c.spec} value={c.spec}>{c.name}</option>)}
        </select>
      </div>

      <div><FL>JWT mode</FL>
        <div style={{ display: "flex", gap: 8 }}>
          {([["preissued", "Pre-issued token"], ["signing", "Signing key (we mint)"]] as const).map(([v, lbl]) => (
            <button key={v} onClick={() => setMode(v)} style={{ flex: 1, padding: "8px 10px", borderRadius: 8, fontSize: 12, fontWeight: 500, cursor: "pointer", fontFamily: "inherit",
              border: "1px solid " + (mode === v ? "var(--brand)" : "var(--line)"),
              background: mode === v ? "rgba(255,57,0,0.07)" : "var(--bg)",
              color: mode === v ? "var(--brand)" : "var(--text-2)" }}>{lbl}</button>
          ))}
        </div>
      </div>

      {mode === "preissued" ? (
        <div>
          <FL>JWT token <span style={{ color: "var(--err)" }}>*</span></FL>
          <SecretInput rows={4} value={token} onChange={(e) => setToken(e.target.value)} placeholder="eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9…" />
          <FE msg={errors.token} />
          {jwtExp && !isExpired && !nearExp && <div style={{ fontSize: 11, color: "var(--ok)", marginTop: 5 }}>✓ Expires {jwtExp.toLocaleString()}</div>}
          {nearExp && <Hint type="warn">Expires soon — {jwtExp?.toLocaleString()}. You&apos;ll need to rotate this.</Hint>}
          {isExpired && <Hint type="err">This token expired on {jwtExp?.toLocaleString()}.</Hint>}
        </div>
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          <div><FL>Algorithm</FL>
            <select className="gw-input" value={alg} onChange={(e) => setAlg(e.target.value)} style={{ fontSize: 13 }}>
              <option value="RS256">RS256 (RSA)</option><option value="ES256">ES256 (ECDSA)</option>
            </select>
          </div>
          <div><FL>Private key (PEM) <span style={{ color: "var(--err)" }}>*</span></FL>
            <SecretInput rows={5} value={pem} onChange={(e) => setPem(e.target.value)} placeholder={"-----BEGIN RSA PRIVATE KEY-----\n…\n-----END RSA PRIVATE KEY-----"} />
            <FE msg={errors.pem} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <div><FL>kid (Key ID) <span style={{ color: "var(--err)" }}>*</span></FL>
              <input className="gw-input gw-mono" value={kid} onChange={(e) => setKid(e.target.value)} style={{ fontSize: 12 }} placeholder="my-key-1" /><FE msg={errors.kid} />
            </div>
            <div><FL>Token TTL (seconds)</FL>
              <input className="gw-input gw-mono" type="number" min="10" value={expiry} onChange={(e) => setExp(e.target.value)} style={{ fontSize: 12 }} />
            </div>
          </div>
          <Hint type="info">We mint a fresh JWT per outbound request using your key — your signing key is never forwarded.</Hint>
        </div>
      )}
      <EncNote />
      <button id="__pv-submit" style={{ display: "none" }} onClick={() => { if (validate()) onSubmit({ name, url, chainId, mode, token, alg, pem, kid, expiry, flow: "JWT", catalogId: catalog?.id || "jwt" }); }} />
    </div>
  );
}

/* ─────────────────────────────────────────────
   Node Config Section — controlled, inline
   Used inside the Configure step (no hidden submit button)
───────────────────────────────────────────── */
export function NodeConfigSection({ chainId, setChainId, role, setRole, iface, setIface, caps, setCaps, chains, ifacesBySpec }: {
  chainId: string;
  setChainId: (v: string) => void;
  role: "primary" | "backup";
  setRole: (v: "primary" | "backup") => void;
  iface: string;
  setIface: (v: string) => void;
  caps: Caps;
  setCaps: (fn: (prev: Caps) => Caps) => void;
  chains: LiveChain[];
  ifacesBySpec: Record<string, string[]>;
}) {
  const availIfaces = ifacesBySpec[chainId]
    ?? CHAIN_IFACES[specToDesignChainId(chainId) ?? ""]
    ?? ["jsonrpc"];
  const isEvm = isEvmSpec(chainId);

  useEffect(() => {
    if (!availIfaces.includes(iface)) setIface(availIfaces[0] ?? "jsonrpc");
    setCaps(() => ({ archive: false, debug: false, trace: false }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainId]);

  const toggleCap = (k: keyof Caps) => setCaps((prev) => ({ ...prev, [k]: !prev[k] }));

  return (
    <div style={{ display: "grid", gap: 14 }}>

      {/* Chain */}
      <div>
        <FL>Chain</FL>
        <select className="gw-input" value={chainId} onChange={(e) => setChainId(e.target.value)} style={{ fontSize: 13 }}>
          {chains.map((c) => <option key={c.spec} value={c.spec}>{c.name}</option>)}
        </select>
      </div>

      {/* Role */}
      <div>
        <FL>Role</FL>
        <div style={{ display: "flex", gap: 8 }}>
          {([["primary", "Primary"], ["backup", "Backup"]] as const).map(([v, lbl]) => (
            <button key={v} onClick={() => setRole(v)} style={{
              flex: 1, padding: "9px 12px", borderRadius: 8, fontSize: 13, fontWeight: 500,
              cursor: "pointer", fontFamily: "inherit",
              border: "1px solid " + (role === v ? "var(--brand)" : "var(--line)"),
              background: role === v ? "rgba(255,57,0,0.07)" : "var(--bg)",
              color: role === v ? "var(--brand)" : "var(--text-2)",
            }}>{lbl}</button>
          ))}
        </div>
        <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 5 }}>
          {role === "primary"
            ? "Receives traffic first. Backup is used only when all primaries are unreachable."
            : "Used as fallback when all primary nodes are degraded or unreachable."}
        </div>
      </div>

      {/* Interface — single select */}
      <div>
        <FL>Interface</FL>
        <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
          {availIfaces.map((i) => (
            <button key={i} onClick={() => setIface(i)} style={{
              padding: "7px 14px", borderRadius: 7, fontSize: 12, fontWeight: 500,
              cursor: "pointer", fontFamily: "inherit",
              border: "1px solid " + (iface === i ? "var(--brand)" : "var(--line)"),
              background: iface === i ? "rgba(255,57,0,0.07)" : "var(--bg)",
              color: iface === i ? "var(--brand)" : "var(--text-2)",
            }}>{IFACE_LABEL[i] || i}</button>
          ))}
        </div>
      </div>

      {/* EVM capabilities — multi-select, none is valid */}
      {isEvm && (
        <div>
          <FL>Capabilities <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0, color: "var(--text-3)" }}>— select all that apply, or none</span></FL>
          <div style={{ display: "grid", gap: 5 }}>
            {([
              ["archive", "Archive", "Historical state — eth_getStorageAt at any past block"],
              ["debug", "Debug", "debug_traceTransaction, debug_traceBlock"],
              ["trace", "Trace", "trace_block, trace_transaction (OpenEthereum-style)"],
            ] as const).map(([k, label, desc]) => {
              const on = caps[k];
              return (
                <button key={k} onClick={() => toggleCap(k)} style={{
                  display: "flex", alignItems: "center", gap: 12, padding: "9px 12px",
                  borderRadius: 8, cursor: "pointer", fontFamily: "inherit",
                  textAlign: "left", width: "100%",
                  border: "1px solid " + (on ? "rgba(96,165,250,0.4)" : "var(--line)"),
                  background: on ? "rgba(96,165,250,0.06)" : "var(--bg)",
                }}>
                  <div style={{
                    width: 16, height: 16, borderRadius: 4, flexShrink: 0,
                    border: "1.5px solid " + (on ? "#60a5fa" : "var(--line-2)"),
                    background: on ? "#60a5fa" : "transparent",
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}>
                    {on && <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>}
                  </div>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: on ? "#60a5fa" : "var(--text)" }}>{label}</div>
                    <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 1 }}>{desc}</div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
