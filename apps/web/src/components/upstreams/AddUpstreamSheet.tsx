"use client";

/* Add Upstream Sheet — orchestrator, ported from the design prototype
 * (page-providers.jsx AddUpstreamSheet). Configure + Node are one merged
 * step. SELF-HOSTED: the full wizard renders (entry type → preset grid →
 * configure → JWT → probe chrome) but the final "Save upstream" commit is
 * disabled — the config is a read-only mount. */

import { useEffect, useState } from "react";
import { Modal } from "@/components/gateway/Modal";
import { READONLY_MSG, type UpstreamCatalogEntry } from "@/components/upstreams/catalog";
import { type LiveChain } from "@/components/upstreams/bits";
import { Step1EntryType, StepPickPreset, type EntryType } from "@/components/upstreams/steps/entry";
import {
  NodeConfigSection,
  StepConfigureA,
  StepConfigureB,
  StepCustomUrl,
  StepJwt,
  type Caps,
  type CredData,
} from "@/components/upstreams/steps/configure";
import { ProbeStep } from "@/components/upstreams/steps/probe";

interface PendingData extends CredData {
  catalog: UpstreamCatalogEntry | null;
  role?: "primary" | "backup";
  interfaces?: string[];
  capabilities?: Partial<Caps>;
}

export function AddUpstreamSheet({ open, onClose, existingIds, chains, ifacesBySpec }: {
  open: boolean;
  onClose: () => void;
  /** Catalog ids already matched to config nodes (dims their preset tiles). */
  existingIds: string[];
  /** Live chains from the mounted config (spec-keyed). */
  chains: LiveChain[];
  /** spec → interfaces the router actually exposes. */
  ifacesBySpec: Record<string, string[]>;
}) {
  const [step, setStep] = useState(1);
  const [type, setType] = useState<EntryType | null>(null);
  const [catalog, setCatalog] = useState<UpstreamCatalogEntry | null>(null);
  const [probing, setProbing] = useState(false);
  const [probeReady, setProbeReady] = useState(false);
  const [pendingData, setPending] = useState<PendingData | null>(null);

  /* Node config state — lifted here so it's available when credential form submits */
  const [ncChain, setNcChain] = useState(chains[0]?.spec ?? "");
  const [ncRole, setNcRole] = useState<"primary" | "backup">("primary");
  const [ncIface, setNcIface] = useState("jsonrpc");
  const [ncCaps, setNcCaps] = useState<Caps>({ archive: false, debug: false, trace: false });

  useEffect(() => {
    if (open) {
      setStep(1); setType(null); setCatalog(null);
      setProbing(false); setProbeReady(false); setPending(null);
      setNcChain(chains[0]?.spec ?? ""); setNcRole("primary"); setNcIface("jsonrpc");
      setNcCaps({ archive: false, debug: false, trace: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /* Credential form submits:
     - UPSTREAM preset (flow A/B): backend holds chain/interface/caps spec → no node config needed
     - Custom URL / JWT: user's own node → collect chain/role/interface/caps from NodeConfigSection */
  const submit = (credData: CredData) => {
    const isPreset = type === "UPSTREAM";
    if (isPreset) {
      setPending({ ...credData, catalog });
    } else {
      const availIfaces = ifacesBySpec[ncChain] ?? ["jsonrpc"];
      const liveIface = availIfaces.includes(ncIface) ? ncIface : (availIfaces[0] ?? "jsonrpc");
      setPending({
        ...credData, catalog,
        chainId: ncChain, role: ncRole,
        interfaces: [liveIface],
        capabilities: ncCaps,
      });
    }
    setProbing(true);
  };

  /* Step labels — no separate Node step */
  const stepLabels: Record<string, string[]> = {
    UPSTREAM: ["Type", "Upstream", "Configure"],
    URL: ["Type", "Configure"],
    JWT: ["Type", "Configure"],
    none: ["Type", "Configure"],
  };
  const steps = stepLabels[type ?? "none"] ?? ["Type", "Configure"];
  const isCredStep = !probing && (
    (type === "URL" && step === 2) ||
    (type === "JWT" && step === 2) ||
    (type === "UPSTREAM" && step === 3)
  );

  if (!open) return null;
  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={
        <div>
          <div>Add an upstream</div>
          <div style={{ fontSize: 12, fontWeight: 400, color: "var(--text-3)", marginTop: 2 }}>
            Connect an upstream node and Magma routes traffic through it automatically
          </div>
        </div>
      }
      footer={probing ? (
        <>
          <button className="gw-btn" onClick={() => { setProbing(false); setProbeReady(false); setPending(null); }}>← Back</button>
          <button className="gw-btn gw-btn--primary" disabled title={READONLY_MSG}>
            {!probeReady ? "Probing…" : "Save upstream"}
          </button>
        </>
      ) : step === 1 ? (
        <button className="gw-btn" onClick={onClose}>Cancel</button>
      ) : (
        <>
          <button className="gw-btn" onClick={() => setStep((s) => s - 1)}>← Back</button>
          {isCredStep && (
            <button className="gw-btn gw-btn--primary"
              onClick={() => (document.getElementById("__pv-submit") as HTMLButtonElement | null)?.click()}>
              Add upstream
            </button>
          )}
        </>
      )}
    >
      {/* Magma Cloud-only: on self-hosted, upstreams come from the read-only
          mounted values file — this whole add flow is a preview of the Cloud
          experience and can't persist here. */}
      <div style={{
        display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 16,
        padding: "9px 11px", borderRadius: 8, fontSize: 12,
        background: "rgba(255,168,10,0.08)", border: "1px solid rgba(255,168,10,0.22)", color: "var(--text-2)",
      }}>
        <span style={{ color: "#ffa80a", flexShrink: 0, marginTop: 1 }}>ⓘ</span>
        <span>Adding upstreams is a <strong>Magma Cloud</strong> feature. On this self-hosted deployment upstreams are defined in the read-only mounted values file — edit that file to change them.</span>
      </div>

      {/* Step indicator (SideSheet used to render this via its `steps` prop). */}
      <div className="gw-sheet__steps" style={{ marginBottom: 16 }}>
        {steps.map((s, i) => {
          const idx = i + 1, isDone = step > idx, isActive = step === idx;
          return (
            <div key={i} className={"gw-sheet__step" + (isActive ? " active" : "") + (isDone ? " done" : "")}>
              <span className="gw-sheet__step-num">{isDone ? "✓" : idx}</span>{s}
            </div>
          );
        })}
      </div>

      {probing ? (
        <ProbeStep
          catalogId={catalog?.id || pendingData?.catalogId}
          upstreamName={pendingData?.name}
          onReady={() => setProbeReady(true)}
        />
      ) : (
        <>
          {step === 1 && <Step1EntryType onPick={(t) => { setType(t); setStep(2); }} />}
          {step === 2 && type === "UPSTREAM" && <StepPickPreset existingIds={existingIds} onPick={(cat) => { setCatalog(cat); setStep(3); }} />}
          {step === 2 && type === "URL" && <StepCustomUrl chains={chains} onSubmit={submit} />}
          {step === 2 && type === "JWT" && <StepJwt catalog={null} chains={chains} onSubmit={submit} />}
          {step === 3 && type === "UPSTREAM" && catalog?.flow === "A" && <StepConfigureA catalog={catalog} onSubmit={submit} onSwitchJwt={() => setType("JWT")} />}
          {step === 3 && type === "UPSTREAM" && catalog?.flow === "B" && <StepConfigureB catalog={catalog} onSubmit={submit} onBack={() => setStep(2)} />}
          {step === 3 && type === "JWT" && catalog && <StepJwt catalog={catalog} chains={chains} onSubmit={submit} />}

          {/* Node config — only for custom URL / JWT flows (presets: backend manages chain/interface/caps) */}
          {isCredStep && type !== "UPSTREAM" && (
            <div style={{ borderTop: "1px solid var(--line)", marginTop: 18, paddingTop: 18 }}>
              <NodeConfigSection
                chainId={ncChain} setChainId={setNcChain}
                role={ncRole} setRole={setNcRole}
                iface={ncIface} setIface={setNcIface}
                caps={ncCaps} setCaps={setNcCaps}
                chains={chains} ifacesBySpec={ifacesBySpec}
              />
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
